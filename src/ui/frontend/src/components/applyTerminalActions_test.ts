/**
 * Pin the dispatcher's `show` semantics: synchronous `deps.show` plus
 * an rAF-scheduled `refit` against the matching handle. The rAF hop is
 * load-bearing — running fit synchronously while the slot is still
 * `display: none` reads a 0×0 viewport and corrupts the terminal size.
 */

import { describe, expect, mock, test } from "bun:test";
import { applyTerminalActions } from "./applyTerminalActions";

describe("applyTerminalActions", () => {
  test("show forwards to deps.show and schedules refit on rAF", () => {
    const refit = mock(() => undefined);
    const handle = { refit };
    const rafCallbacks: Array<() => void> = [];
    const deps = {
      mount: mock((_id: string) => undefined),
      dispose: mock((_id: string) => undefined),
      show: mock((_id: string) => undefined),
      hide: mock((_id: string) => undefined),
      requestAnimationFrame: (cb: () => void) => {
        rafCallbacks.push(cb);
        return 0;
      },
      getHandle: (id: string) => (id === "term-1" ? handle : undefined),
    };

    applyTerminalActions([{ type: "show", sessionId: "term-1" }], deps);

    // show is invoked synchronously, but refit is deferred to the
    // animation frame so layout can settle first.
    expect(deps.show).toHaveBeenCalledTimes(1);
    expect(deps.show).toHaveBeenCalledWith("term-1");
    expect(refit).not.toHaveBeenCalled();
    expect(rafCallbacks).toHaveLength(1);

    // Flushing the rAF queue invokes refit on the resolved handle.
    for (const cb of rafCallbacks) cb();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  test("show action does not call refit when rAF callback is dropped", () => {
    const refit = mock(() => undefined);
    const handle = { refit };
    const deps = {
      mount: mock((_id: string) => undefined),
      dispose: mock((_id: string) => undefined),
      show: mock((_id: string) => undefined),
      hide: mock((_id: string) => undefined),
      // Discarding the callback proves refit only fires through rAF —
      // there is no synchronous fallback path.
      requestAnimationFrame: (_cb: () => void) => 0,
      getHandle: (id: string) => (id === "term-1" ? handle : undefined),
    };

    applyTerminalActions([{ type: "show", sessionId: "term-1" }], deps);

    expect(deps.show).toHaveBeenCalledWith("term-1");
    expect(refit).not.toHaveBeenCalled();
  });

  test("mount, hide, and dispose actions are forwarded synchronously in order without rAF", () => {
    const calls: string[] = [];
    const rafCallbacks: Array<() => void> = [];
    const deps = {
      mount: mock((id: string) => {
        calls.push(`mount:${id}`);
      }),
      dispose: mock((id: string) => {
        calls.push(`dispose:${id}`);
      }),
      show: mock((id: string) => {
        calls.push(`show:${id}`);
      }),
      hide: mock((id: string) => {
        calls.push(`hide:${id}`);
      }),
      requestAnimationFrame: (cb: () => void) => {
        rafCallbacks.push(cb);
        return 0;
      },
      getHandle: (_id: string) => undefined,
    };

    applyTerminalActions(
      [
        { type: "mount", sessionId: "a" },
        { type: "hide", sessionId: "b" },
        { type: "dispose", sessionId: "c" },
      ],
      deps,
    );

    expect(calls).toEqual(["mount:a", "hide:b", "dispose:c"]);
    expect(deps.mount).toHaveBeenCalledTimes(1);
    expect(deps.hide).toHaveBeenCalledTimes(1);
    expect(deps.dispose).toHaveBeenCalledTimes(1);
    // No `show` action means rAF is never engaged.
    expect(rafCallbacks).toHaveLength(0);
  });
});
