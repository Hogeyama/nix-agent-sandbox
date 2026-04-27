/**
 * Tests for `createFocusTrap`.
 *
 * Pins the activate / deactivate / Tab-cycle contract using structural
 * doubles for `HTMLElement` and the dialog root: the trap only touches
 * `querySelectorAll` on the root and `focus()` (via `setFocus`) on
 * elements, so we can drive it without a real DOM.
 */

import { describe, expect, test } from "bun:test";
import { createFocusTrap } from "./createFocusTrap";

type FakeEl = HTMLElement & { __id: string };

function makeEl(id: string): FakeEl {
  const el = {
    __id: id,
    focus: () => {},
  } as unknown as FakeEl;
  return el;
}

function makeRoot(focusables: FakeEl[]): HTMLElement {
  return {
    querySelectorAll: (_selector: string) =>
      ({
        length: focusables.length,
        [Symbol.iterator]: function* () {
          for (const f of focusables) yield f;
        },
        forEach: (cb: (el: FakeEl) => void) => {
          for (const f of focusables) cb(f);
        },
      }) as unknown as NodeListOf<HTMLElement>,
  } as unknown as HTMLElement;
}

function makeFocusKeyEvent(opts: {
  key: string;
  shiftKey?: boolean;
}): KeyboardEvent {
  let prevented = false;
  return {
    key: opts.key,
    shiftKey: opts.shiftKey === true,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as KeyboardEvent;
}

describe("createFocusTrap", () => {
  test("activate focuses getInitialFocus result when non-null", () => {
    const a = makeEl("a");
    const b = makeEl("b");
    const c = makeEl("c");
    const root = makeRoot([a, b, c]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getInitialFocus: () => b,
      getActiveElement: () => null,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    trap.activate();
    expect(focused.map((e) => e.__id)).toEqual(["b"]);
  });

  test("activate falls back to first focusable when getInitialFocus returns null", () => {
    const a = makeEl("a");
    const b = makeEl("b");
    const root = makeRoot([a, b]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getInitialFocus: () => null,
      getActiveElement: () => null,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    trap.activate();
    expect(focused.map((e) => e.__id)).toEqual(["a"]);
  });

  test("deactivate restores focus to the element active at activate() time", () => {
    const opener = makeEl("opener");
    const a = makeEl("a");
    const root = makeRoot([a]);
    const focused: FakeEl[] = [];
    let active: Element | null = opener;
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => active,
      setFocus: (el) => {
        focused.push(el as FakeEl);
        active = el;
      },
    });
    trap.activate();
    // After activate(), focus is on `a`. The opener still needs to be
    // restored on deactivate.
    expect(focused.map((e) => e.__id)).toEqual(["a"]);
    trap.deactivate();
    expect(focused.map((e) => e.__id)).toEqual(["a", "opener"]);
  });

  test("deactivate is a no-op when activeElement was null at activate() time", () => {
    const a = makeEl("a");
    const root = makeRoot([a]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => null,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    trap.activate();
    expect(focused.map((e) => e.__id)).toEqual(["a"]);
    trap.deactivate();
    // No additional focus call: no opener to restore to.
    expect(focused.map((e) => e.__id)).toEqual(["a"]);
  });

  test("Tab on the last focusable wraps to the first (preventDefault + setFocus)", () => {
    const a = makeEl("a");
    const b = makeEl("b");
    const c = makeEl("c");
    const root = makeRoot([a, b, c]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => c,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    const e = makeFocusKeyEvent({ key: "Tab" });
    trap.handleKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(focused.map((x) => x.__id)).toEqual(["a"]);
  });

  test("Shift+Tab on the first focusable wraps to the last (preventDefault + setFocus)", () => {
    const a = makeEl("a");
    const b = makeEl("b");
    const c = makeEl("c");
    const root = makeRoot([a, b, c]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => a,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    const e = makeFocusKeyEvent({ key: "Tab", shiftKey: true });
    trap.handleKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(focused.map((x) => x.__id)).toEqual(["c"]);
  });

  test("Tab on a middle focusable lets the browser handle it (no preventDefault, no setFocus)", () => {
    const a = makeEl("a");
    const b = makeEl("b");
    const c = makeEl("c");
    const root = makeRoot([a, b, c]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => b,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    const e = makeFocusKeyEvent({ key: "Tab" });
    trap.handleKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(focused).toEqual([]);
  });

  test("non-Tab keys are ignored entirely", () => {
    const a = makeEl("a");
    const root = makeRoot([a]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => a,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    const e = makeFocusKeyEvent({ key: "Escape" });
    trap.handleKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(focused).toEqual([]);
  });

  test("Tab with no focusables in the root preventDefaults but does not setFocus", () => {
    const root = makeRoot([]);
    const focused: FakeEl[] = [];
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => null,
      setFocus: (el) => focused.push(el as FakeEl),
    });
    const e = makeFocusKeyEvent({ key: "Tab" });
    trap.handleKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(focused).toEqual([]);
  });

  test("activate twice keeps the opener captured at the first activate as the restore target", () => {
    const opener = makeEl("opener");
    const a = makeEl("a");
    const root = makeRoot([a]);
    const focused: FakeEl[] = [];
    let active: Element | null = opener;
    const trap = createFocusTrap({
      getRoot: () => root,
      getActiveElement: () => active,
      setFocus: (el) => {
        focused.push(el as FakeEl);
        active = el;
      },
    });
    // First activate: opener is the activeElement and gets captured.
    trap.activate();
    expect(focused.map((e) => e.__id)).toEqual(["a"]);
    // Second activate: focus is now on `a` (inside the dialog). A naive
    // implementation would overwrite `previouslyFocused` with `a`, so
    // deactivate would restore focus to the dialog itself. We require
    // the opener to survive.
    trap.activate();
    expect(focused.map((e) => e.__id)).toEqual(["a", "a"]);
    trap.deactivate();
    expect(focused.map((e) => e.__id)).toEqual(["a", "a", "opener"]);
  });
});
