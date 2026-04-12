/**
 * dtach CLI ラッパー
 *
 * dtach はソケットファイルベースのセッション管理ツール。
 * tmux と違い prefix キーの衝突やヘッダの二重表示が起きない。
 */

import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { runInteractiveCommand } from "../docker/client.ts";
import { defaultRuntimeDir } from "../lib/fs_utils.ts";

/** dtach セッション情報 */
export interface DtachSessionInfo {
  name: string;
  socketPath: string;
  createdAt: number;
}

/** ソケットディレクトリ */
export function getSocketDir(): string {
  return defaultRuntimeDir("sessions");
}

/** セッションID からソケットパスを得る */
export function socketPathFor(sessionId: string): string {
  return path.join(getSocketDir(), `${sessionId}.sock`);
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
): Promise<void> {
  // ソケットディレクトリを作成
  const dir = path.dirname(socketPath);
  await Bun.spawn(["mkdir", "-p", dir], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  const proc = Bun.spawn(
    ["dtach", "-n", socketPath, "-z", "/bin/sh", "-c", shellCommand],
    { stdout: "pipe", stderr: "pipe" },
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

/** dtach セッション（ソケット）が存在するか確認 */
export async function dtachHasSession(socketPath: string): Promise<boolean> {
  try {
    const s = await stat(socketPath);
    return s.isSocket();
  } catch {
    return false;
  }
}

/** dtach セッション一覧を取得（ソケットディレクトリをスキャン） */
export async function dtachListSessions(): Promise<DtachSessionInfo[]> {
  const dir = getSocketDir();
  try {
    const entries = await readdir(dir);
    const sessions: DtachSessionInfo[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".sock")) continue;
      const fullPath = path.join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (!s.isSocket()) continue;
        const name = entry.slice(0, -".sock".length); // sessionId
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
