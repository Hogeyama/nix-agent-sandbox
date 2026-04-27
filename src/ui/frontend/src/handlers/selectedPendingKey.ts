/**
 * Resolve the pending row that `Ctrl+Shift+A` / `Ctrl+Shift+D` should
 * act on.
 *
 * The shortcut targets the focused pending card when one exists, falling
 * back to the first network row, then the first hostexec row. The
 * three-step fallback (focused card → network[0] → hostexec[0]) keeps
 * the shortcut useful even when focus is on the terminal or another
 * pane that does not own a pending card.
 *
 * When the right pane is collapsed the function returns `null`
 * regardless of focus or queue contents: the user cannot see which row
 * would be approved/denied while the pane is hidden, so the shortcut
 * is a no-op rather than acting on a card the user has not seen.
 *
 * Scope selection is delegated to the caller. `selectPendingTarget` is
 * state-less: it picks the row, and the caller layers
 * `pendingActionStore.scopeFor(row.key)` (with the appropriate per-domain
 * default) on top.
 */

import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";

export type PendingTarget =
  | { kind: "network"; row: NetworkPendingRow }
  | { kind: "hostexec"; row: HostExecPendingRow };

export interface SelectPendingArgs {
  activeElement: Element | null;
  network: NetworkPendingRow[];
  hostexec: HostExecPendingRow[];
  collapsed: boolean;
}

const PENDING_KEY_ATTR = "data-pending-key";
const PENDING_KEY_SELECTOR = "[data-pending-key]";

export function selectPendingTarget(
  args: SelectPendingArgs,
): PendingTarget | null {
  if (args.collapsed) return null;

  const focusedKey = readFocusedPendingKey(args.activeElement);
  if (focusedKey !== null) {
    const networkHit = args.network.find((row) => row.key === focusedKey);
    if (networkHit !== undefined) {
      return { kind: "network", row: networkHit };
    }
    const hostexecHit = args.hostexec.find((row) => row.key === focusedKey);
    if (hostexecHit !== undefined) {
      return { kind: "hostexec", row: hostexecHit };
    }
    // Stale focus (the focused element's key no longer matches any
    // queue entry) falls through to the head-of-queue fallback below.
  }

  const networkHead = args.network[0];
  if (networkHead !== undefined) {
    return { kind: "network", row: networkHead };
  }
  const hostexecHead = args.hostexec[0];
  if (hostexecHead !== undefined) {
    return { kind: "hostexec", row: hostexecHead };
  }
  return null;
}

function readFocusedPendingKey(activeElement: Element | null): string | null {
  if (activeElement === null) return null;
  const card = activeElement.closest(PENDING_KEY_SELECTOR);
  if (card === null) return null;
  return card.getAttribute(PENDING_KEY_ATTR);
}
