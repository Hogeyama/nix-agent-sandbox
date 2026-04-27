/**
 * Input glue between the surrounding DOM and an xterm `Terminal` instance.
 *
 * Two responsibilities:
 *
 *   - Forward a small, fixed set of `Ctrl+<key>` shortcuts (`Ctrl+a`,
 *     `Ctrl+e`, `Ctrl+w`) into the terminal even though the browser
 *     would otherwise consume them. Without this, common shell line
 *     editing keys are stolen by the page.
 *
 *   - Keep focus inside the xterm hidden textarea. xterm exposes its
 *     keyboard surface via a hidden `.xterm-helper-textarea`; clicks on
 *     padding or container chrome can move focus elsewhere, so this
 *     module re-asserts focus after every container mousedown and on
 *     contextmenu.
 *
 * The module is framework-agnostic — every dependency comes in as a
 * function argument so the file can be used both from framework code
 * and from headless tests.
 */

import type { Terminal } from "@xterm/xterm";

const FORWARDED_CTRL_KEYS = new Set(["a", "e", "w"]);

function shouldForwardCtrlShortcut(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") return false;
  if (!event.ctrlKey || event.altKey || event.metaKey) return false;
  return FORWARDED_CTRL_KEYS.has(event.key.toLowerCase());
}

/**
 * True when the active element is the hidden textarea xterm uses to
 * receive keystrokes.
 */
function isTerminalFocused(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement &&
    active.classList.contains("xterm-helper-textarea")
  );
}

/**
 * Idempotent focus call: only invokes `term.focus()` when the document's
 * current focus is not already the xterm helper textarea, to avoid the
 * cost (and visible cursor flicker) of redundant focus().
 */
export function ensureTerminalFocus(term: Terminal): void {
  if (!isTerminalFocused()) {
    term.focus();
  }
}

export function setupTerminalInputForwarding(
  term: Terminal,
  container: HTMLElement,
  extraKeyHandler?: (event: KeyboardEvent) => boolean,
): () => void {
  term.attachCustomKeyEventHandler((event) => {
    if (extraKeyHandler && extraKeyHandler(event) === false) {
      return false;
    }
    if (shouldForwardCtrlShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
    return true;
  });

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    term.focus();
  };
  container.addEventListener("contextmenu", onContextMenu);

  // Mousedown on the container (including padding around the canvas)
  // should snap focus back to xterm. Use rAF so the click's own focus
  // resolution finishes before we re-assert.
  const onMouseDown = (_event: MouseEvent) => {
    requestAnimationFrame(() => ensureTerminalFocus(term));
  };
  container.addEventListener("mousedown", onMouseDown);

  return () => {
    container.removeEventListener("contextmenu", onContextMenu);
    container.removeEventListener("mousedown", onMouseDown);
  };
}
