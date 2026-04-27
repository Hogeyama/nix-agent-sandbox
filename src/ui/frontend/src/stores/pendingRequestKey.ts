/**
 * Composite identity helper for pending approval rows.
 *
 * Pending requests are uniquely identified by the triple
 * `(domain, sessionId, requestId)` where `domain` is `"network"` or
 * `"hostexec"`. The same `requestId` value can legitimately appear in
 * both domains because the broker namespaces them separately, so any
 * per-row UI state (selected scope, busy flag, error message) keyed by
 * `requestId` alone collides across domains.
 *
 * This helper produces a single stable string key from the triple. The
 * result is suitable as a map key but is not stable wire format and must
 * not be sent to the backend or persisted across schema changes.
 *
 * Delimiter choice: `|`. Both `sessionId` and `requestId` are validated
 * by the backend against `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`
 * (`src/ui/routes/validate_ids.ts`), so neither value can contain `|`.
 * Two distinct `(domain, sessionId, requestId)` triples therefore always
 * produce distinct keys.
 */

export type PendingDomain = "network" | "hostexec";

export function pendingRequestKey(
  domain: PendingDomain,
  sessionId: string,
  requestId: string,
): string {
  return `${domain}|${sessionId}|${requestId}`;
}
