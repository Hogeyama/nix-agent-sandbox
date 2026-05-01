/**
 * Attach a dtach terminal session to a DOM container.
 *
 * This module is a Solid-agnostic factory: it owns an xterm `Terminal`
 * instance, the WebSocket that pipes bytes between xterm and the
 * daemon, and the resize / focus glue that holds them together. The
 * Solid layer (`TerminalPane.tsx`) wraps the returned handle but never
 * touches xterm or the socket directly, so the lifecycle is testable
 * without a renderer.
 *
 * Error policy
 * ------------
 * `attachTerminalSession` never throws. Any synchronous failure during
 * construction (xterm `open`, `new WebSocket`, addon init, …) is caught
 * and surfaced via the `onError` callback, after which a no-op handle
 * is returned so callers can still safely call `dispose()`. Runtime
 * failures (`ws.onerror`, abnormal `ws.onclose`, dispose-time teardown
 * errors) are likewise reported through `onError`.
 */

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { ensureTerminalFocus } from "./terminalInput";
import {
  getTerminalSize,
  sendTerminalResize,
  type TerminalSize,
} from "./terminalSize";

/**
 * Theme used by every terminal pane in the redesigned UI. Centralised
 * here so colour drift across multiple call sites is impossible —
 * adding a new pane should mean reading from this constant, not
 * re-typing the palette.
 */
export const THEME_DARK = {
  background: "#0a0908",
  foreground: "#f5f8ff",
  cursor: "#9dd2ff",
  selectionBackground: "rgba(157, 210, 255, 0.3)",
  black: "#161e2e",
  red: "#ff8a8a",
  green: "#7ee8a4",
  yellow: "#ffd166",
  blue: "#9dd2ff",
  magenta: "#c9b0ff",
  cyan: "#7ee8e8",
  white: "#f5f8ff",
  brightBlack: "#8897b3",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#c6e5ff",
  brightMagenta: "#d8c4ff",
  brightCyan: "#a5f3f3",
  brightWhite: "#ffffff",
} as const;

const FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace";
const DEFAULT_FONT_SIZE = 14;

/**
 * Narrow surface of `@xterm/xterm`'s `Terminal` actually consumed here.
 * Listing it explicitly keeps tests free of having to mock the full
 * Terminal API surface.
 */
export type TerminalLike = Pick<
  Terminal,
  | "open"
  | "dispose"
  | "onData"
  | "onResize"
  | "loadAddon"
  | "focus"
  | "options"
  | "write"
  | "rows"
  | "cols"
>;

/**
 * Narrow surface of the browser `WebSocket` used here. Tests inject a
 * fake matching this shape; the real `WebSocket` already satisfies it.
 */
export interface WebSocketLike {
  readyState: 0 | 1 | 2 | 3;
  binaryType: BinaryType;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/**
 * Subset of `FitAddon` consumed here. Lets tests inject a fake without
 * pulling the whole addon into the suite.
 */
export interface FitAddonLike {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

/**
 * Subset of `SearchAddon` consumed here. The toolbar drives match
 * navigation and decoration cleanup through this surface; tests
 * inject a fake matching this shape.
 */
export interface SearchAddonLike {
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  clearDecorations(): void;
}

export interface AttachOpts {
  sessionId: string;
  container: HTMLElement;
  wsToken: string;
  /** Override xterm Terminal construction (tests). */
  createTerminal?: () => TerminalLike;
  /** Override FitAddon construction (tests). */
  createFitAddon?: () => FitAddonLike;
  /** Override SearchAddon construction (tests). */
  createSearchAddon?: () => SearchAddonLike;
  /** Override WebSocket construction (tests). */
  createWebSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /** Override `setTimeout` so timer-driven branches can be exercised. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Override `clearTimeout` paired with `setTimeoutFn`. */
  clearTimeoutFn?: (handle: unknown) => void;
  /** Notified for both construction-time and runtime failures. */
  onError?: (msg: string) => void;
}

/**
 * Search controls bridged from the toolbar to the underlying
 * `SearchAddon`. The methods swallow no errors silently — addon
 * exceptions are surfaced through the `onError` callback supplied
 * to `attachTerminalSession`.
 */
export interface TerminalSearchHandle {
  findNext(query: string): void;
  findPrevious(query: string): void;
  clear(): void;
}

export interface TerminalHandle {
  focus(): void;
  refit(): void;
  setFontSize(px: number): void;
  /**
   * Bracket the font size (-1, then back) so xterm rebuilds its glyph
   * cache and renderer state against the now-visible viewport. Mirrors
   * the manual "press font-decrease" workaround the user otherwise has
   * to do every time a terminal first appears.
   */
  nudge(): void;
  dispose(): void;
  search: TerminalSearchHandle;
}

const NOOP_SEARCH_HANDLE: TerminalSearchHandle = {
  findNext() {},
  findPrevious() {},
  clear() {},
};

const NOOP_HANDLE: TerminalHandle = {
  focus() {},
  refit() {},
  setFontSize() {},
  nudge() {},
  dispose() {},
  search: NOOP_SEARCH_HANDLE,
};

/** WebSocket subprotocol prefix the daemon validates the token against. */
const WS_TOKEN_PREFIX = "nas.token.";

/**
 * Build the dtach attach URL for a given sessionId.
 *
 * The sessionId is `encodeURIComponent`-wrapped so that callers cannot
 * smuggle path segments (`/`, `..`) or query separators (`?`, `&`)
 * into the WebSocket URL by naming a session unusually.
 */
export function buildWsUrl(sessionId: string): string {
  const proto = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  const host = globalThis.location?.host ?? "localhost:3939";
  return `${proto}//${host}/api/terminal/${encodeURIComponent(sessionId)}`;
}

/**
 * Construct a default xterm `Terminal` with the standard options used
 * across the UI. Responsibility is intentionally narrow: the caller
 * (or a test factory) is in charge of `loadAddon` / `open`, so the
 * mounting path is identical regardless of who created the instance.
 */
function createDefaultTerminal(): TerminalLike {
  return new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontSize: DEFAULT_FONT_SIZE,
    rightClickSelectsWord: false,
    fontFamily: FONT_FAMILY,
    theme: { ...THEME_DARK },
  });
}

/**
 * Open the dtach WebSocket. The bearer token is sent as the
 * `Sec-WebSocket-Protocol` subprotocol value rather than embedded in
 * the URL: subprotocols are not logged by reverse proxies and not
 * captured in browser history, so they leak the token less aggressively
 * than a query string would.
 */
function connectWebSocket(
  url: string,
  token: string,
  createWs: (url: string, protocols: string[]) => WebSocketLike,
): WebSocketLike {
  const ws = createWs(url, [`${WS_TOKEN_PREFIX}${token}`]);
  ws.binaryType = "arraybuffer";
  return ws;
}

/**
 * dtach drops `SIGWINCH` notifications when the requested size matches
 * the size it already knows, which means the very first resize after
 * attach is silently ignored and the inner program never sees its
 * geometry. Schedule a one-off nudge: 1s after attach, if no data has
 * arrived yet, send a size that differs by 1 column from the real
 * geometry, then 200ms later restore the real size — the differing
 * frame forces dtach to emit a `SIGWINCH`, and the restore lands the
 * pty on the correct dimensions.
 *
 * Both the outer 1s timer and the inner 200ms restore timer push their
 * handles into `handles`; the caller is expected to drain that array
 * during `dispose()` so post-teardown writes to the WebSocket are
 * impossible.
 */
function armDtachInitialResizeNudge(deps: {
  ws: WebSocketLike;
  fitAddon: Pick<FitAddon, "proposeDimensions">;
  hasReceivedData: () => boolean;
  isDisposed: () => boolean;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  handles: unknown[];
}): void {
  const { ws, fitAddon, hasReceivedData, isDisposed, setTimeoutFn, handles } =
    deps;
  const outer = setTimeoutFn(() => {
    if (isDisposed()) return;
    if (hasReceivedData() || ws.readyState !== WebSocket.OPEN) return;
    const size = getTerminalSize(fitAddon);
    if (!size) return;
    const nudged: TerminalSize = {
      cols: size.cols > 1 ? size.cols - 1 : size.cols + 1,
      rows: size.rows,
    };
    sendTerminalResize(ws, nudged);
    const inner = setTimeoutFn(() => {
      if (isDisposed()) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      sendTerminalResize(ws, size);
    }, 200);
    handles.push(inner);
  }, 1000);
  handles.push(outer);
}

/**
 * Wire xterm input/output to the WebSocket:
 *
 *   - `term.onData` → `ws.send(<utf8 bytes>)`. Encoding via
 *     `TextEncoder` is mandatory; sending the raw string produces a
 *     text frame, but the daemon expects binary frames carrying UTF-8
 *     bytes.
 *   - `ws.onmessage` → `term.write(<bytes or string>)`.
 *   - `term.onResize` → JSON resize frame.
 *
 * Returns disposables for the xterm event listeners so the caller can
 * release them on teardown alongside the WebSocket.
 */
function bindTerminalToWebSocket(
  term: TerminalLike,
  ws: WebSocketLike,
  onDataReceived: () => void,
): { dispose: () => void } {
  const encoder = new TextEncoder();

  const dataDisposable = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encoder.encode(data));
    }
  });

  const resizeDisposable = term.onResize(({ cols, rows }) => {
    sendTerminalResize(ws, { cols, rows });
  });

  ws.onmessage = (ev: MessageEvent) => {
    onDataReceived();
    if (ev.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(ev.data));
    } else {
      term.write(ev.data as string);
    }
  };

  return {
    dispose() {
      dataDisposable.dispose();
      resizeDisposable.dispose();
    },
  };
}

/**
 * Build the `refit` function: re-measure via fit addon and forward the
 * resulting size to the WebSocket. Used both by the public handle and
 * by `setFontSize`, which needs a re-fit after the font metrics change.
 */
function createRefitFn(fitAddon: FitAddonLike, ws: WebSocketLike): () => void {
  return () => {
    fitAddon.fit();
    const size = getTerminalSize(fitAddon);
    if (size) sendTerminalResize(ws, size);
  };
}

/**
 * Build the window-resize handler: like `refit`, but additionally
 * re-asserts xterm focus because some browsers steal focus when the
 * viewport changes (e.g. devtools toggling). Kept separate from
 * `refit` so the public `refit()` does not yank focus on every call.
 */
function createWindowResizeHandler(
  term: TerminalLike,
  fitAddon: FitAddonLike,
  ws: WebSocketLike,
): () => void {
  return () => {
    fitAddon.fit();
    // ensureTerminalFocus is xterm-aware; harmless when called against
    // the narrowed TerminalLike since it only reads document focus.
    ensureTerminalFocus(term as Terminal);
    const size = getTerminalSize(fitAddon);
    if (size) sendTerminalResize(ws, size);
  };
}

/**
 * Wire `ws.onopen` / `ws.onerror` / `ws.onclose` to the surrounding
 * lifecycle. Splitting this out keeps the main factory body focused on
 * structural assembly rather than callback shape.
 *
 * - `onopen` flushes the initial size and arms the dtach nudge.
 * - `onerror` always reports through `reportError`.
 * - `onclose` reports unless the close was a clean `1000`.
 */
function bindLifecycleCallbacks(
  ws: WebSocketLike,
  callbacks: {
    onOpen: () => void;
    onError: (msg: string) => void;
    onCloseAbnormal: (msg: string) => void;
  },
): void {
  ws.onopen = () => callbacks.onOpen();
  ws.onerror = () => callbacks.onError("WebSocket connection error");
  ws.onclose = (ev: CloseEvent) => {
    if (ev.code !== 1000) {
      callbacks.onCloseAbnormal(
        `Disconnected: ${ev.reason || "connection lost"}`,
      );
    }
  };
}

/**
 * Build the `dispose` function. Owns the teardown order and per-resource
 * try/catch, and detaches every WebSocket and resize listener first so
 * stale events fired during teardown cannot re-enter `reportError`.
 *
 * Each individual teardown step is isolated: a failure in one resource
 * still runs the others and is surfaced through `reportError`.
 */
function createDisposeFn(deps: {
  term: TerminalLike;
  ws: WebSocketLike;
  bindingDispose: () => void;
  windowResizeHandler: () => void;
  timeoutHandles: unknown[];
  clearTimeoutFn: (h: unknown) => void;
  reportError: (msg: string) => void;
  setDisposed: () => void;
}): () => void {
  const {
    term,
    ws,
    bindingDispose,
    windowResizeHandler,
    timeoutHandles,
    clearTimeoutFn,
    reportError,
    setDisposed,
  } = deps;
  return () => {
    setDisposed();
    // Detach handlers first so any close/error event triggered by the
    // teardown sequence below cannot fire reportError after dispose.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    globalThis.removeEventListener("resize", windowResizeHandler);
    for (const h of timeoutHandles) clearTimeoutFn(h);
    try {
      bindingDispose();
    } catch (e) {
      reportError(
        e instanceof Error
          ? `Terminal unbind failed: ${e.message}`
          : "Terminal unbind failed",
      );
    }
    try {
      ws.close();
    } catch (e) {
      reportError(
        e instanceof Error
          ? `WebSocket close failed: ${e.message}`
          : "WebSocket close failed",
      );
    }
    try {
      term.dispose();
    } catch (e) {
      reportError(
        e instanceof Error
          ? `Terminal dispose failed: ${e.message}`
          : "Terminal dispose failed",
      );
    }
  };
}

/**
 * Mount an xterm session against `opts.container` and return a handle
 * for the surrounding UI to drive font size / refit / disposal.
 *
 * Construction failures collapse to a no-op handle and a single
 * `onError` notification — never a thrown exception — so a single bad
 * tab cannot crash the panel.
 */
export function attachTerminalSession(opts: AttachOpts): TerminalHandle {
  const {
    sessionId,
    container,
    wsToken,
    createTerminal,
    createFitAddon,
    createSearchAddon,
    createWebSocket,
    setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeoutFn = (h) => globalThis.clearTimeout(h as number),
    onError,
  } = opts;

  const reportError = (msg: string) => {
    if (onError) onError(msg);
  };
  const wsFactory =
    createWebSocket ??
    ((url: string, protocols: string[]) =>
      new WebSocket(url, protocols) as unknown as WebSocketLike);

  let term: TerminalLike;
  let fitAddon: FitAddonLike;
  let searchAddon: SearchAddonLike;
  let ws: WebSocketLike;
  let bindingDispose: () => void;
  let resizeObserver: ResizeObserver | null = null;
  const timeoutHandles: unknown[] = [];
  let receivedData = false;
  let disposed = false;
  const isDisposed = () => disposed;

  try {
    fitAddon = createFitAddon ? createFitAddon() : new FitAddon();
    searchAddon = (createSearchAddon ?? (() => new SearchAddon()))();
    term = createTerminal ? createTerminal() : createDefaultTerminal();
    term.loadAddon(
      fitAddon as unknown as Parameters<TerminalLike["loadAddon"]>[0],
    );
    term.loadAddon(
      searchAddon as unknown as Parameters<TerminalLike["loadAddon"]>[0],
    );
    if (!createTerminal) {
      // Default factory only constructs Terminal; load the rest of the
      // standard addons here so custom factories stay minimal.
      term.loadAddon(new ClipboardAddon());
      term.loadAddon(new WebLinksAddon());
    }
    term.open(container);
    // term.open attaches xterm at the default 80x24 because container
    // layout has not settled yet. Watch the container's box size with
    // ResizeObserver: it fires once after the initial layout (sizing
    // xterm to the real pane width) and again on every subsequent
    // container resize, including future drag-resize between panes.
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        fitAddon.fit();
      });
      resizeObserver.observe(container);
    }

    ws = connectWebSocket(buildWsUrl(sessionId), wsToken, wsFactory);
    bindLifecycleCallbacks(ws, {
      onOpen: () => {
        const size = getTerminalSize(fitAddon);
        if (size) sendTerminalResize(ws, size);
        armDtachInitialResizeNudge({
          ws,
          fitAddon,
          hasReceivedData: () => receivedData,
          isDisposed,
          setTimeoutFn,
          handles: timeoutHandles,
        });
      },
      onError: reportError,
      onCloseAbnormal: reportError,
    });
    bindingDispose = bindTerminalToWebSocket(term, ws, () => {
      receivedData = true;
    }).dispose;
  } catch (e) {
    reportError(
      e instanceof Error ? e.message : "Failed to attach terminal session",
    );
    return NOOP_HANDLE;
  }

  const refit = createRefitFn(fitAddon, ws);
  const onWindowResize = createWindowResizeHandler(term, fitAddon, ws);
  globalThis.addEventListener("resize", onWindowResize);

  const baseDispose = createDisposeFn({
    term,
    ws,
    bindingDispose,
    windowResizeHandler: onWindowResize,
    timeoutHandles,
    clearTimeoutFn,
    reportError,
    setDisposed: () => {
      disposed = true;
    },
  });
  const dispose = () => {
    if (resizeObserver) {
      try {
        resizeObserver.disconnect();
      } catch (e) {
        reportError(
          e instanceof Error
            ? `ResizeObserver disconnect failed: ${e.message}`
            : "ResizeObserver disconnect failed",
        );
      }
      resizeObserver = null;
    }
    baseDispose();
  };

  const search: TerminalSearchHandle = {
    findNext(query: string) {
      if (disposed) return;
      try {
        searchAddon.findNext(query);
      } catch (e) {
        reportError(
          e instanceof Error
            ? `Search findNext failed: ${e.message}`
            : "Search findNext failed",
        );
      }
    },
    findPrevious(query: string) {
      if (disposed) return;
      try {
        searchAddon.findPrevious(query);
      } catch (e) {
        reportError(
          e instanceof Error
            ? `Search findPrevious failed: ${e.message}`
            : "Search findPrevious failed",
        );
      }
    },
    clear() {
      if (disposed) return;
      try {
        searchAddon.clearDecorations();
      } catch (e) {
        reportError(
          e instanceof Error
            ? `Search clear failed: ${e.message}`
            : "Search clear failed",
        );
      }
    },
  };

  return {
    focus() {
      if (disposed) return;
      term.focus();
    },
    refit() {
      if (disposed) return;
      refit();
    },
    setFontSize(px: number) {
      if (disposed) return;
      term.options.fontSize = px;
      refit();
    },
    nudge() {
      if (disposed) return;
      const current =
        typeof term.options.fontSize === "number"
          ? term.options.fontSize
          : DEFAULT_FONT_SIZE;
      term.options.fontSize = current - 1;
      term.options.fontSize = current;
      refit();
    },
    dispose() {
      if (disposed) return;
      dispose();
    },
    search,
  };
}
