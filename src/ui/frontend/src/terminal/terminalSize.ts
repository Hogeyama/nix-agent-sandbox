/**
 * Size negotiation helpers between xterm's `FitAddon` and the dtach
 * WebSocket protocol.
 *
 * `getTerminalSize` is the single source of truth for "what cols/rows
 * should we tell the backend?". It guards against the fit addon
 * returning `undefined`, non-positive sizes, or non-integer floats —
 * any of which would either crash the daemon-side resize handler or
 * produce a malformed pty geometry.
 *
 * `sendTerminalResize` serialises a size into the JSON resize frame
 * the daemon expects (`{type:"resize",cols,rows}`) and is a no-op when
 * the WebSocket is not in `OPEN` state, so callers do not need to
 * defensively check `readyState` themselves.
 */

import type { FitAddon } from "@xterm/addon-fit";

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export function getTerminalSize(
  fitAddon: Pick<FitAddon, "proposeDimensions"> | null | undefined,
): TerminalSize | null {
  const dims = fitAddon?.proposeDimensions();
  if (
    !dims ||
    !Number.isInteger(dims.cols) ||
    dims.cols <= 0 ||
    !Number.isInteger(dims.rows) ||
    dims.rows <= 0
  ) {
    return null;
  }
  return { cols: dims.cols, rows: dims.rows };
}

export function sendTerminalResize(
  ws: Pick<WebSocket, "readyState" | "send"> | null | undefined,
  size: TerminalSize,
): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
}
