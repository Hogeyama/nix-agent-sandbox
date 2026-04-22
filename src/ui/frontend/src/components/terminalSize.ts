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
