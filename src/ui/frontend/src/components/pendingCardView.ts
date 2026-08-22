/**
 * Pure view-helpers for the pending pane's network and host-exec cards.
 *
 * These functions translate normalized pending rows into the small
 * presentation strings rendered by `PendingPane`. Keeping them as pure
 * functions (no Solid primitives, no DOM access, `now` taken as an
 * argument) lets them be unit-tested in isolation and lets the caller
 * drive re-renders by ticking a clock signal.
 */

import type { BodyDiagnostic } from "../stores/types";

/**
 * Format the broker-selected indeterminate cause using only its closed,
 * body-safe metadata. No raw request body or parser error is available here.
 */
export function formatBodyDiagnostic(diagnostic: BodyDiagnostic): string {
  switch (diagnostic.code) {
    case "body-unreadable":
      return "Request body could not be read.";
    case "body-too-large":
      return `Body was ${diagnostic.byteLength} bytes; the body evaluation limit was ${diagnostic.maxBodyBytes} bytes.`;
    case "invalid-json":
      return "Request body was not valid JSON.";
    case "empty-json-body":
      return "Request body was empty, but this rule requires JSON.";
    case "non-scalar-at-pointer":
      return `JSON pointer ${diagnostic.pointer} resolved to an object/array, not a scalar.`;
  }
}

/**
 * Format the difference between `targetMs` and `nowMs` as a coarse-grained
 * relative time string (e.g. `"5s ago"`, `"3m ago"`, `"2h ago"`).
 *
 * - `targetMs === null` (ISO parse failure upstream) returns the em dash
 *   placeholder `"—"` so the caller does not need to guard at the call
 *   site.
 * - `nowMs - targetMs` is clamped at zero, so a future `targetMs`
 *   (clock skew, server slightly ahead) renders as `"0s ago"` rather
 *   than a negative count.
 * - The largest unit shown is days; longer ages still render in days.
 */
export function formatRelativeTime(
  targetMs: number | null,
  nowMs: number,
): string {
  if (targetMs === null) return "—";
  const deltaSec = Math.max(0, Math.round((nowMs - targetMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d ago`;
}

/**
 * Build the session identity shown on a pending card.
 *
 * The name is resolved by `App` from the sessions store. Pending rows do not
 * own a copy of it, so renames are reflected from the single source of truth.
 */
export function sessionLabel(
  row: { sessionShortId: string },
  sessionName: string | null | undefined,
): string {
  return sessionName
    ? `${sessionName} · ${row.sessionShortId}`
    : row.sessionShortId;
}

/**
 * State the settlement unit and future lifetime of a network decision.
 *
 * `violations` is used only to keep the violation wording grammatically
 * precise. The broker remains the authority for which scopes a row offers.
 */
export function networkApprovalEffect(
  row: { violations: readonly unknown[] },
  scope: string,
): string {
  switch (scope) {
    case "rule":
      return "Answers the current group and future matching requests in this session for the same rule and fixed target.";
    case "host-port":
      return "Answers the current group and future matching requests in this session for the same rule, host, and port.";
    case "host":
      return "Answers the current group and future matching requests in this session for the same rule and host, on any port.";
    case "violation": {
      const identity =
        row.violations.length === 1
          ? "violation identity"
          : "violation identities";
      return `Answers the current group and future matching requests in this session for the same rule and ${identity} shown here.`;
    }
    default:
      return "Answers this request only. It is not remembered for future requests.";
  }
}

// Why a network confirmation is on screen, in the words of the decision that
// produced it. The keys are the backend's `DecisionReason`
// (`src/network/authz/resolve.ts`); `websocket-denied` is absent because it
// only ever denies, so it never raises a card.
//
// The rule id alone does not answer this question. `anthropic.messages`
// asking to be reviewed and `anthropic.$fallback` catching a path no rule
// claimed are different situations with different fixes — one is the rule
// working as configured, the other is a gap in the configuration — and
// telling them apart by reading the spelling of a pseudo id is not something
// to ask of the person holding the button.
const ASK_REASONS: Record<string, { label: string; hint: string }> = {
  rule: {
    label: "the matched rule asks for review",
    hint: "A rule matched this request and its action for a match is review. Nothing is wrong: the configuration says requests like this one get confirmed.",
  },
  indeterminate: {
    label: "the rule could not be decided on this body",
    hint: "A rule matched the method and path, but whether its body condition holds could not be settled on this request — an unreadable, oversized, or unparseable body — and its action for that case is review. Evaluation stopped there: no wider rule was tried.",
  },
  "scope-fallback": {
    label: "no rule in this scope matched",
    hint: "This host has a scope, but none of the rules in it matched this method and path, so the scope's fallback decided — and it is review. A rule that was meant to cover this endpoint either does not match it or is not there.",
  },
  "network-fallback": {
    label: "no scope covers this host",
    hint: "No scope claims this host, so the document's own fallback decided — and it is review. Nothing has been configured about this host at all.",
  },
};

/**
 * Describe why a pending network card is asking, or `null` when the card
 * does not say.
 *
 * A reason the frontend does not know is passed through as its own label
 * rather than dropped: the vocabulary is the backend's, and a version that
 * added a reason is better served by showing the raw slug than by showing
 * nothing. Violation cards carry no reason — the violations they list are the
 * reason — so `null` in, `null` out.
 */
export function askReasonView(
  reason: string | null,
): { label: string; hint: string } | null {
  if (!reason) return null;
  return ASK_REASONS[reason] ?? { label: reason, hint: "" };
}
