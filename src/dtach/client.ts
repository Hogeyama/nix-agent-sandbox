/**
 * dtach CLI ラッパー
 *
 * dtach はソケットファイルベースのセッション管理ツール。
 * tmux と違い prefix キーの衝突やヘッダの二重表示が起きない。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import * as path from "node:path";
import { runInteractiveCommand } from "../docker/client.ts";
import { defaultRuntimeDir, safeRemove } from "../lib/fs_utils.ts";

/** dtach セッション情報 */
export interface DtachSessionInfo {
  name: string;
  socketPath: string;
  createdAt: number;
}

const SOCKET_FILE_SUFFIX = ".sock";
const SOCKET_CONNECT_TIMEOUT_MS = 200;

/** ソケットディレクトリ */
export function getSocketDir(runtimeDir?: string): string {
  return runtimeDir ?? defaultRuntimeDir("dtach");
}

/** セッションID からソケットパスを得る */
export function socketPathFor(sessionId: string, runtimeDir?: string): string {
  return path.join(
    getSocketDir(runtimeDir),
    `${sessionId}${SOCKET_FILE_SUFFIX}`,
  );
}

/** dtach が利用可能か確認 */
export async function dtachIsAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["dtach", "--help"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    // dtach --help はコマンドが見つかれば何かしら出力して終了する
    return true;
  } catch {
    return false;
  }
}

/** dtach セッションを新規作成（デタッチ状態） */
export async function dtachNewSession(
  socketPath: string,
  shellCommand: string,
  options?: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<void> {
  // ソケットディレクトリを作成
  const dir = path.dirname(socketPath);
  await Bun.spawn(["mkdir", "-p", dir], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  const proc = Bun.spawn(
    ["dtach", "-n", socketPath, "-z", "/bin/sh", "-c", shellCommand],
    {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.cwd,
      env: options?.env,
    },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `dtach new session failed (exit ${code}): ${stderr.trim()}`,
    );
  }
}

/** dtach セッションにアタッチ（stdin/stdout inherit） */
export async function dtachAttach(
  socketPath: string,
  detachKey?: string,
): Promise<void> {
  const args = ["-a", socketPath];
  if (detachKey) {
    args.push("-e", detachKey);
  }
  await runInteractiveCommand("dtach", args, {
    errorLabel: "dtach attach",
  });
}

/** ソケットに実接続できるか確認する（stale socket を弾く） */
export async function probeDtachSocket(socketPath: string): Promise<boolean> {
  try {
    const s = await stat(socketPath);
    if (!s.isSocket()) return false;
  } catch {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
      resolve(ok);
    };
    const onConnect = () => finish(true);
    const onError = () => finish(false);

    socket.once("connect", onConnect);
    socket.once("error", onError);
    timer = setTimeout(() => finish(false), SOCKET_CONNECT_TIMEOUT_MS);
  });
}

/** stale な dtach socket を掃除する */
export async function gcDtachRuntime(runtimeDir?: string): Promise<string[]> {
  const dir = getSocketDir(runtimeDir);
  try {
    const removed: string[] = [];
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(SOCKET_FILE_SUFFIX)) continue;
      const fullPath = path.join(dir, entry);
      if (await probeDtachSocket(fullPath)) continue;
      await safeRemove(fullPath);
      removed.push(entry.slice(0, -SOCKET_FILE_SUFFIX.length));
    }
    return removed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** dtach セッション（ソケット）が存在するか確認 */
export async function dtachHasSession(socketPath: string): Promise<boolean> {
  const live = await probeDtachSocket(socketPath);
  if (!live) {
    await safeRemove(socketPath);
  }
  return live;
}

/** dtach セッション一覧を取得（ソケットディレクトリをスキャン） */
export async function dtachListSessions(
  runtimeDir?: string,
): Promise<DtachSessionInfo[]> {
  const dir = getSocketDir(runtimeDir);
  await gcDtachRuntime(runtimeDir);
  try {
    const entries = await readdir(dir);
    const sessions: DtachSessionInfo[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(SOCKET_FILE_SUFFIX)) continue;
      const fullPath = path.join(dir, entry);
      try {
        if (!(await probeDtachSocket(fullPath))) {
          await safeRemove(fullPath);
          continue;
        }
        const s = await stat(fullPath);
        if (!s.isSocket()) {
          await safeRemove(fullPath);
          continue;
        }
        const name = entry.slice(0, -SOCKET_FILE_SUFFIX.length);
        sessions.push({
          name,
          socketPath: fullPath,
          createdAt: Math.floor(s.ctimeMs / 1000),
        });
      } catch {
        // ソケットが消えた等は無視
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

/**
 * ソケットにアタッチしている dtach クライアントプロセスを列挙する。
 *
 * nas サーバ自身は dtach プロセスとしてではなく Unix ソケットへ直接接続する
 * ため、ここには含まれない。
 */
async function findDtachClientPids(socketPath: string): Promise<number[]> {
  const self = process.pid;
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isFinite(pid) || pid === self) continue;
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`);
      const parts = raw
        .toString("utf8")
        .split("\0")
        .filter((s) => s.length > 0);
      if (parts.length === 0) continue;
      const exe = parts[0].split("/").pop();
      if (exe !== "dtach") continue;
      if (!parts.includes(socketPath)) continue;
      // master は `-n` / `-N` / `-c` で起動するため除外し、
      // アタッチクライアント (`-a` / `-A`) のみを対象にする。
      // 除外し忘れるとソケットを持っている master を殺してセッションごと落ちる。
      const isAttacher = parts.includes("-a") || parts.includes("-A");
      if (!isAttacher) continue;
      pids.push(pid);
    } catch {
      // プロセス消滅・権限不足などは無視
    }
  }
  return pids;
}

/**
 * 指定ソケットに張り付いている dtach クライアントを全て SIGTERM で切断する。
 * 戻り値は kill に成功した pid 数。
 */
export async function killDtachClients(socketPath: string): Promise<number> {
  const pids = await findDtachClientPids(socketPath);
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed += 1;
    } catch {
      // 既に終了していた等は無視
    }
  }
  return killed;
}

/** シェルコマンド文字列に安全にエスケープする */
export function shellEscape(args: string[]): string {
  return args
    .map((arg) => {
      if (/^[a-zA-Z0-9_./:=@-]+$/.test(arg)) {
        return arg;
      }
      return `'${arg.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}
