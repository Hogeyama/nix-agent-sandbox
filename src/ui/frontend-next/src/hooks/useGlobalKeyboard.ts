/**
 * Document-level keyboard hook.
 *
 * The handler runs at the document level so it fires regardless of
 * which pane has focus, but `matchShortcut` filters out events whose
 * target is an INPUT, TEXTAREA, or contenteditable element so the
 * shortcut never competes with user typing (xterm focuses a TEXTAREA).
 *
 * The listener is registered on mount and removed on cleanup so a hot
 * reload or component teardown cannot leak handlers.
 */

import { onCleanup, onMount } from "solid-js";
import { matchShortcut } from "./matchShortcut";

export interface GlobalKeyboardOptions {
  onToggleRightCollapse: () => void;
}

export function useGlobalKeyboard(opts: GlobalKeyboardOptions): void {
  const handler = (e: KeyboardEvent) => {
    if (matchShortcut(e, { ctrl: true, shift: true, key: "]" })) {
      e.preventDefault();
      opts.onToggleRightCollapse();
    }
  };
  onMount(() => {
    document.addEventListener("keydown", handler);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", handler);
  });
}
