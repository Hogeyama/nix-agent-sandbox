/**
 * Guards against accidental relaxation of the WebSocket payload cap. Bun's
 * default is 16 MiB which is a DoS vector for the terminal input path
 * (threat review F6) — this test pins the value so a silent regression
 * trips CI instead of shipping.
 *
 * 単に定数値を pin するだけでは、`Bun.serve` の `websocket.maxPayloadLength`
 * への配線が外れても検知できない。そのため `WEBSOCKET_CONFIG` (Bun.serve に
 * そのまま渡される object) を直接検証し、定数からハンドラ 3 本 + 上限値まで
 * 一体で回帰テストする。
 */

import { expect, test } from "bun:test";
import {
  handleTerminalClose,
  handleTerminalMessage,
  handleTerminalOpen,
} from "./routes/terminal.ts";
import { WEBSOCKET_CONFIG, WS_MAX_PAYLOAD_BYTES } from "./server.ts";

test("WS_MAX_PAYLOAD_BYTES is pinned to 64 KiB", () => {
  expect(WS_MAX_PAYLOAD_BYTES).toEqual(64 * 1024);
  expect(WS_MAX_PAYLOAD_BYTES).toEqual(65536);
});

test("WEBSOCKET_CONFIG wires maxPayloadLength to WS_MAX_PAYLOAD_BYTES", () => {
  // Bun.serve がこの object をそのまま受け取るため、ここを assert すれば
  // 「定数は残っているが websocket config への配線が消えた」という回帰を
  // 検出できる。
  expect(WEBSOCKET_CONFIG.maxPayloadLength).toEqual(WS_MAX_PAYLOAD_BYTES);
  expect(WEBSOCKET_CONFIG.maxPayloadLength).toEqual(64 * 1024);
});

test("WEBSOCKET_CONFIG wires terminal handlers", () => {
  // maxPayloadLength だけ assert すると、ハンドラが差し替わる回帰
  // (例: 空 open に置き換わって全セッション壊れる) を検知できない。
  // open/message/close の identity もまとめて pin する。
  expect(WEBSOCKET_CONFIG.open).toBe(handleTerminalOpen);
  expect(WEBSOCKET_CONFIG.message).toBe(handleTerminalMessage);
  expect(WEBSOCKET_CONFIG.close).toBe(handleTerminalClose);
});
