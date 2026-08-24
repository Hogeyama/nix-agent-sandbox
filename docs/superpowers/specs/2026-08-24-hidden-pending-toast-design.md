# Hidden pending approval toast

## Goal

Keep pending approvals visible when the Pending pane is open but filtered to a
different session. The toast must represent only approvals that are not already
visible in the pane.

## User-facing behavior

The toast contents depend on the Pending pane state:

- When the pane is collapsed, every pending approval appears in the toast, as
  it does today.
- When the pane is open and filtered to the active session, approvals from
  other sessions appear in the toast. Approvals from the active session remain
  visible only in the pane and are not duplicated in the toast.
- When the pane is open with `All` selected, no toast appears because every
  pending approval is already visible.
- When no active session exists, the pane already shows all approvals, so no
  toast appears while the pane is open.

The existing Review action remains unchanged: it selects the toast's session,
switches the pane back to the current-session filter, and opens the pane if it
is collapsed.

## Implementation shape

Add a pure selector in `pendingNotificationView.ts` that receives both pending
queues and the pane state. It returns the rows that are hidden from the current
pane view:

1. all rows when the pane is collapsed;
2. rows belonging to sessions other than the active session when the pane is
   open and session-filtered;
3. no rows when the open pane shows all sessions.

`PendingNotifications` will group and count only the selector's result. `App`
will pass the existing collapsed state, active agent session ID, and `All`
selection to the component. No pending-store or backend contract changes are
needed.

## Testing

Unit tests for the pure selector will cover collapsed, open session-filtered,
open `All`, and open-without-an-active-session states. Existing grouping tests
continue to cover toast ordering, counts, and summaries.

## Out of scope

- changing toast layout, copy, or grouping;
- changing Pending pane filtering;
- changing the Review navigation behavior;
- introducing dismissal or read-state tracking;
- changing backend notifications or pending payloads.

## Why — why this approach

The toast is a fallback for approvals hidden by the current pane state, so its
input should be defined directly as the complement of what the pane exposes.
A pure selector makes that rule explicit and independently testable while
keeping pending data ownership in the existing store. It also prevents the
current session's approvals from appearing twice when the pane is open.

## Why Not — why other approaches were rejected

- **Filter rows in `App`** — This would make the top-level component own
  presentation-specific notification rules and make the behavior harder to
  test in isolation.
- **Only broaden the toast's visibility condition** — This would show every
  pending approval when another session is selected, duplicating approvals
  already visible in the open pane.
- **Track toast dismissal or seen state** — The requirement depends only on
  current pane visibility. Persistent notification state would add lifecycle
  complexity without improving the requested behavior.
