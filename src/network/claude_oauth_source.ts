/**
 * Claude の OAuth credential の形式と、ホストの Claude Code と同じロック・
 * 書き戻しで更新する live deps を定義する。更新の流れは host_oauth_source.ts
 * にある。
 */

import { randomUUID } from "node:crypto";
import { open as openFile, readFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import {
  applyRefreshedTokens,
  type ClaudeOAuthTokens,
  claudeCredentialsReadError,
  parseClaudeOAuthTokens,
  type RefreshedClaudeTokens,
} from "../agents/claude_oauth.ts";
import { acquireClaudeRefreshLock } from "../lib/oauth_refresh_lock.ts";
import { logWarn } from "../log.ts";
import {
  HostOAuthCredentialSource,
  type HostOAuthFlavor,
  type HostOAuthSourceDeps,
  readInitialTokens,
} from "./host_oauth_source.ts";

export const CLAUDE_OAUTH_TOKEN_URL =
  "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const REFRESH_TIMEOUT_MS = 30_000;

export interface AgentCredentialSource {
  /** 上流へ送る access token。同期的に返す。 */
  current(): string;
  /** 進行中の refresh があれば、それの完了を待ってから返す。 */
  close(): Promise<void>;
}

export interface ClaudeRefreshRequest {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export type ClaudeOAuthSourceDeps = HostOAuthSourceDeps<
  ClaudeRefreshRequest,
  RefreshedClaudeTokens
>;

const CLAUDE_FLAVOR: HostOAuthFlavor<
  ClaudeOAuthTokens,
  ClaudeRefreshRequest,
  RefreshedClaudeTokens
> = {
  label: "Claude",
  loginCommand: "claude /login",
  refreshLeadMs: 5 * 60_000,
  parse: parseClaudeOAuthTokens,
  readError: claudeCredentialsReadError,
  refreshRequest: (tokens) => ({
    refreshToken: tokens.refreshToken,
    clientId: tokens.clientId ?? CLAUDE_CODE_CLIENT_ID,
    scopes: tokens.scopes,
  }),
  merge: (tokens, refreshed) => ({
    ...tokens,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  }),
  apply: applyRefreshedTokens,
};

export class ClaudeOAuthCredentialSource
  extends HostOAuthCredentialSource<
    ClaudeOAuthTokens,
    ClaudeRefreshRequest,
    RefreshedClaudeTokens
  >
  implements AgentCredentialSource
{
  static async open(
    deps: ClaudeOAuthSourceDeps,
  ): Promise<ClaudeOAuthCredentialSource> {
    const tokens = await readInitialTokens(CLAUDE_FLAVOR, deps);
    const source = new ClaudeOAuthCredentialSource(CLAUDE_FLAVOR, deps, tokens);
    source.start();
    return source;
  }

  current(): string {
    return this.currentTokens().accessToken;
  }
}

// ---------------------------------------------------------------------------
// Live deps: 各メソッドは I/O を1つだけ行う。
// ---------------------------------------------------------------------------

/**
 * 同じディレクトリの一時ファイルに全文を書いて fsync し、rename で置き換え、
 * 最後にディレクトリを fsync する。
 *
 * rename なので、読む側が書きかけのファイルを見ることはない。ホストの
 * Claude Code も同じ方法でこのファイルを置き換えるので、このファイルを
 * bind mount しているセッションへの影響は、ホストの Claude Code が更新した
 * ときと変わらない。ディレクトリを fsync しないと、電源断のあとに rename が
 * 失われてファイルが古い内容に戻ることがある。古い内容の refresh token は
 * refresh で既に無効になっているので、ホストはログアウトした状態になる。
 * rename までに失敗したら一時ファイルを消してからエラーを投げる。
 */
async function replaceFileAtomically(
  dir: string,
  target: string,
  text: string,
): Promise<void> {
  const temp = path.join(
    dir,
    `.${path.basename(target)}.nas-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    const handle = await openFile(temp, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(dir);
}

// ディレクトリの fsync を受け付けないファイルシステムが返すエラー。
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "EISDIR", "ENOTSUP"]);

async function syncDirectory(dir: string): Promise<void> {
  const handle = await openFile(dir, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !DIRECTORY_SYNC_UNSUPPORTED.has(code)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export function liveClaudeOAuthSourceDeps(
  hostHome: string,
): ClaudeOAuthSourceDeps {
  const claudeDir = path.join(hostHome, ".claude");
  const credentialsPath = path.join(claudeDir, ".credentials.json");
  return {
    readCredentials: () => readFile(credentialsPath, "utf8"),
    writeCredentials: (text) =>
      replaceFileAtomically(claudeDir, credentialsPath, text),
    acquireLock: () => acquireClaudeRefreshLock(claudeDir),
    refresh: postClaudeTokenRefresh,
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

async function postClaudeTokenRefresh(
  request: ClaudeRefreshRequest,
): Promise<RefreshedClaudeTokens> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: request.refreshToken,
        client_id: request.clientId,
        scope: request.scopes.join(" "),
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`token endpoint returned HTTP ${res.status}`);
    }
    return parseRefreshResponse(await res.json(), request.refreshToken);
  } finally {
    clearTimeout(timer);
  }
}

/** @internal Exported only for the colocated test file. */
export function parseRefreshResponse(
  body: unknown,
  previousRefreshToken: string,
  now: number = Date.now(),
): RefreshedClaudeTokens {
  const data = (body ?? {}) as Record<string, unknown>;
  if (
    typeof data.access_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new Error("token endpoint returned an unexpected body");
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : previousRefreshToken,
    expiresAt: now + data.expires_in * 1000,
    ...(typeof data.refresh_token_expires_in === "number"
      ? { refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000 }
      : {}),
  };
}
