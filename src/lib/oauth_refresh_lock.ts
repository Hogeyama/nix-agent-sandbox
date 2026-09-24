/**
 * Claude Code の OAuth 更新と同じロック。
 *
 * Claude Code は proper-lockfile を使う。ロックは空のディレクトリで、mkdir で
 * 取り、保持中は mtime を定期的に更新する。mtime が一定時間更新されていない
 * ロックは持ち主が死んだものとみなし、rmdir して取り直す。同じ形式に従う
 * ことで、ホストの Claude Code と nas が同じ refresh token を同時に使わない
 * ようにする (refresh token は使うたびに入れ替わる)。
 *
 * 保持者が止まっている間に取り直されたロックは、この保持者のものではない。
 * ディレクトリの inode か、この保持者が最後に設定した mtime が変わっていれば
 * 取り直されたとみなし (compromised)、以後は mtime を更新せず、解放時にも
 * 消さない。inode は rmdir と mkdir の直後に再利用されうるので、mtime と
 * 併せて判定する。比べる mtime は、設定した直後に stat で読んだ値である。
 * NFS など mtime を秒単位に丸めるファイルシステムでは、utimes に渡した時刻と
 * 保存される時刻が一致しない。
 */

import { createHash } from "node:crypto";
import { mkdir, realpath, rmdir, stat, utimes } from "node:fs/promises";
import * as path from "node:path";

const STALE_MS = 60_000;
const UPDATE_MS = 5_000;

export class LockContendedError extends Error {
  constructor(lockPath: string) {
    super(`lock is held by another process: ${lockPath}`);
    this.name = "LockContendedError";
  }
}

export interface HeldLock {
  release(): Promise<void>;
  /** 他のプロセスにロックを取り直されたか。 */
  isCompromised(): boolean;
}

export interface AcquireDirLockOptions {
  now?: () => number;
  staleMs?: number;
  updateMs?: number;
  /**
   * @internal ロックの mtime を設定する。テストで mtime を丸める
   * ファイルシステムを再現するために差し替える。
   */
  setMtime?: (lockPath: string, time: Date) => Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function createLockDir(
  lockPath: string,
  now: () => number,
  staleMs: number,
): Promise<void> {
  try {
    await mkdir(lockPath);
    return;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = await stat(lockPath).catch(() => null);
  if (info !== null && now() - info.mtimeMs <= staleMs) {
    throw new LockContendedError(lockPath);
  }
  try {
    await rmdir(lockPath);
  } catch (error) {
    const code = errorCode(error);
    // 他のプロセスが先に消した (ENOENT) なら取り直しに進む。空でない
    // ディレクトリ (ENOTEMPTY) は proper-lockfile のロックではないので
    // 奪わない。それ以外 (EACCES 等) はロックの状態と無関係なので、
    // LockContendedError にせずそのまま投げる。
    if (code === "ENOTEMPTY") throw new LockContendedError(lockPath);
    if (code !== "ENOENT") throw error;
  }
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new LockContendedError(lockPath);
    throw error;
  }
}

export async function acquireDirLock(
  lockPath: string,
  options: AcquireDirLockOptions = {},
): Promise<HeldLock> {
  const now = options.now ?? Date.now;
  const setMtime =
    options.setMtime ?? ((p: string, t: Date) => utimes(p, t, t));
  await createLockDir(lockPath, now, options.staleMs ?? STALE_MS);
  const created = await stat(lockPath);
  const ino = created.ino;
  let lastMtimeMs = created.mtimeMs;
  let compromised = false;
  let pending: Promise<void> = Promise.resolve();

  // ENOENT は「取り直された」、それ以外の失敗は呼び出し元へ投げる。
  const stillOwned = async (): Promise<boolean> => {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    return info.ino === ino && info.mtimeMs === lastMtimeMs;
  };

  const markCompromised = () => {
    compromised = true;
    clearInterval(timer);
  };

  const refresh = async (): Promise<void> => {
    if (compromised) return;
    let owned: boolean;
    try {
      owned = await stillOwned();
    } catch {
      // 一時的な失敗は次の回に持ち越す。
      return;
    }
    if (!owned) {
      markCompromised();
      return;
    }
    const t = new Date(now());
    try {
      await setMtime(lockPath, t);
    } catch {
      // 失敗した場合 mtime は変わっていないので、記録した値のまま次の回に比べる。
      return;
    }
    try {
      lastMtimeMs = (await stat(lockPath)).mtimeMs;
    } catch {
      // 保存された値を読めなければ、設定した時刻で代用する。
      lastMtimeMs = t.getTime();
    }
  };

  const timer = setInterval(() => {
    pending = pending.then(refresh);
  }, options.updateMs ?? UPDATE_MS);
  timer.unref?.();

  return {
    isCompromised: () => compromised,
    release: async () => {
      clearInterval(timer);
      await pending;
      if (compromised) return;
      if (await stillOwned()) {
        await rmdir(lockPath);
      } else {
        compromised = true;
      }
    },
  };
}

/** Claude Code が OAuth 更新時に取る2つのロック (現行と旧形式) を両方取る。 */
export async function acquireClaudeRefreshLock(
  claudeDir: string,
): Promise<HeldLock> {
  const current = await acquireDirLock(
    path.join(claudeDir, ".oauth_refresh.lock"),
  );
  let legacy: HeldLock;
  try {
    const resolved = await realpath(claudeDir).catch(() => claudeDir);
    legacy = await acquireDirLock(`${resolved}.lock`);
  } catch (error) {
    await current.release().catch(() => {});
    throw error;
  }
  return {
    isCompromised: () => current.isCompromised() || legacy.isCompromised(),
    release: async () => {
      try {
        await legacy.release();
      } finally {
        await current.release();
      }
    },
  };
}

/**
 * Codex の OAuth 更新を、nas のセッションどうしで排他するロック。
 *
 * Codex 自身はファイルのロックを使わない (同じプロセスの中でだけ排他する)
 * ので、ホストの Codex とは共有できない。ロックは container から read-write
 * で見える `~/.codex` には置かない。container がロックを握ったまま離さない
 * ことで、ホストの更新を止められてしまうためである。
 */
export async function acquireCodexRefreshLock(
  codexDir: string,
  stateHome: string,
  options: AcquireDirLockOptions = {},
): Promise<HeldLock> {
  const resolved = await realpath(codexDir).catch(() => codexDir);
  const key = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  const locksDir = path.join(stateHome, "nas", "locks");
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  return acquireDirLock(
    path.join(locksDir, `codex-oauth-${key}.lock`),
    options,
  );
}
