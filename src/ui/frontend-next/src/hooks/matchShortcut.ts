/**
 * Pure shortcut-matcher used by `useGlobalKeyboard`.
 *
 * The function takes a structurally-typed `KeyboardEventLike` instead of
 * the DOM `KeyboardEvent` so it can be unit-tested without a browser
 * runtime. It also guards INPUT / TEXTAREA / contenteditable targets so
 * shortcuts never compete with user typing inside a form field; the
 * xterm input area is a `<textarea>` so this guard also prevents the
 * shortcut from firing while the terminal is focused.
 */

export interface ShortcutSpec {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}

export function matchShortcut(
  e: KeyboardEventLike,
  spec: ShortcutSpec,
): boolean {
  // Duck-type the target so the helper stays usable from a non-browser
  // runtime (`bun:test`) where `HTMLElement` is not defined globally.
  // The fields read here exist on `HTMLElement` and on plain test
  // doubles alike.
  const target = e.target as {
    tagName?: unknown;
    isContentEditable?: unknown;
  } | null;
  if (target) {
    const tagName =
      typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
    if (
      tagName === "INPUT" ||
      tagName === "TEXTAREA" ||
      target.isContentEditable === true
    ) {
      return false;
    }
  }
  if (spec.ctrl !== undefined && e.ctrlKey !== spec.ctrl) return false;
  if (spec.shift !== undefined && e.shiftKey !== spec.shift) return false;
  if (spec.alt !== undefined && e.altKey !== spec.alt) return false;
  return e.key === spec.key;
}
