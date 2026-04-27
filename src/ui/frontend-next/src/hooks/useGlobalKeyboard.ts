/**
 * Document-level keyboard hook.
 *
 * The hook registers a single `keydown` listener on `document` so the
 * dispatcher fires regardless of which pane has focus. The actual
 * routing is delegated to `dispatchShortcut`, which treats
 * `keybindsCatalog.ts` as the source of truth and reports back whether
 * the event matched a shortcut and whether the caller should call
 * `preventDefault()`.
 *
 * The text-field guard lives inside `dispatchShortcut` (and inside
 * `matchShortcut` for spec-bearing entries): catalog specs that opt in
 * via `allowInTextField: true` and the hard-coded `Ctrl+1..9` /
 * `Ctrl+Shift+]` paths stay reachable while the xterm textarea (or any
 * other text input) holds focus, while non-catalog keys still bail out
 * on INPUT / TEXTAREA / contenteditable targets via `matchShortcut`'s
 * default guard.
 *
 * The handlers bag is passed through unchanged. Every handler is
 * optional, so callers can wire up only the shortcuts they own; a
 * missing handler is a silent no-op rather than an error.
 *
 * The listener is registered on mount and removed on cleanup so a hot
 * reload or component teardown cannot leak handlers. Document-level
 * keydown is registered without capture so the xterm helper textarea
 * sees the event first; UI shortcuts opt into `allowInTextField` to
 * stay reachable.
 */

import { onCleanup, onMount } from "solid-js";
import { dispatchShortcut, type ShortcutHandlers } from "./dispatchShortcut";

export type { ShortcutHandlers } from "./dispatchShortcut";

export function useGlobalKeyboard(handlers: ShortcutHandlers): void {
  const handler = (e: KeyboardEvent) => {
    const result = dispatchShortcut(e, handlers);
    if (result.preventDefault) {
      e.preventDefault();
    }
  };
  onMount(() => {
    document.addEventListener("keydown", handler);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", handler);
  });
}
