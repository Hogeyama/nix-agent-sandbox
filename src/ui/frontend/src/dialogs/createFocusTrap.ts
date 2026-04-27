/**
 * Focus-trap helper for modal dialogs.
 *
 * Cycles `Tab` / `Shift+Tab` within the dialog root so keyboard navigation
 * cannot escape the modal, places initial focus on `activate()`, and
 * restores focus to whatever was active before the dialog opened on
 * `deactivate()`.
 *
 * `Esc` is intentionally not handled here: dialogs already register their
 * own dismissal handler, so the trap only needs to capture `Tab`.
 *
 * `previouslyFocused` is captured the first time `activate()` runs and
 * is preserved across redundant `activate()` calls. Once the trap is
 * active focus lives inside the dialog, so a second `activate()` would
 * otherwise overwrite the opener with the dialog itself and lose the
 * restore target. Idempotent activation matches the caller pattern of
 * scheduling activation through a microtask that may race with the
 * `open()` signal flipping back and forth.
 *
 * The DI seams (`getRoot`, `getActiveElement`, `setFocus`,
 * `getInitialFocus`) let the trap be exercised as a pure function from
 * `bun:test` without a DOM: callers pass structural doubles that
 * implement only the methods the trap touches.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type FocusTrapDeps = {
  /** Returns the dialog root element, or null if not yet mounted. */
  getRoot: () => HTMLElement | null;
  /**
   * Optional preferred element to receive focus on `activate()`. When it
   * returns null (or the dep is omitted), the trap falls back to the
   * first focusable element inside the root.
   */
  getInitialFocus?: () => HTMLElement | null;
  /** Returns the currently focused element. Defaults to `document.activeElement` in the host. */
  getActiveElement: () => Element | null;
  /** Moves focus to the given element. Defaults to `el.focus()` in the host. */
  setFocus: (el: HTMLElement) => void;
};

export type FocusTrap = {
  activate: () => void;
  deactivate: () => void;
  handleKeyDown: (e: KeyboardEvent) => void;
};

export function createFocusTrap(deps: FocusTrapDeps): FocusTrap {
  let previouslyFocused: HTMLElement | null = null;

  function listFocusable(): HTMLElement[] {
    const root = deps.getRoot();
    if (root === null) return [];
    const nodes = root.querySelectorAll(FOCUSABLE_SELECTOR);
    return Array.from(nodes) as HTMLElement[];
  }

  function activate(): void {
    if (previouslyFocused === null) {
      // Capture only on the first activation so a redundant `activate()`
      // (e.g. fired by a re-running effect after focus has already moved
      // into the dialog) cannot overwrite the opener with an element
      // inside the dialog.
      const active = deps.getActiveElement();
      previouslyFocused = isHTMLElement(active) ? active : null;
    }

    const preferred = deps.getInitialFocus?.() ?? null;
    if (preferred !== null) {
      deps.setFocus(preferred);
      return;
    }
    const focusables = listFocusable();
    const first = focusables[0];
    if (first !== undefined) {
      deps.setFocus(first);
    }
  }

  function deactivate(): void {
    const target = previouslyFocused;
    previouslyFocused = null;
    if (target !== null) {
      deps.setFocus(target);
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Tab") return;
    const focusables = listFocusable();
    if (focusables.length === 0) {
      // Focus has nowhere to go inside the dialog. Swallow the Tab so
      // browser default cannot move focus to the page behind the modal.
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) return;
    const active = deps.getActiveElement();

    if (e.shiftKey) {
      if (active === first) {
        e.preventDefault();
        deps.setFocus(last);
      }
      return;
    }
    if (active === last) {
      e.preventDefault();
      deps.setFocus(first);
    }
  }

  return { activate, deactivate, handleKeyDown };
}

function isHTMLElement(value: Element | null): value is HTMLElement {
  // Structural check: anything with `focus()` is treatable as an
  // HTMLElement for restore purposes. This keeps the helper testable
  // without leaning on `instanceof HTMLElement` (which would require a
  // real DOM in unit tests).
  if (value === null) return false;
  return typeof (value as { focus?: unknown }).focus === "function";
}
