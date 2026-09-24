/**
 * ホスト側で Codex の ChatGPT OAuth credential を保持し、期限前に更新する。
 *
 * 更新の流れは host_oauth_source.ts にある。ここには Codex の形式と、
 * ホストの `~/.codex/auth.json` を読み書きする live deps を置く。
 *
 * 書き戻しは rename せず、同じファイルへの上書きで行う。container には
 * ダミーの auth.json をホストの auth.json の上に bind mount しているので、
 * rename で inode が変わるとその mount が外れ、container から本物が見える。
 * ホストの Codex 自身も同じファイルへの上書きで保存している。
 */

import { type FileHandle, open as openFile, readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  applyRefreshedCodexTokens,
  type CodexOAuthTokens,
  codexCredentialsReadError,
  mergeRefreshedCodexTokens,
  parseCodexOAuthTokens,
  type RefreshedCodexTokens,
} from "../agents/codex_oauth.ts";
import { acquireCodexRefreshLock } from "../lib/oauth_refresh_lock.ts";
import { logWarn } from "../log.ts";
import {
  HostOAuthCredentialSource,
  type HostOAuthFlavor,
  type HostOAuthSourceDeps,
  readInitialTokens,
} from "./host_oauth_source.ts";

export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI の OAuth client id。ホストの access token の client_id claim が
// あればそちらを使う。
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const REFRESH_TIMEOUT_MS = 30_000;

export interface CodexRefreshRequest {
  readonly refreshToken: string;
  readonly clientId: string;
}

export type CodexOAuthSourceDeps = HostOAuthSourceDeps<
  CodexRefreshRequest,
  RefreshedCodexTokens
>;

/** broker が注入に使う値。 */
export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string | null;
}

const CODEX_FLAVOR: HostOAuthFlavor<
  CodexOAuthTokens,
  CodexRefreshRequest,
  RefreshedCodexTokens
> = {
  label: "Codex",
  loginCommand: "codex login",
  // ホストの Codex は期限の5分前に更新する。それより遅らせることで、ホストの
  // Codex が動いていれば先に更新し、こちらは読み直してその値を採用する。
  // refresh token は使うたびに入れ替わり、ホストの Codex とはロックを共有
  // できないので、同時に更新すると片方が失敗する。
  refreshLeadMs: 2 * 60_000,
  parse: parseCodexOAuthTokens,
  readError: codexCredentialsReadError,
  refreshRequest: (tokens) => ({
    refreshToken: tokens.refreshToken,
    clientId: tokens.clientId ?? CODEX_CLIENT_ID,
  }),
  merge: mergeRefreshedCodexTokens,
  apply: applyRefreshedCodexTokens,
};

export class CodexOAuthCredentialSource extends HostOAuthCredentialSource<
  CodexOAuthTokens,
  CodexRefreshRequest,
  RefreshedCodexTokens
> {
  private revoked = false;

  static async open(
    deps: CodexOAuthSourceDeps,
  ): Promise<CodexOAuthCredentialSource> {
    const tokens = await readInitialTokens(CODEX_FLAVOR, deps);
    const source = new CodexOAuthCredentialSource(CODEX_FLAVOR, deps, tokens);
    source.start();
    return source;
  }

  /** 注入に使う credential。revoke の後は null。 */
  current(): CodexCredential | null {
    if (this.revoked) return null;
    const tokens = this.currentTokens();
    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  /**
   * ホストの auth.json が消えるか置き換わったときに呼ぶ。以後は注入せず、
   * 更新も書き戻しもしない。置き換わった後のファイルは別のログインのもので
   * ありうる。
   */
  revoke(): void {
    this.revoked = true;
    this.abandon();
  }
}

// ---------------------------------------------------------------------------
// Live deps: 各メソッドは I/O を1つだけ行う。
// ---------------------------------------------------------------------------

/** overwriteFileInPlace が使う、開いたファイルの操作。 */
export type InPlaceFileHandle = Pick<
  FileHandle,
  "truncate" | "writeFile" | "sync" | "close"
>;

/**
 * 同じ inode のまま内容を置き換える。ファイルが無ければ作らずに失敗する。
 * 書いている途中に読んだプロセスは書きかけの内容を見うるが、ホストの Codex
 * 自身も同じ方法で保存しているので、読み手の状況は変わらない。
 */
export async function overwriteFileInPlace(
  file: string,
  text: string,
  open: (file: string, flags: "r+") => Promise<InPlaceFileHandle> = openFile,
): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.truncate(0);
    // write は1回で全部を書くとは限らない。writeFile は書き終えるまで繰り返す。
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** nas がホスト側の状態を置くディレクトリの親 (XDG_STATE_HOME)。 */
export function resolveNasStateHome(
  hostHome: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_STATE_HOME;
  return xdg !== undefined && xdg !== ""
    ? xdg
    : path.join(hostHome, ".local", "state");
}

export function liveCodexOAuthSourceDeps(
  hostHome: string,
  stateHome: string,
): CodexOAuthSourceDeps {
  const codexDir = path.join(hostHome, ".codex");
  const authPath = path.join(codexDir, "auth.json");
  return {
    readCredentials: () => readFile(authPath, "utf8"),
    writeCredentials: (text) => overwriteFileInPlace(authPath, text),
    acquireLock: () => acquireCodexRefreshLock(codexDir, stateHome),
    refresh: postCodexTokenRefresh,
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    schedule: (fn, delayMs) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    log: logWarn,
  };
}

async function postCodexTokenRefresh(
  request: CodexRefreshRequest,
): Promise<RefreshedCodexTokens> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: request.clientId,
        grant_type: "refresh_token",
        refresh_token: request.refreshToken,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`token endpoint returned HTTP ${res.status}`);
    }
    return parseCodexRefreshResponse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** @internal Exported only for the colocated test file. */
export function parseCodexRefreshResponse(
  body: unknown,
  now: number = Date.now(),
): RefreshedCodexTokens {
  const data = (body ?? {}) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || data.access_token === "") {
    throw new Error("token endpoint returned an unexpected body");
  }
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" && data.refresh_token !== ""
      ? { refreshToken: data.refresh_token }
      : {}),
    ...(typeof data.id_token === "string" && data.id_token !== ""
      ? { idToken: data.id_token }
      : {}),
    refreshedAt: now,
  };
}
