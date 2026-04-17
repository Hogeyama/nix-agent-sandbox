/**
 * Shell dtach セッション ID 形式:
 *   shell-<parentSessionId>.<seq>
 * seq は 1 始まりの整数。parentSessionId は末尾に `.<digits>` を含まない前提
 * (現状の nas セッション ID は ISO タイムスタンプ形式)。
 *
 * このモジュールは backend (`src/ui/data.ts`) と frontend
 * (`src/ui/frontend/src/terminalSessions.ts`) の両方から import される。
 * node / bun / DOM API を足さないこと。純関数のみ。
 */

export interface ParsedShellSessionId {
  parentSessionId: string;
  seq: number;
}

const SHELL_PREFIX = "shell-";

export function buildShellSessionId(
  parentSessionId: string,
  seq: number,
): string {
  return `${SHELL_PREFIX}${parentSessionId}.${seq}`;
}

export function parseShellSessionId(id: string): ParsedShellSessionId | null {
  if (!id.startsWith(SHELL_PREFIX)) return null;
  const rest = id.slice(SHELL_PREFIX.length);
  const dotIdx = rest.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === rest.length - 1) return null;
  const parent = rest.slice(0, dotIdx);
  const seqStr = rest.slice(dotIdx + 1);
  if (!/^\d+$/.test(seqStr)) return null;
  const seq = Number.parseInt(seqStr, 10);
  if (seq <= 0) return null;
  return { parentSessionId: parent, seq };
}
