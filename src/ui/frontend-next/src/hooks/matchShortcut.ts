/**
 * Pure shortcut-matcher used by `useGlobalKeyboard`.
 *
 * The function takes a structurally-typed `KeyboardEventLike` instead of
 * the DOM `KeyboardEvent` so it can be unit-tested without a browser
 * runtime. By default it guards INPUT / TEXTAREA / contenteditable
 * targets so shortcuts never compete with user typing inside a form
 * field; the xterm input area is a `<textarea>` so this guard also
 * prevents the shortcut from firing while the terminal is focused.
 *
 * Some global shortcuts (e.g. `Ctrl+Shift+` prefixed pane controls) must
 * stay reachable while the terminal is focused. Specs that opt in with
 * `allowInTextField: true` bypass the text-field guard and are matched
 * even when the event target is an INPUT / TEXTAREA / contenteditable
 * element. All other guards (modifier keys, key comparison) still apply.
 */

export interface ShortcutSpec {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
  /**
   * When true, the matcher does not bail out on INPUT / TEXTAREA /
   * contenteditable targets. Use for shortcuts that must remain active
   * while the xterm textarea (or any other text input) holds focus.
   */
  allowInTextField?: boolean;
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
  if (!spec.allowInTextField) {
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
  }
  if (spec.ctrl !== undefined && e.ctrlKey !== spec.ctrl) return false;
  if (spec.shift !== undefined && e.shiftKey !== spec.shift) return false;
  if (spec.alt !== undefined && e.altKey !== spec.alt) return false;
  return e.key === spec.key;
}
