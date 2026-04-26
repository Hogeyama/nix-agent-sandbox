import { describe, expect, test } from "bun:test";
import { type KeyboardEventLike, matchShortcut } from "./matchShortcut";

function makeEvent(opts: Partial<KeyboardEventLike> = {}): KeyboardEventLike {
  return {
    key: "]",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    target: null,
    ...opts,
  };
}

describe("matchShortcut", () => {
  test("Ctrl+Shift+] matches when modifiers and key align", () => {
    const e = makeEvent({ key: "]", ctrlKey: true, shiftKey: true });
    expect(matchShortcut(e, { ctrl: true, shift: true, key: "]" })).toBe(true);
  });

  test("Ctrl+] without shift does not match Ctrl+Shift+]", () => {
    const e = makeEvent({ key: "]", ctrlKey: true, shiftKey: false });
    expect(matchShortcut(e, { ctrl: true, shift: true, key: "]" })).toBe(false);
  });

  test("Ctrl+Shift+] does not match when target is INPUT", () => {
    const e = makeEvent({
      key: "]",
      ctrlKey: true,
      shiftKey: true,
      target: { tagName: "INPUT" } as unknown as EventTarget,
    });
    expect(matchShortcut(e, { ctrl: true, shift: true, key: "]" })).toBe(false);
  });

  test("Ctrl+Shift+] does not match when target is contenteditable", () => {
    const e = makeEvent({
      key: "]",
      ctrlKey: true,
      shiftKey: true,
      target: {
        tagName: "DIV",
        isContentEditable: true,
      } as unknown as EventTarget,
    });
    expect(matchShortcut(e, { ctrl: true, shift: true, key: "]" })).toBe(false);
  });

  test("Plain ] does not match Ctrl+Shift+]", () => {
    const e = makeEvent({ key: "]", ctrlKey: false, shiftKey: false });
    expect(matchShortcut(e, { ctrl: true, shift: true, key: "]" })).toBe(false);
  });
});
