/**
 * Tests for `attachTerminalSession`.
 *
 * The factory wraps xterm + WebSocket lifecycle. The pinned behaviours
 * are:
 *
 *   - mount opens xterm against the supplied container and connects a
 *     WebSocket to `wss://<host>/api/terminal/<encoded sessionId>` with
 *     the bearer token in the subprotocol;
 *   - `dispose()` releases every owned resource (WS, xterm, window
 *     resize listener), and clears every pending dtach-nudge timer so
 *     no `ws.send` can fire after teardown;
 *   - the dtach SIGWINCH nudge is scheduled with the injectable
 *     `setTimeoutFn` and forces a different size 1s after `onopen`;
 *   - `ws.onclose` with a non-normal code surfaces through `onError`,
 *     while a clean `1000` close stays silent;
 *   - `ws.onerror` is reported through `onError`;
 *   - keystrokes from xterm are encoded as UTF-8 bytes onto the
 *     WebSocket;
 *   - construction-time exceptions never escape — they collapse to
 *     `onError` + a no-op handle that survives `dispose()`;
 *   - dispose-time teardown failures (`term.dispose()` etc.) are
 *     surfaced through `onError` rather than thrown;
 *   - `setFontSize` mutates the live terminal options.
 *
 * All dependencies are injected, so no real DOM, xterm, or WebSocket
 * is created.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  attachTerminalSession,
  buildWsUrl,
  type FitAddonLike,
  type SearchAddonLike,
  type TerminalLike,
  type WebSocketLike,
} from "./attachTerminalSession";

type Disposable = { dispose: () => void };
type Listener<T> = (e: T) => void;

interface FakeTerminalOptions {
  fontSize?: number;
  [k: string]: unknown;
}

function makeFakeTerminal(overrides?: { dispose?: () => void }): {
  term: TerminalLike;
  emitData(s: string): void;
  emitResize(cols: number, rows: number): void;
  openCalls: HTMLElement[];
  disposed: boolean;
  options: FakeTerminalOptions;
  focusCalls: number;
  writes: (string | Uint8Array)[];
  loadedAddons: unknown[];
} {
  let dataListener: Listener<string> | null = null;
  let resizeListener: Listener<{ cols: number; rows: number }> | null = null;
  const state = {
    openCalls: [] as HTMLElement[],
    disposed: false,
    options: { fontSize: 14 } as FakeTerminalOptions,
    focusCalls: 0,
    writes: [] as (string | Uint8Array)[],
    loadedAddons: [] as unknown[],
  };
  const term: TerminalLike = {
    open(parent: HTMLElement) {
      state.openCalls.push(parent);
    },
    dispose() {
      state.disposed = true;
      if (overrides?.dispose) overrides.dispose();
    },
    onData(handler: Listener<string>): Disposable {
      dataListener = handler;
      return {
        dispose() {
          dataListener = null;
        },
      };
    },
    onResize(handler: Listener<{ cols: number; rows: number }>): Disposable {
      resizeListener = handler;
      return {
        dispose() {
          resizeListener = null;
        },
      };
    },
    loadAddon(addon: unknown) {
      state.loadedAddons.push(addon);
    },
    focus() {
      state.focusCalls += 1;
    },
    options: state.options,
    write(data: string | Uint8Array) {
      state.writes.push(data);
    },
    rows: 24,
    cols: 80,
  } as unknown as TerminalLike;
  return {
    term,
    emitData(s) {
      if (dataListener) dataListener(s);
    },
    emitResize(cols, rows) {
      if (resizeListener) resizeListener({ cols, rows });
    },
    get openCalls() {
      return state.openCalls;
    },
    get disposed() {
      return state.disposed;
    },
    options: state.options,
    get focusCalls() {
      return state.focusCalls;
    },
    get writes() {
      return state.writes;
    },
    get loadedAddons() {
      return state.loadedAddons;
    },
  };
}

interface FakeSocket extends WebSocketLike {
  sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[];
  closeCalls: { code?: number; reason?: string }[];
  fireOpen(): void;
  fireMessage(data: ArrayBuffer | string): void;
  fireClose(code: number, reason: string): void;
  fireError(): void;
}

function makeFakeSocket(): FakeSocket {
  const sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];
  const closeCalls: { code?: number; reason?: string }[] = [];
  const sock = {
    readyState: WebSocket.OPEN,
    binaryType: "arraybuffer" as BinaryType,
    onopen: null as ((ev: Event) => void) | null,
    onmessage: null as ((ev: MessageEvent) => void) | null,
    onerror: null as ((ev: Event) => void) | null,
    onclose: null as ((ev: CloseEvent) => void) | null,
    sent,
    closeCalls,
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      sent.push(data);
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
    },
    fireOpen() {
      this.onopen?.(new Event("open"));
    },
    fireMessage(data: ArrayBuffer | string) {
      this.onmessage?.({ data } as MessageEvent);
    },
    fireClose(code: number, reason: string) {
      this.onclose?.({ code, reason } as CloseEvent);
    },
    fireError() {
      this.onerror?.(new Event("error"));
    },
  } as FakeSocket;
  return sock;
}

interface FakeTimer {
  setTimeoutFn(fn: () => void, ms: number): unknown;
  clearTimeoutFn(handle: unknown): void;
  scheduled: {
    fn: () => void;
    ms: number;
    handle: number;
    cancelled: boolean;
  }[];
  runAll(): void;
}

function makeFakeTimer(): FakeTimer {
  const scheduled: FakeTimer["scheduled"] = [];
  let nextHandle = 1;
  return {
    scheduled,
    setTimeoutFn(fn, ms) {
      const handle = nextHandle++;
      scheduled.push({ fn, ms, handle, cancelled: false });
      return handle;
    },
    clearTimeoutFn(handle) {
      const entry = scheduled.find((e) => e.handle === handle);
      if (entry) entry.cancelled = true;
    },
    runAll() {
      // Snapshot length each iteration: nested setTimeoutFn calls
      // append to `scheduled`, and we want them executed too.
      let i = 0;
      while (i < scheduled.length) {
        const entry = scheduled[i];
        i += 1;
        if (entry && !entry.cancelled) entry.fn();
      }
    },
  };
}

/**
 * Build a `FitAddonLike` whose `proposeDimensions` is statically pinned
 * to `dims`. Lets tests inject the addon directly via `createFitAddon`
 * instead of mutating the addon the factory loaded.
 */
function makeFakeFitAddon(
  dims: { cols: number; rows: number } | undefined,
  overrides?: { fit?: () => void },
): FitAddonLike {
  return {
    fit: overrides?.fit ?? (() => {}),
    proposeDimensions: () => dims,
  };
}

let originalLocation: Location;
let originalAddEventListener: typeof globalThis.addEventListener;
let originalRemoveEventListener: typeof globalThis.removeEventListener;
let resizeListeners: EventListenerOrEventListenerObject[];

beforeEach(() => {
  originalLocation = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", host: "ui.example.test:9443" },
  });
  resizeListeners = [];
  originalAddEventListener = globalThis.addEventListener;
  originalRemoveEventListener = globalThis.removeEventListener;
  globalThis.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => {
    if (type === "resize") resizeListeners.push(listener);
  }) as typeof globalThis.addEventListener;
  globalThis.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => {
    if (type === "resize") {
      const idx = resizeListeners.indexOf(listener);
      if (idx >= 0) resizeListeners.splice(idx, 1);
    }
  }) as typeof globalThis.removeEventListener;
});

afterEach(() => {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: originalLocation,
  });
  globalThis.addEventListener = originalAddEventListener;
  globalThis.removeEventListener = originalRemoveEventListener;
});

function fakeContainer(): HTMLElement {
  // Minimal stub: attachTerminalSession only forwards the value into
  // term.open() and never reads from it directly.
  return {} as HTMLElement;
}

describe("buildWsUrl", () => {
  test("uses wss:// on https origin and percent-encodes sessionId", () => {
    expect(buildWsUrl("weird/session id")).toBe(
      `wss://ui.example.test:9443/api/terminal/${encodeURIComponent("weird/session id")}`,
    );
  });
});

describe("attachTerminalSession", () => {
  test("mount: term.open(container) and ws connect with token subprotocol", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const container = fakeContainer();
    const wsCalls: { url: string; protocols: string[] }[] = [];

    attachTerminalSession({
      sessionId: "abc/123",
      container,
      wsToken: "secret-token",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: (url, protocols) => {
        wsCalls.push({ url, protocols });
        return sock;
      },
    });

    expect(fakeTerm.openCalls).toEqual([container]);
    expect(wsCalls).toHaveLength(1);
    expect(wsCalls[0]?.url).toBe(
      `wss://ui.example.test:9443/api/terminal/${encodeURIComponent("abc/123")}`,
    );
    expect(wsCalls[0]?.protocols).toEqual(["nas.token.secret-token"]);
    expect(wsCalls[0]?.url).not.toContain("secret-token");
    expect(sock.binaryType).toBe("arraybuffer");
  });

  test("dispose: closes WS, disposes term, removes window resize listener", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: () => sock,
    });

    expect(resizeListeners).toHaveLength(1);
    handle.dispose();
    expect(sock.closeCalls).toHaveLength(1);
    expect(fakeTerm.disposed).toBe(true);
    expect(resizeListeners).toHaveLength(0);
  });

  test("ws.onopen flushes initial resize using fit addon dimensions", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const timer = makeFakeTimer();
    const fit = makeFakeFitAddon({ cols: 100, rows: 30 });

    attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => fit,
      createWebSocket: () => sock,
      setTimeoutFn: timer.setTimeoutFn.bind(timer),
      clearTimeoutFn: timer.clearTimeoutFn.bind(timer),
    });

    sock.fireOpen();

    expect(sock.sent).toHaveLength(1);
    expect(JSON.parse(sock.sent[0] as string)).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
    });
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0]?.ms).toBe(1000);
  });

  test("dtach nudge: 1s timer sends a 1-col-different size, then 200ms restore", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const timer = makeFakeTimer();
    const fit = makeFakeFitAddon({ cols: 100, rows: 30 });

    attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => fit,
      createWebSocket: () => sock,
      setTimeoutFn: timer.setTimeoutFn.bind(timer),
      clearTimeoutFn: timer.clearTimeoutFn.bind(timer),
    });

    sock.fireOpen();
    // sock.sent[0] is the initial resize. Run the 1s nudge.
    timer.runAll();

    // After runAll, we should see: initial resize, nudge resize (cols!=100),
    // restore resize (cols=100). 3 frames in total.
    expect(sock.sent).toHaveLength(3);
    const nudge = JSON.parse(sock.sent[1] as string);
    const restore = JSON.parse(sock.sent[2] as string);
    expect(nudge.cols).not.toBe(100);
    expect(nudge.rows).toBe(30);
    expect(restore).toEqual({ type: "resize", cols: 100, rows: 30 });

    // The schedule should record: 1000ms nudge then 200ms restore.
    const ms = timer.scheduled.map((s) => s.ms);
    expect(ms).toEqual([1000, 200]);
  });

  test("dispose cancels the inner 200ms restore timer scheduled by the nudge", () => {
    // Pin the inner-timer cleanup: after dispose, neither the outer 1s
    // timer nor the inner 200ms restore timer is allowed to fire ws.send.
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const timer = makeFakeTimer();
    const fit = makeFakeFitAddon({ cols: 100, rows: 30 });

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => fit,
      createWebSocket: () => sock,
      setTimeoutFn: timer.setTimeoutFn.bind(timer),
      clearTimeoutFn: timer.clearTimeoutFn.bind(timer),
    });

    sock.fireOpen();
    // Run the outer 1s nudge so the inner 200ms timer is registered too.
    const outer = timer.scheduled[0];
    if (!outer) throw new Error("outer timer missing");
    outer.fn();
    expect(timer.scheduled).toHaveLength(2);

    handle.dispose();
    // Both the outer (already fired) and the inner pending timer must
    // be cancelled by dispose.
    expect(timer.scheduled.every((e) => e.cancelled)).toBe(true);
  });

  test("ws.onclose with non-1000 code surfaces reason via onError", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const errors: string[] = [];

    attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: () => sock,
      onError: (m) => errors.push(m),
    });

    sock.fireClose(1011, "boom");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("boom");
  });

  test("ws.onclose with clean 1000 code stays silent", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const errors: string[] = [];

    attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: () => sock,
      onError: (m) => errors.push(m),
    });

    sock.fireClose(1000, "");
    expect(errors).toEqual([]);
  });

  test("ws.onerror is reported through onError", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const errors: string[] = [];

    attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: () => sock,
      onError: (m) => errors.push(m),
    });

    sock.fireError();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("WebSocket connection error");
  });

  test("term.onData input is encoded as UTF-8 bytes onto the WebSocket", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();

    attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: () => sock,
    });

    fakeTerm.emitData("hi");
    expect(sock.sent).toHaveLength(1);
    const sent = sock.sent[0];
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent as Uint8Array)).toEqual([0x68, 0x69]);
  });

  test("construction-time WebSocket throw → onError + safe no-op handle", () => {
    const fakeTerm = makeFakeTerminal();
    const errors: string[] = [];

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: () => {
        throw new Error("ws constructor refused");
      },
      onError: (m) => errors.push(m),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ws constructor refused");
    // Handle must be safe to invoke even though attach failed.
    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.focus()).not.toThrow();
    expect(() => handle.refit()).not.toThrow();
    expect(() => handle.setFontSize(20)).not.toThrow();
  });

  test("dispose surfaces term.dispose() failures through onError", () => {
    const fakeTerm = makeFakeTerminal({
      dispose: () => {
        throw new Error("xterm boom");
      },
    });
    const sock = makeFakeSocket();
    const errors: string[] = [];

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createWebSocket: () => sock,
      onError: (m) => errors.push(m),
    });

    expect(() => handle.dispose()).not.toThrow();
    const matched = errors.find((m) =>
      m.startsWith("Terminal dispose failed:"),
    );
    expect(matched).toBeDefined();
    expect(matched).toContain("xterm boom");
  });

  test("setFontSize mutates term.options.fontSize", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const fitFit = mock(() => {});
    const fit = makeFakeFitAddon(undefined, { fit: fitFit });

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => fit,
      createWebSocket: () => sock,
    });

    handle.setFontSize(20);
    expect(fakeTerm.options.fontSize).toBe(20);
    expect(fitFit).toHaveBeenCalled();
  });

  test("default factory loads the search addon onto the terminal", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const fakeSearch: SearchAddonLike = {
      findNext: () => false,
      findPrevious: () => false,
      clearDecorations: () => {},
    };
    const searchFactory = mock(() => fakeSearch);

    attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createSearchAddon: searchFactory,
      createWebSocket: () => sock,
    });

    expect(searchFactory).toHaveBeenCalledTimes(1);
    expect(fakeTerm.loadedAddons).toContain(fakeSearch);
  });

  test("handle.search.findNext forwards the query to the search addon", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const findNext = mock((_q: string) => true);
    const fakeSearch: SearchAddonLike = {
      findNext,
      findPrevious: () => false,
      clearDecorations: () => {},
    };

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createSearchAddon: () => fakeSearch,
      createWebSocket: () => sock,
    });

    handle.search.findNext("foo");
    expect(findNext).toHaveBeenCalledTimes(1);
    expect(findNext.mock.calls[0]?.[0]).toBe("foo");
  });

  test("handle.search.findPrevious forwards the query to the search addon", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const findPrevious = mock((_q: string) => true);
    const fakeSearch: SearchAddonLike = {
      findNext: () => false,
      findPrevious,
      clearDecorations: () => {},
    };

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createSearchAddon: () => fakeSearch,
      createWebSocket: () => sock,
    });

    handle.search.findPrevious("bar");
    expect(findPrevious).toHaveBeenCalledTimes(1);
    expect(findPrevious.mock.calls[0]?.[0]).toBe("bar");
  });

  test("handle.search.clear delegates to the addon's clearDecorations", () => {
    const fakeTerm = makeFakeTerminal();
    const sock = makeFakeSocket();
    const clearDecorations = mock(() => {});
    const fakeSearch: SearchAddonLike = {
      findNext: () => false,
      findPrevious: () => false,
      clearDecorations,
    };

    const handle = attachTerminalSession({
      sessionId: "s1",
      container: fakeContainer(),
      wsToken: "t",
      createTerminal: () => fakeTerm.term,
      createFitAddon: () => makeFakeFitAddon({ cols: 80, rows: 24 }),
      createSearchAddon: () => fakeSearch,
      createWebSocket: () => sock,
    });

    handle.search.clear();
    expect(clearDecorations).toHaveBeenCalledTimes(1);
  });
});
