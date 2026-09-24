/**
 * ホスト側でエージェントの OAuth credential を保持し、期限前に更新する。
 *
 * container には本物の token を渡さず、proxy が許可した request にだけ
 * 保持している値を注入する。更新はロックの下で行い、ロックを取った後に
 * ファイルを読み直して、他のプロセスが既に更新していればその値を採用する。
 * ファイルの形式、refresh の request、更新を始める時期といったエージェント
 * ごとの違いは HostOAuthFlavor にまとめる。
 */

import {
  type HeldLock,
  LockContendedError,
} from "../lib/oauth_refresh_lock.ts";

const RETRY_DELAY_MS = 30_000;
const LOCK_ATTEMPTS = 5;
// setTimeout の delay は32bit 符号付き整数で扱われ、超えると即時発火する
// (TimeoutOverflowWarning)。有効期限がこれより先の token では、この値で
// 予約して発火のたびに期限までまだ間があるか確認し、無ければ延長予約する。
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface HostOAuthTokens {
  readonly accessToken: string;
  /** access token の期限 (ms)。 */
  readonly expiresAt: number;
}

export interface HostOAuthFlavor<T extends HostOAuthTokens, Req, R> {
  /** ログに出すエージェント名。 */
  readonly label: string;
  /** ホストで再ログインするコマンド。 */
  readonly loginCommand: string;
  /** 期限の何ミリ秒前に更新を始めるか。 */
  readonly refreshLeadMs: number;
  parse(text: string): T;
  /** open() での初回の読み取りの失敗を、利用者に見せるエラーへ変換する。 */
  readError(error: unknown): unknown;
  refreshRequest(tokens: T): Req;
  /** refresh の結果を、書き戻す前のメモリ上の tokens に反映する。 */
  merge(tokens: T, refreshed: R): T;
  /** refresh の結果をファイルの内容に反映した text を返す。 */
  apply(text: string, refreshed: R): string;
}

export interface HostOAuthSourceDeps<Req, R> {
  readCredentials(): Promise<string>;
  /** credentials file の内容を text で置き換える。 */
  writeCredentials(text: string): Promise<void>;
  acquireLock(): Promise<HeldLock>;
  refresh(request: Req): Promise<R>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 戻り値は予約の取り消し。 */
  schedule(fn: () => void, delayMs: number): () => void;
  log(message: string): void;
}

/**
 * open() での初回読み込みだけが対象。credentials ファイルが無いホストは
 * 珍しくないので、flavor.readError で再ログインを案内するエラーにする。
 * refresh 経路のファイル読み (refreshUnderLock/acquireLockOrAdopt) はこの
 * 変換を通さない。
 */
export async function readInitialTokens<T extends HostOAuthTokens, Req, R>(
  flavor: HostOAuthFlavor<T, Req, R>,
  deps: HostOAuthSourceDeps<Req, R>,
): Promise<T> {
  let text: string;
  try {
    text = await deps.readCredentials();
  } catch (error) {
    throw flavor.readError(error);
  }
  return flavor.parse(text);
}

export class HostOAuthCredentialSource<T extends HostOAuthTokens, Req, R> {
  private tokens: T;
  private cancelScheduled: (() => void) | null = null;
  private closed = false;
  /**
   * refresh には成功したがファイルへの書き戻しに失敗した分。次の
   * refreshUnderLock はまずこれの書き戻しだけをやり直す。
   */
  private pendingWriteBack: R | null = null;
  /** 進行中の refreshNow() があれば、その完了を close() が待てるように保持する。 */
  private inFlightRefresh: Promise<void> | null = null;

  protected constructor(
    private readonly flavor: HostOAuthFlavor<T, Req, R>,
    private readonly deps: HostOAuthSourceDeps<Req, R>,
    tokens: T,
  ) {
    this.tokens = tokens;
  }

  /** 期限前の更新を予約する。open の最後に1回呼ぶ。 */
  protected start(): void {
    this.scheduleBeforeExpiry();
  }

  /**
   * 以後の更新と書き戻しをやめる。ファイルが別のログインのものに置き換わった
   * ときに使う。書き戻し待ちの token は、置き換わった後のファイルへ書くと
   * 新しいログインを壊すので捨てる。
   */
  protected abandon(): void {
    this.closed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.pendingWriteBack = null;
  }

  currentTokens(): T {
    return this.tokens;
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
          `[nas] could not save the refreshed ${this.flavor.label} OAuth credentials to the host file before closing; run "${this.flavor.loginCommand}" on the host to restore them: ${error instanceof Error ? error.message : String(error)}`,
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
        `[nas] ${this.flavor.label} OAuth refresh failed; retrying in ${RETRY_DELAY_MS / 1000}s: ${error instanceof Error ? error.message : String(error)}`,
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
      const onDisk = this.flavor.parse(text);
      if (onDisk.accessToken !== this.tokens.accessToken) {
        this.tokens = onDisk;
        return;
      }
      const refreshed = await this.deps.refresh(
        this.flavor.refreshRequest(onDisk),
      );
      // refresh はここで成功済み。この refresh token は使い切りで、サーバー
      // 側は既に新しいものへ入れ替えている。lock がこの後奪われていても、
      // 奪った側がこの refresh token で有効な token を得ることはあり得ない
      // ので、書き戻せなくても捨てるわけにはいかない。書き戻しより先に
      // メモリ上の tokens をこれへ差し替え、書き戻しは pendingWriteBack
      // として記録して次回以降やり直す。
      this.tokens = this.flavor.merge(onDisk, refreshed);
      this.pendingWriteBack = refreshed;
      if (lock.isCompromised()) {
        this.deps.log(
          `[nas] ${this.flavor.label} OAuth refresh lock was compromised (taken over by another process) during refresh; writing back the newly refreshed tokens anyway`,
        );
      }
      await this.persistPendingWriteBack(text);
    } finally {
      try {
        await lock.release();
      } catch (error) {
        this.deps.log(
          `[nas] failed to release the ${this.flavor.label} OAuth refresh lock: ${error instanceof Error ? error.message : String(error)}`,
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
      const next = this.flavor.apply(text, pending);
      await this.deps.writeCredentials(next);
      // 実際に書き込んだ内容からメモリ上の tokens を作り直し、ファイルと
      // 食い違わないようにする。
      this.tokens = this.flavor.parse(next);
      this.pendingWriteBack = null;
    } catch (error) {
      this.deps.log(
        `[nas] failed to write back refreshed ${this.flavor.label} OAuth tokens; already serving them from memory and will retry the write: ${error instanceof Error ? error.message : String(error)}`,
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
          const onDisk = this.flavor.parse(await this.deps.readCredentials());
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
      Math.max(
        0,
        this.tokens.expiresAt - this.flavor.refreshLeadMs - this.deps.now(),
      ),
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
   * refreshLeadMs 前より早く発火しうるので、その場合は更新せず予約を延長する
   * だけにする。書き戻し待ちがある場合は期限に関わらず必ず進める。
   */
  private onScheduledFire(): void {
    if (
      this.pendingWriteBack === null &&
      this.deps.now() < this.tokens.expiresAt - this.flavor.refreshLeadMs
    ) {
      this.scheduleBeforeExpiry();
      return;
    }
    void this.refreshNow();
  }
}
