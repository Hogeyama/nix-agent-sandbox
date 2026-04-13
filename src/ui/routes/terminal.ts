/**
 * WebSocket ターミナルブリッジ
 *
 * ブラウザの xterm.js ↔ WebSocket ↔ dtach Unix socket を中継する。
 *
 * dtach プロトコル (v0.9):
 *   Client→Master: 常に 10 バイト固定の struct packet
 *     { type: u8, len: u8, payload: [u8; 8] }
 *   Master→Client: 生バイトストリーム（PTY 出力そのまま）
 *
 *   MSG_PUSH   = 0  キーボード入力 (len=バイト数, payload=データ, 最大8バイト/パケット)
 *   MSG_ATTACH = 1  アタッチ要求 (出力の受信を開始)
 *   MSG_DETACH = 2  デタッチ通知
 *   MSG_WINCH  = 3  ウィンドウサイズ変更 (payload=struct winsize)
 *   MSG_REDRAW = 4  再描画要求 (len=method, payload=struct winsize)
 */

import { stat } from "node:fs/promises";
import { Socket } from "node:net";
import type { ServerWebSocket } from "bun";
import { socketPathFor } from "../../dtach/client.ts";

// dtach message types
const MSG_PUSH = 0;
const MSG_ATTACH = 1;
const MSG_DETACH = 2;
const MSG_WINCH = 3;
const MSG_REDRAW = 4;

// Redraw methods
// REDRAW_CTRL_L (2) は子プロセスの stdin に Ctrl+L (0x0C) を注入する。
// ink 等の TUI フレームワークはこれを入力文字として扱い、カーソル状態が壊れる。
// REDRAW_WINCH (1) は SIGWINCH を送信し、TUI が安全に再描画できる。
const REDRAW_WINCH = 1;

/** 10 バイト固定のパケットを作る */
function makePacket(type: number, len: number, payload?: Buffer): Buffer {
  const buf = Buffer.alloc(10);
  buf[0] = type;
  buf[1] = len;
  if (payload) {
    payload.copy(buf, 2, 0, Math.min(payload.length, 8));
  }
  return buf;
}

/** struct winsize (8 bytes, little-endian) を作る */
function makeWinsize(cols: number, rows: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(rows, 0); // ws_row
  buf.writeUInt16LE(cols, 2); // ws_col
  buf.writeUInt16LE(0, 4); // ws_xpixel
  buf.writeUInt16LE(0, 6); // ws_ypixel
  return buf;
}

/** WebSocket の data に載せるコンテキスト */
export interface TerminalWSData {
  sessionId: string;
  socket: Socket | null;
}

/** リクエストURLからセッションIDを抽出 */
export function extractSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/terminal\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** dtach ソケットが存在するか確認 */
async function socketExists(socketPath: string): Promise<boolean> {
  try {
    const s = await stat(socketPath);
    return s.isSocket();
  } catch {
    return false;
  }
}

/** WebSocket upgrade 前のバリデーション */
export async function validateTerminalUpgrade(
  sessionId: string,
): Promise<{ ok: true; socketPath: string } | { ok: false; reason: string }> {
  const socketPath = socketPathFor(sessionId);
  if (!(await socketExists(socketPath))) {
    return { ok: false, reason: `Session not found: ${sessionId}` };
  }
  return { ok: true, socketPath };
}

/** WebSocket open — dtach ソケットに接続してブリッジ開始 */
export function handleTerminalOpen(ws: ServerWebSocket<TerminalWSData>): void {
  const { sessionId } = ws.data;
  const socketPath = socketPathFor(sessionId);

  const sock = new Socket();
  ws.data.socket = sock;

  sock.connect({ path: socketPath });

  sock.on("connect", () => {
    console.log(`[terminal] Connected to dtach socket: ${sessionId}`);

    // 1. MSG_ATTACH — master に出力転送を要求
    sock.write(makePacket(MSG_ATTACH, 0));

    // 2. MSG_REDRAW(WINCH) — デフォルト 80x24 で即座に再描画要求
    //    REDRAW_WINCH は SIGWINCH を送信し、TUI フレームワークが安全に再描画できる。
    //    ブラウザから実寸法が届き次第 MSG_WINCH で上書きされる。
    const defaultWinsize = makeWinsize(80, 24);
    sock.write(makePacket(MSG_REDRAW, REDRAW_WINCH, defaultWinsize));
  });

  sock.on("data", (data: Buffer) => {
    // Master→Client は生バイトストリーム → そのまま WebSocket へ
    console.log(`[terminal] dtach→browser: ${data.length} bytes`);
    ws.sendBinary(data);
  });

  sock.on("error", (err) => {
    console.error(`[terminal] Socket error for ${sessionId}:`, err.message);
    ws.close(1011, "dtach socket error");
  });

  sock.on("close", () => {
    console.log(`[terminal] dtach socket closed: ${sessionId}`);
    ws.close(1000, "dtach session ended");
  });
}

/** WebSocket message — ブラウザからの入力を dtach へ転送 */
export function handleTerminalMessage(
  ws: ServerWebSocket<TerminalWSData>,
  message: string | Buffer,
): void {
  const sock = ws.data.socket;
  if (!sock || sock.destroyed) {
    console.log(`[terminal] Socket destroyed, ignoring message`);
    return;
  }

  if (typeof message === "string") {
    // JSON control messages (resize)
    try {
      const msg = JSON.parse(message);
      if (msg.type === "resize" && msg.cols && msg.rows) {
        console.log(`[terminal] Resize: ${msg.cols}x${msg.rows}`);
        const winsize = makeWinsize(msg.cols, msg.rows);
        sock.write(makePacket(MSG_WINCH, 0, winsize));
        return;
      }
    } catch {
      // Not JSON — treat as terminal input
    }
    // テキスト入力を MSG_PUSH パケットに分割して送信（最大8バイト/パケット）
    console.log(`[terminal] Text input: ${message.length} chars`);
    const bytes = Buffer.from(message, "utf-8");
    sendPushPackets(sock, bytes);
  } else {
    // Binary data — terminal input
    console.log(`[terminal] Binary input: ${(message as Buffer).length} bytes`);
    const bytes = Buffer.isBuffer(message)
      ? message
      : Buffer.from(message as ArrayBuffer);
    sendPushPackets(sock, bytes);
  }
}

/** 入力バイト列を MSG_PUSH パケット (最大8バイト/パケット) に分割して送信 */
function sendPushPackets(sock: Socket, data: Buffer): void {
  for (let offset = 0; offset < data.length; offset += 8) {
    const chunk = data.subarray(offset, offset + 8);
    sock.write(makePacket(MSG_PUSH, chunk.length, Buffer.from(chunk)));
  }
}

/** WebSocket close — dtach ソケットをクリーンアップ */
export function handleTerminalClose(ws: ServerWebSocket<TerminalWSData>): void {
  const sock = ws.data.socket;
  if (sock && !sock.destroyed) {
    // MSG_DETACH を送ってから切断
    sock.write(makePacket(MSG_DETACH, 0));
    sock.destroy();
  }
  console.log(`[terminal] WebSocket closed: ${ws.data.sessionId}`);
}
