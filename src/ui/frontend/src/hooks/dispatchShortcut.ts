/**
 * Pure shortcut dispatcher driving the document-level keyboard hook.
 *
 * The dispatcher treats `keybindsCatalog.ts` as the single source of
 * truth: every catalog entry that carries a non-null `ShortcutSpec` is
 * matched via `matchShortcut(e, spec)` and routed by entry id to the
 * matching handler. Catalog rows whose spec cannot be expressed as a
 * single keystroke (`session.switch` / `pane.toggleCollapse`) are
 * dispatched through hard-coded code paths defined here.
 *
 * Hard-coded paths:
 *
 *   - `Ctrl+1..9` (`session.switch`) is a key range that a single
 *     `ShortcutSpec` cannot express, so the dispatcher matches the
 *     digit class directly and forwards the parsed 1-based index.
 *   - `Ctrl+Shift+]` (`pane.toggleCollapse`) is half of an asymmetric
 *     pair: the left pane is not collapsible per docs/ui-redesign.md
 *     §6.1, so `Ctrl+Shift+[` is intentionally a no-op here. Pinned
 *     by the test "Ctrl+Shift+[ does not match (left pane non-collapsible)".
 *
 * Per docs/ui-redesign.md §8 the global shortcuts must keep working
 * while the xterm textarea (or any other text input) holds focus. The
 * spec-bearing entries opt in via `allowInTextField: true` on their
 * `ShortcutSpec`, and the two hard-coded paths bypass the text-field
 * guard explicitly by not consulting `e.target` at all. Non-catalog
 * keys still fall back to the matchShortcut text-field guard.
 *
 * `matchShortcut` does not consider `metaKey`, and the hard-coded paths
 * follow the same convention so that catalog-driven and hard-coded
 * shortcuts match Ctrl-prefixed events identically regardless of
 * whether `metaKey` is also held.
 *
 * The dispatcher is a pure function: it takes a `KeyboardEventLike`
 * and a `ShortcutHandlers` bag (every handler optional) and returns
 * `{ matched, preventDefault }`. The caller is responsible for invoking
 * `preventDefault()` on the real DOM event when `preventDefault` is
 * true. When a shortcut is matched but no handler is provided, the
 * dispatcher reports `matched: true, preventDefault: false` so the
 * key falls through to the default browser behaviour.
 */

import { SHORTCUTS } from "../components/settings/keybindsCatalog";
import { type KeyboardEventLike, matchShortcut } from "./matchShortcut";

export interface ShortcutHandlers {
  onNewSession?: () => void;
  /** 1-based index. Called with values 1 through 9 inclusive. */
  onSelectSessionByIndex?: (index: number) => void;
  onApproveSelected?: () => void;
  onDenySelected?: () => void;
  onToggleRightCollapse?: () => void;
  onOpenSettings?: () => void;
  onOpenShortcuts?: () => void;
}

export interface DispatchResult {
  matched: boolean;
  preventDefault: boolean;
}

const NO_MATCH: DispatchResult = { matched: false, preventDefault: false };

/**
 * Dispatch a keyboard event to the matching handler in `handlers`.
 *
 * Returns `{ matched, preventDefault }`. When `preventDefault` is true
 * the caller must call `e.preventDefault()` on the real DOM event.
 */
export function dispatchShortcut(
  e: KeyboardEventLike,
  handlers: ShortcutHandlers,
): DispatchResult {
  // Catalog-driven path: spec-bearing entries dispatch by id.
  for (const entry of SHORTCUTS) {
    if (entry.spec === null) continue;
    if (!matchShortcut(e, entry.spec)) continue;
    return invokeForId(entry.id, handlers);
  }

  // Hard-coded path: Ctrl+1..9 (`session.switch`). Bypasses the
  // text-field guard so terminal focus does not swallow the key.
  if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
    const index = Number.parseInt(e.key, 10);
    if (handlers.onSelectSessionByIndex !== undefined) {
      handlers.onSelectSessionByIndex(index);
      return { matched: true, preventDefault: true };
    }
    return { matched: true, preventDefault: false };
  }

  // Hard-coded path: Ctrl+Shift+] (`pane.toggleCollapse`). Bypasses
  // the text-field guard for the same reason as above. Ctrl+Shift+[
  // is intentionally not handled because the left pane does not
  // support collapsing (docs/ui-redesign.md §6.1).
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === "]") {
    if (handlers.onToggleRightCollapse !== undefined) {
      handlers.onToggleRightCollapse();
      return { matched: true, preventDefault: true };
    }
    return { matched: true, preventDefault: false };
  }

  return NO_MATCH;
}

/**
 * Route a matched catalog id to the corresponding handler. Centralises
 * the id → handler mapping so a missing case becomes a TypeScript
 * error via the exhaustive `default` branch.
 */
function invokeForId(id: string, handlers: ShortcutHandlers): DispatchResult {
  switch (id) {
    case "session.new":
      return runIfPresent(handlers.onNewSession);
    case "action.approve":
      return runIfPresent(handlers.onApproveSelected);
    case "action.deny":
      return runIfPresent(handlers.onDenySelected);
    case "settings.open":
      return runIfPresent(handlers.onOpenSettings);
    case "settings.shortcuts":
      return runIfPresent(handlers.onOpenShortcuts);
    default:
      // Catalog rows with a non-null spec that we have not wired up
      // here are still reported as matched=false so the key falls
      // through to the browser default. New spec-bearing rows must
      // add a case above; the catalog test pins the id list.
      return NO_MATCH;
  }
}

function runIfPresent(handler: (() => void) | undefined): DispatchResult {
  if (handler === undefined) {
    return { matched: true, preventDefault: false };
  }
  handler();
  return { matched: true, preventDefault: true };
}
