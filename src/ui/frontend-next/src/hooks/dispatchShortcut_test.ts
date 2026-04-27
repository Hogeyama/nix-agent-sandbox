/**
 * Tests for the pure shortcut dispatcher.
 *
 * The dispatcher is unit-tested with structurally typed
 * `KeyboardEventLike` doubles and spy handlers so the test suite stays
 * independent of the DOM and the Solid runtime. The catalog itself is
 * pinned by `keybindsCatalog_test.ts`; these tests pin the dispatch
 * routing and the §8 invariants the hook enforces (terminal-focus
 * keys keep firing inside a TEXTAREA, the asymmetric Ctrl+Shift+[ pair
 * is intentionally a left-side no-op, and a missing handler is a
 * silent no-op rather than a throw).
 */

import { describe, expect, test } from "bun:test";
import { dispatchShortcut, type ShortcutHandlers } from "./dispatchShortcut";
import type { KeyboardEventLike } from "./matchShortcut";

function makeEvent(opts: Partial<KeyboardEventLike> = {}): KeyboardEventLike {
  return {
    key: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    target: null,
    ...opts,
  };
}

interface Spies {
  calls: string[];
  handlers: ShortcutHandlers;
  indexArgs: number[];
}

function makeSpies(): Spies {
  const calls: string[] = [];
  const indexArgs: number[] = [];
  const handlers: ShortcutHandlers = {
    onNewSession: () => {
      calls.push("onNewSession");
    },
    onSelectSessionByIndex: (i) => {
      calls.push("onSelectSessionByIndex");
      indexArgs.push(i);
    },
    onApproveSelected: () => {
      calls.push("onApproveSelected");
    },
    onDenySelected: () => {
      calls.push("onDenySelected");
    },
    onToggleRightCollapse: () => {
      calls.push("onToggleRightCollapse");
    },
    onOpenSettings: () => {
      calls.push("onOpenSettings");
    },
    onOpenShortcuts: () => {
      calls.push("onOpenShortcuts");
    },
  };
  return { calls, handlers, indexArgs };
}

describe("dispatchShortcut catalog-driven entries", () => {
  test("Ctrl+N dispatches session.new", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "n", ctrlKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onNewSession"]);
  });

  test("Ctrl+Shift+A dispatches action.approve", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "A", ctrlKey: true, shiftKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onApproveSelected"]);
  });

  test("Ctrl+Shift+D dispatches action.deny", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "D", ctrlKey: true, shiftKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onDenySelected"]);
  });

  test("Ctrl+, dispatches settings.open", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: ",", ctrlKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onOpenSettings"]);
  });

  test("Ctrl+? dispatches settings.shortcuts", () => {
    const spies = makeSpies();
    // `?` is produced by Shift+/ on US layouts; the catalog spec
    // pins `key: "?"` so the dispatcher only inspects the resolved
    // `key` value, not the underlying physical key.
    const e = makeEvent({ key: "?", ctrlKey: true, shiftKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onOpenShortcuts"]);
  });

  test("Ctrl+Meta+N still dispatches session.new (metaKey is not inspected)", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "n", ctrlKey: true, metaKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onNewSession"]);
  });
});

describe("dispatchShortcut Ctrl+1..9 hard-coded path", () => {
  test("Ctrl+1 dispatches session.switch with index 1", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "1", ctrlKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onSelectSessionByIndex"]);
    expect(spies.indexArgs).toEqual([1]);
  });

  test("Ctrl+5 dispatches session.switch with index 5", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "5", ctrlKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.indexArgs).toEqual([5]);
  });

  test("Ctrl+9 dispatches session.switch with index 9", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "9", ctrlKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.indexArgs).toEqual([9]);
  });

  test("Ctrl+0 does not match (digits 1..9 only)", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "0", ctrlKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: false, preventDefault: false });
    expect(spies.calls).toEqual([]);
  });

  test("Ctrl+Shift+1 does not match (extra modifier rejected)", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "1", ctrlKey: true, shiftKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: false, preventDefault: false });
    expect(spies.calls).toEqual([]);
  });

  test("Ctrl+Meta+1 still dispatches session.switch (metaKey is not inspected)", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "1", ctrlKey: true, metaKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.indexArgs).toEqual([1]);
  });
});

describe("dispatchShortcut Ctrl+Shift+] hard-coded path", () => {
  test("Ctrl+Shift+] dispatches pane.toggleCollapse (right side)", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "]", ctrlKey: true, shiftKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onToggleRightCollapse"]);
  });

  test("Ctrl+Shift+[ does not match (left pane non-collapsible per §6.1)", () => {
    const spies = makeSpies();
    const e = makeEvent({ key: "[", ctrlKey: true, shiftKey: true });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: false, preventDefault: false });
    expect(spies.calls).toEqual([]);
  });

  test("Ctrl+Meta+Shift+] still dispatches pane.toggleCollapse (metaKey is not inspected)", () => {
    const spies = makeSpies();
    const e = makeEvent({
      key: "]",
      ctrlKey: true,
      shiftKey: true,
      metaKey: true,
    });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onToggleRightCollapse"]);
  });
});

describe("dispatchShortcut handler absence", () => {
  test("Matched shortcut with empty handlers is a silent no-op (no throw, preventDefault: false)", () => {
    const e = makeEvent({ key: "n", ctrlKey: true });
    const result = dispatchShortcut(e, {});
    expect(result).toEqual({ matched: true, preventDefault: false });
  });

  test("Ctrl+1 with empty handlers is a silent no-op", () => {
    const e = makeEvent({ key: "3", ctrlKey: true });
    const result = dispatchShortcut(e, {});
    expect(result).toEqual({ matched: true, preventDefault: false });
  });

  test("Ctrl+Shift+] with empty handlers is a silent no-op", () => {
    const e = makeEvent({ key: "]", ctrlKey: true, shiftKey: true });
    const result = dispatchShortcut(e, {});
    expect(result).toEqual({ matched: true, preventDefault: false });
  });
});

describe("dispatchShortcut text-field bypass (terminal-focus capture)", () => {
  test("Ctrl+N still dispatches when target is TEXTAREA (allowInTextField on spec)", () => {
    const spies = makeSpies();
    const e = makeEvent({
      key: "n",
      ctrlKey: true,
      target: { tagName: "TEXTAREA" } as unknown as EventTarget,
    });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onNewSession"]);
  });

  test("Ctrl+1 still dispatches when target is TEXTAREA (hard-coded path bypasses guard)", () => {
    const spies = makeSpies();
    const e = makeEvent({
      key: "1",
      ctrlKey: true,
      target: { tagName: "TEXTAREA" } as unknown as EventTarget,
    });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.indexArgs).toEqual([1]);
  });

  test("Ctrl+Shift+] still dispatches when target is TEXTAREA (hard-coded path bypasses guard)", () => {
    const spies = makeSpies();
    const e = makeEvent({
      key: "]",
      ctrlKey: true,
      shiftKey: true,
      target: { tagName: "TEXTAREA" } as unknown as EventTarget,
    });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: true, preventDefault: true });
    expect(spies.calls).toEqual(["onToggleRightCollapse"]);
  });

  test("Non-catalog Ctrl+A inside TEXTAREA does not match (default text-field guard still applies for unrelated keys)", () => {
    const spies = makeSpies();
    const e = makeEvent({
      key: "a",
      ctrlKey: true,
      target: { tagName: "TEXTAREA" } as unknown as EventTarget,
    });
    const result = dispatchShortcut(e, spies.handlers);
    expect(result).toEqual({ matched: false, preventDefault: false });
    expect(spies.calls).toEqual([]);
  });
});
