# Hostexec approval card clarity

## Goal

Make a hostexec approval understandable without knowing the broker term
`capability`. The card must say what each action affects, show the exact
conditions remembered by a session-wide approval, and initialize its choice
from the broker configuration that produced the pending request.

This change only clarifies the existing hostexec approval semantics. It does
not change capability-key construction, approval grouping, denial behavior,
or session lifetime.

## User-facing design

The hostexec card groups the scope selector with Approve under an
`Approve scope` label. The two choices are:

- `This request only`
- `Matching command for this session`

The wire values remain `once` and `capability`; `capability` is not shown as a
user-facing term.

Below the choices, the card always states the effect of the selected approval:

- `This request only` approves only the card that was clicked and remembers
  nothing.
- `Matching command for this session` resolves all requests currently waiting
  on the same exact conditions and remembers those conditions for future
  requests in the same session.

The card always shows the conditions that define a match:

- rule ID
- executable and all arguments
- normalized working directory
- injected environment bindings, as variable name and configured source
- inherited-environment mode and inherited variable names

Approve remains the only action affected by the selector. Deny is visually
separated and labeled `Deny this request only`, because denial always resolves
one request and is never remembered.

The pending request's configured `prompt.defaultScope` controls the initial
selection. A pending payload from an older broker lacks this field, so the UI
falls back to `Matching command for this session`, preserving the current UI
behavior during a mixed-version transition.

## Data contract

`HostExecPendingEntry` gains additive fields containing:

- the broker's configured default scope;
- a snapshot of the already-resolved capability identity.

The snapshot reuses the normalized data that the broker already passes to the
capability-key builder. It does not recompute rule matching in the UI and does
not expose the opaque approval-key hash as an explanation.

The existing version remains readable. New fields are optional at the UI
normalization boundary so stale on-disk pending entries and older daemon
payloads continue to render. Newly created broker entries always include the
fields.

## Security boundary

The pending snapshot contains environment variable names and configured
sources only. It never contains resolved environment values, secret values,
or host environment contents. The data stays on the existing host-only
pending/control path; no new container mount, socket, or endpoint is added.

This preserves the repository's security constraints: secret resolution stays
host-side, the control socket remains unavailable to the container, and the
UI receives only metadata already used to form the approval identity.

## Implementation shape

1. Extend broker pending-entry construction with the configured default scope
   and resolved match metadata.
2. Preserve and normalize those fields in the frontend pending store, with the
   compatibility fallback for older payloads.
3. Add pure view helpers for human-readable labels and effect text.
4. Restructure only the hostexec portion of `PendingPane` and add narrow-pane
   wrapping styles where necessary.
5. Cover broker serialization, store normalization, view copy, and action
   semantics with Bun unit/integration tests as appropriate.

## Out of scope

- changing the `once` or `capability` wire vocabulary
- changing how capability keys are calculated
- caching denials or making Deny scope-sensitive
- redesigning network approval cards or the full pending pane
- adding notification deep links or approval keyboard shortcuts
- exposing resolved environment or secret values

## Why — why this approach

The broker is the only component that knows the exact resolved identity and
the effective default scope. Sending a safe snapshot from that authority lets
the UI explain precisely what will be remembered without duplicating config
loading or rule resolution. Additive fields also allow the UI and daemon to be
updated without making old pending files unreadable.

Plain action-oriented labels answer the user's decision directly. Keeping the
wire term internal avoids weakening the backend model merely to improve copy.

## Why Not — why other approaches were rejected

- **Rename labels only** — This hides the jargon but still cannot explain which
  command conditions match or honor `prompt.defaultScope`.
- **Have the UI reload profile configuration** — That duplicates config and
  rule resolution outside the broker and can describe a different state from
  the one that actually created the pending request.
- **Show the approval-key hash** — The hash proves identity to the broker but
  gives a person no evidence about what they are approving.
