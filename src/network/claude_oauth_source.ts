/**
 * ホスト側で Claude の OAuth credential を保持し、期限前に更新する。
 *
 * container には本物の token を渡さず、proxy が許可した request にだけ
 * `current()` の値を注入する。更新はホストの Claude Code と同じロックの下で
 * 行い、ロックを取った後にファイルを読み直して、他のプロセスが既に更新して
 * いればその値を採用する。
 */

import { randomUUID } from "node:crypto";
import { open as openFile, readFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import {
  applyRefreshedTokens,
  type ClaudeOAuthTokens,
  ClaudeOAuthUnavailableError,
  parseClaudeOAuthTokens,
  type RefreshedClaudeTokens,
} from "../agents/claude_oauth.ts";
import {
  acquireClaudeRefreshLock,
  type HeldLock,
  LockContendedError,
} from "../lib/oauth_refresh_lock.ts";
import { logWarn } from "../log.ts";

export const CLAUDE_OAUTH_TOKEN_URL =
  "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const REFRESH_LEAD_MS = 5 * 60_000;
const RETRY_DELAY_MS = 30_000;
const LOCK_ATTEMPTS = 5;
const REFRESH_TIMEOUT_MS = 30_000;
// setTimeout の delay は32bit 符号付き整数で扱われ、超えると即時発火する
// (TimeoutOverflowWarning)。有効期限がこれより先の token では、この値で
// 予約して発火のたびに期限までまだ間があるか確認し、無ければ延長予約する。
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * open() での初回読み込みだけが対象。credentials ファイルどころか
 * `~/.claude` すらまだ無いホストは珍しくないので、その ENOENT は
 * ClaudeOAuthUnavailableError に読み替え、`claude /login` の案内を出す。
 * それ以外のエラー (権限など) はそのまま投げ、refresh 経路のファイル読み
 * (refreshUnderLock/acquireLockOrAdopt) には影響しない。
 */
async function readCredentialsForOpen(
  deps: ClaudeOAuthSourceDeps,
): Promise<string> {
  try {
    return await deps.readCredentials();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ClaudeOAuthUnavailableError("no credentials file");
    }
    throw error;
  }
}

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

export interface ClaudeOAuthSourceDeps {
  readCredentials(): Promise<string>;
  /** credentials file の内容を text で置き換える。 */
  writeCredentials(text: string): Promise<void>;
  acquireLock(): Promise<HeldLock>;
  refresh(request: ClaudeRefreshRequest): Promise<RefreshedClaudeTokens>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 戻り値は予約の取り消し。 */
  schedule(fn: () => void, delayMs: number): () => void;
  log(message: string): void;
}

export class ClaudeOAuthCredentialSource implements AgentCredentialSource {
  private tokens: ClaudeOAuthTokens;
  private cancelScheduled: (() => void) | null = null;
  private closed = false;
  /**
   * refresh には成功したがファイルへの書き戻しに失敗した分の tokens。
   * 次の refreshUnderLock はまずこれの書き戻しだけをやり直す。
   */
  private pendingWriteBack: RefreshedClaudeTokens | null = null;
  /** 進行中の refreshNow() があれば、その完了を close() が待てるように保持する。 */
  private inFlightRefresh: Promise<void> | null = null;

  private constructor(
    private readonly deps: ClaudeOAuthSourceDeps,
    tokens: ClaudeOAuthTokens,
  ) {
    this.tokens = tokens;
  }

  static async open(
    deps: ClaudeOAuthSourceDeps,
  ): Promise<ClaudeOAuthCredentialSource> {
    const tokens = parseClaudeOAuthTokens(await readCredentialsForOpen(deps));
    const source = new ClaudeOAuthCredentialSource(deps, tokens);
    source.scheduleBeforeExpiry();
    return source;
  }

  current(): string {
    return this.tokens.accessToken;
  }

  /**
   * 以後の予約を止める。進行中の refresh があれば、呼び出し元が安全に
   * 終了できるようその完了を待ってから返す (refresh 内の失敗は
   * refreshNow が自分で処理済みなので、ここでは投げ直さない)。それでも
   * pendingWriteBack が残っていれば、最後にもう一度だけファイルへの反映を
   * 試みる。メモリ上には既に有効な token があるが、ファイルに残せなければ
   * このプロセスが終了した後は誰もそれを使えない。
   */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    if (this.inFlightRefresh !== null) {
      await this.inFlightRefresh;
    }
    if (this.pendingWriteBack !== null) {
      try {
        await this.refreshUnderLock();
      } catch (error) {
        this.deps.log(
          `[nas] could not save the refreshed Claude OAuth credentials to the host file before closing; run "claude /login" on the host to restore them: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * 更新処理を1回行う。失敗は投げず、やり直しを予約する。既に進行中の
   * refresh があれば新たに始めず、その完了を返す。close() が始まった後は
   * 何もしない (close() 自身の最後の書き戻しは refreshUnderLock を直接
   * 呼ぶので、この early return の影響を受けない)。
   */
  refreshNow(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.inFlightRefresh !== null) {
      return this.inFlightRefresh;
    }
    const run = this.runRefreshNow().finally(() => {
      if (this.inFlightRefresh === run) {
        this.inFlightRefresh = null;
      }
    });
    this.inFlightRefresh = run;
    return run;
  }

  private async runRefreshNow(): Promise<void> {
    try {
      await this.refreshUnderLock();
      this.scheduleBeforeExpiry();
    } catch (error) {
      this.deps.log(
        `[nas] Claude OAuth refresh failed; retrying in ${RETRY_DELAY_MS / 1000}s: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleIn(RETRY_DELAY_MS);
    }
  }

  private async refreshUnderLock(): Promise<void> {
    const lock = await this.acquireLockOrAdopt();
    if (lock === null) return;
    try {
      // このロックを保持している間の credentials は1回だけ読む。
      const text = await this.deps.readCredentials();
      // 前回 refresh には成功したが書き戻しに失敗した分が残っていれば、
      // 新たな refresh は行わずまずそれをファイルへ反映する。ここで
      // 「他プロセスが既に更新したか」の比較を先にやると、書き戻しに
      // 失敗しただけのファイル上の古い (既に死んだ) token を誤って
      // 採用してしまう。
      if (this.pendingWriteBack !== null) {
        await this.persistPendingWriteBack(text);
        return;
      }
      const onDisk = parseClaudeOAuthTokens(text);
      if (onDisk.accessToken !== this.tokens.accessToken) {
        this.tokens = onDisk;
        return;
      }
      const refreshed = await this.deps.refresh({
        refreshToken: onDisk.refreshToken,
        clientId: onDisk.clientId ?? CLAUDE_CODE_CLIENT_ID,
        scopes: onDisk.scopes,
      });
      // refresh はここで成功済み。この refresh token は使い切りで、サーバー
      // 側は既に新しいものへ入れ替えている。lock がこの後奪われていても、
      // 奪った側がこの refresh token で有効な token を得ることはあり得ない
      // ので、書き戻せなくても捨てるわけにはいかない。書き戻しより先に
      // メモリ上の tokens をこれへ差し替え、書き戻しは pendingWriteBack
      // として記録して次回以降やり直す。
      this.tokens = {
        ...onDisk,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      this.pendingWriteBack = refreshed;
      if (lock.isCompromised()) {
        this.deps.log(
          "[nas] Claude OAuth refresh lock was compromised (taken over by another process) during refresh; writing back the newly refreshed tokens anyway",
        );
      }
      await this.persistPendingWriteBack(text);
    } finally {
      try {
        await lock.release();
      } catch (error) {
        this.deps.log(
          `[nas] failed to release the Claude OAuth refresh lock: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * pendingWriteBack をファイルへ反映する。失敗しても pendingWriteBack は
   * 保持したままにし、呼び出し元へ投げて通常の失敗経路 (30秒後の再試行) に
   * 委ねる。
   */
  private async persistPendingWriteBack(text: string): Promise<void> {
    const pending = this.pendingWriteBack;
    if (pending === null) return;
    try {
      const next = applyRefreshedTokens(text, pending);
      await this.deps.writeCredentials(next);
      // 実際に書き込んだ内容からメモリ上の tokens を作り直し、ファイルと
      // 食い違わないようにする。
      this.tokens = parseClaudeOAuthTokens(next);
      this.pendingWriteBack = null;
    } catch (error) {
      this.deps.log(
        `[nas] failed to write back refreshed Claude OAuth tokens; already serving them from memory and will retry the write: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * ロックを取る。取れない間は読み直し、他のプロセスが更新を終えていれば
   * その値を採用して null を返す。ただし pendingWriteBack がある間は、この
   * 適応を行わない: ファイル上の token はまさにこれから上書きしようとして
   * いる、既に死んだ古い token であり、メモリ上の (既に refresh 済みの)
   * tokens より「新しい」わけではない。ここで比較すると死んだ token へ
   * 逆戻りしてしまうので、この場合は普通にロックの取り直しだけを行う。
   */
  private async acquireLockOrAdopt(): Promise<HeldLock | null> {
    for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
      try {
        return await this.deps.acquireLock();
      } catch (error) {
        if (!(error instanceof LockContendedError)) throw error;
        if (this.pendingWriteBack === null) {
          const onDisk = parseClaudeOAuthTokens(
            await this.deps.readCredentials(),
          );
          if (onDisk.accessToken !== this.tokens.accessToken) {
            this.tokens = onDisk;
            return null;
          }
        }
        if (attempt < LOCK_ATTEMPTS) {
          await this.deps.sleep(1000 + Math.random() * 1000);
        }
      }
    }
    throw new Error("the refresh lock stayed held by another process");
  }

  private scheduleBeforeExpiry(): void {
    this.scheduleIn(
      Math.max(0, this.tokens.expiresAt - REFRESH_LEAD_MS - this.deps.now()),
    );
  }

  private scheduleIn(delayMs: number): void {
    if (this.closed) return;
    this.cancelScheduled?.();
    const cappedDelayMs = Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS);
    this.cancelScheduled = this.deps.schedule(() => {
      this.onScheduledFire();
    }, cappedDelayMs);
  }

  /**
   * 予約が発火した際の入口。MAX_TIMER_DELAY_MS で切り詰めた予約は、期限の
   * 5分前より早く発火しうるので、その場合は更新せず予約を延長するだけに
   * する。書き戻し待ちがある場合は期限に関わらず必ず進める。
   */
  private onScheduledFire(): void {
    if (
      this.pendingWriteBack === null &&
      this.deps.now() < this.tokens.expiresAt - REFRESH_LEAD_MS
    ) {
      this.scheduleBeforeExpiry();
      return;
    }
    void this.refreshNow();
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
