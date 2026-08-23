# Approval UI Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approval cards identify the session, state the exact approval unit/lifetime, show the concrete indeterminate cause and raw request body, and retain exact bodies in host SQLite only when configured.

**Architecture:** Deliver four vertical changes in UI priority order. Keep the existing v1 one-line broker protocol and existing broker groups; correct `once` to settle one request, add one closed diagnostic map, and carry one bounded base64 capture on `authorize`. Store BLOBs in one separate audit table and fetch them lazily through the existing audit domain service.

**Tech Stack:** Bun/TypeScript, SolidJS, bun:sqlite, Python mitmproxy addon, Pkl.

## Global Constraints

- Every production change maps directly to R2, R3, R4, or R5 in `docs/superpowers/specs/2026-08-22-approval-ui-restart-design.md`.
- `once` means exactly the selected `requestId`; sibling requests in the internal group stay pending.
- Raw capture defaults off and never enters SSE, pending JSON, audit list JSON, logs, or notifications.
- Raw bytes are captured before masking/rewriting/injection and stored only in host `audit.db`.
- No new framing protocol, generic approval-effect model, lifecycle manager, or UI regrouping.
- Tests are written and observed RED before production edits. Review fixes are folded into the owning task commit.
- The approved spec and this plan are not changed during implementation. A contract mismatch is recorded in the ledger and execution stops for reduction/replan.

## File map

- `src/network/broker.ts`, `src/hostexec/broker.ts`: preserve groups but settle one waiter for `once`.
- `src/network/protocol.ts`: closed diagnostic/capture/status wire fields and validation.
- `src/docker/mitmproxy/nas_addon.py`: derive diagnostics and bounded raw capture; send capture only on `authorize`.
- `src/config/Schema.pkl`, `src/config/types.ts`, `src/network/authz/config.ts`: request-body audit config and defaults.
- `src/stages/proxy/stage.ts`, `src/stages/proxy/session_broker_service.ts`: pass resolved capture config to registry and broker without adding stage I/O.
- `src/audit/store.ts`, `src/audit/types.ts`: separate BLOB table, retention/capacity, metadata-only audit rows.
- `src/domain/audit/service.ts`, `src/ui/data.ts`, `src/ui/routes/api.ts`: lazy host-side body lookup.
- `src/ui/frontend/src/{App.tsx,components/PendingPane.tsx,components/settings/AuditPage.tsx,components/RequestBodyPanel.tsx,components/pendingCardView.ts,stores/{types.ts,pendingStore.ts,auditStore.ts},api/client.ts}`: display identity/effect/diagnostic/status and lazy body.
- Colocated `*_test.ts` / `*integration_test.ts` and `src/docker/mitmproxy/nas_addon_test.ts`: own each behavior.

---

### Task 1: Correct `once` and show session/scope meaning (R2, R3)

**Files:**
- Modify: `src/network/broker.ts`
- Modify: `src/network/broker_integration_test.ts`
- Modify: `src/hostexec/broker.ts`
- Modify: `src/hostexec/broker_integration_test.ts`
- Modify: `src/ui/frontend/src/App.tsx`
- Modify: `src/ui/frontend/src/components/PendingPane.tsx`
- Modify: `src/ui/frontend/src/components/pendingCardView.ts`
- Modify: `src/ui/frontend/src/components/pendingCardView_test.ts`

**Interfaces:**
- Consumes: existing `approvalScopes`, session rows, broker group maps.
- Produces: `sessionLabel(row, name)` and `networkApprovalEffect(row, scope)` presentation helpers; request-only settlement for `once`.

- [ ] **Step 1: Write RED broker tests for request-only `once`**

Create two same-group requests. Approve the first with `once`; assert only its response settles and only its pending file disappears. Assert the second remains pending and can be independently denied/approved. Repeat the invariant for hostexec `once` approve and the unscoped hostexec Deny button.

```ts
expect(await approve("req_a", "once")).toEqual({ type: "ack", requestId: "req_a", decision: "approve" });
expect(await pendingIds()).toEqual(["req_b"]);
expect(secondSettled).toBe(false);
```

Run:

```bash
bun test src/network/broker_integration_test.ts src/hostexec/broker_integration_test.ts
```

Expected: FAIL because current `resolveGroup` settles both requests.

- [ ] **Step 2: Implement one-request settlement**

Add a private request settlement path in each broker that removes one request from all group indexes/maps, removes its pending entry, audits and resolves/runs only its waiter, and tears down the group timer/notification only when no requests remain. Route network `scope === "once"`, hostexec approve `selectedScope === "once"`, and hostexec Deny through it. Keep non-`once`, timeout, close, and scope-less network CLI Deny on existing group settlement.

- [ ] **Step 3: Verify broker GREEN**

Run the two broker files again. Expected: PASS, including prior grouped-scope tests after their `once` expectations are corrected.

- [ ] **Step 4: Write RED view-helper tests**

Pin these exact outputs:

```ts
expect(sessionLabel({ sessionShortId: "abc123" }, "auth-refactor"))
  .toBe("auth-refactor · abc123");
expect(networkApprovalEffect(row, "once")).toContain("this request only");
expect(networkApprovalEffect(row, "host-port")).toContain("this session");
expect(networkApprovalEffect(row, "host-port")).toContain("same rule, host, and port");
```

Run `bun test src/ui/frontend/src/components/pendingCardView_test.ts`. Expected: FAIL because the helpers/signatures are absent.

- [ ] **Step 5: Render identity and selected effect**

Pass `sessionNameFor(sessionId)` from `App` to `PendingPane`, derived from `sessions.rows()` without copying names into pending state. Render `name · shortId` on both card types and a visible `This action` sentence under network scope chips using the selected scope. Keep the tooltip as secondary help.

- [ ] **Step 6: Verify Task 1 and commit**

Run:

```bash
bun test src/network/broker_integration_test.ts src/hostexec/broker_integration_test.ts src/ui/frontend/src/components/pendingCardView_test.ts
bun run check
```

Commit all Task 1 files as `fix(approval): make once request-scoped`.

---

### Task 2: Carry the selected indeterminate diagnostic to UI and audit (R4)

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_test.ts`
- Modify: `src/network/protocol.ts`
- Modify: `src/network/protocol_test.ts`
- Modify: `src/network/broker.ts`
- Modify: `src/network/broker_integration_test.ts`
- Modify: `src/audit/types.ts`
- Modify: `src/audit/store.ts`
- Modify: `src/audit/store_integration_test.ts`
- Modify: `src/ui/frontend/src/stores/types.ts`
- Modify: `src/ui/frontend/src/stores/pendingStore.ts`
- Modify: `src/ui/frontend/src/stores/pendingStore_test.ts`
- Modify: `src/ui/frontend/src/components/PendingPane.tsx`
- Modify: `src/ui/frontend/src/components/pendingCardView.ts`
- Modify: `src/ui/frontend/src/components/pendingCardView_test.ts`
- Modify: `src/ui/frontend/src/stores/auditStore.ts`
- Modify: `src/ui/frontend/src/components/settings/AuditPage.tsx`

**Interfaces:**
- Produces:

```ts
type BodyDiagnostic =
  | { code: "body-unreadable" }
  | { code: "body-too-large"; byteLength: number; maxBodyBytes: number }
  | { code: "invalid-json" }
  | { code: "empty-json-body" }
  | { code: "non-scalar-at-pointer"; pointer: string };
```

`AuthorizeRequest.bodyDiagnostics` is a rule-ID map; `PendingEntry.bodyDiagnostic` and `AuditLogEntry.bodyDiagnostic` contain only the broker-selected rule's value.

- [ ] **Step 1: Write RED addon cases**

Extend the existing Python-wrapper test for unreadable, over-limit, malformed JSON, declared-empty JSON, and object-at-scalar-pointer. Assert only closed codes/safe numeric or pointer detail appear; raw parser messages and body text do not.

Run `bun test src/docker/mitmproxy/nas_addon_test.ts`. Expected: FAIL because authorize messages have only `bodyTruth`.

- [ ] **Step 2: Derive rule diagnostics in the existing body-truth pass**

Return truth plus optional diagnostic from the existing classification/pointer evaluation, without a second body parse or traversal. Add `bodyDiagnostics` to `_authorize_message`.

- [ ] **Step 3: Write RED TypeScript validator/broker/audit tests**

Assert validation rejects unknown codes, unsafe extra fields, diagnostics for unknown rule IDs, and mismatched shapes. Assert an `indeterminate` pending entry and its authorization audit contain only the selected rule diagnostic.

Run:

```bash
bun test src/network/protocol_test.ts src/network/broker_integration_test.ts src/audit/store_integration_test.ts
```

Expected: FAIL on missing TypeScript fields/columns.

- [ ] **Step 4: Validate, select, and persist diagnostic metadata**

Add the closed union/validator to protocol v1. In broker, select `message.bodyDiagnostics[decided.ruleId]` only when `decided.reason === "indeterminate"`; put it in the pending entry and authorization audit. Add nullable `body_diagnostic` JSON metadata to `audit_log`, leaving BLOBs out.

- [ ] **Step 5: Write RED frontend tests and render the cause**

Normalize the diagnostic and format an exact safe sentence such as `Body was 9000000 bytes; this rule allows 8388608.` or `JSON pointer /messages/0/content resolved to an object/array, not a scalar.` Assert the pending card and Audit page consume the metadata.

- [ ] **Step 6: Verify Task 2 and commit**

Run all Task 2 focused files and `bun run check`. Commit as `feat(approval): show indeterminate body cause`.

---

### Task 3: Capture exact bodies into bounded host SQLite and expose status (R5)

**Files:**
- Modify: `src/config/Schema.pkl`
- Modify: `src/config/types.ts`
- Modify: `src/network/authz/config.ts`
- Modify: `src/config/pkl_integration_test.ts`
- Modify: `src/config/validate.ts`
- Modify: `src/config/validate_test.ts`
- Modify: `src/lib/unix_socket.ts`
- Modify: `src/lib/unix_socket_test.ts`
- Modify: `src/network/protocol.ts`
- Modify: `src/network/protocol_test.ts`
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_test.ts`
- Modify: `src/stages/proxy/stage.ts`
- Modify: `src/stages/proxy/stage_test.ts`
- Modify: `src/stages/proxy/session_broker_service.ts`
- Modify: `src/stages/proxy/session_broker_service_test.ts`
- Modify: `src/network/broker.ts`
- Modify: `src/network/broker_integration_test.ts`
- Modify: `src/audit/types.ts`
- Modify: `src/audit/store.ts`
- Modify: `src/audit/store_integration_test.ts`
- Modify: `src/ui/frontend/src/stores/types.ts`
- Modify: `src/ui/frontend/src/stores/pendingStore.ts`
- Modify: `src/ui/frontend/src/stores/pendingStore_test.ts`
- Modify: `src/ui/frontend/src/components/PendingPane.tsx`

**Interfaces:**
- Produces `RequestBodyAuditConfig`, `RequestBodyCapture`, `RequestBodyAuditStatus`, `storeRequestBody`, `getRequestBody`, and `readJsonLine(socket, maxBytes?)`.

- [ ] **Step 1: Write RED config tests**

Pin default-off values and validation: positive integers, `maxBodyBytes <= 33554432`, `maxTotalBytes >= maxBodyBytes`. Run config/Pkl focused tests and observe missing field failures.

- [ ] **Step 2: Implement config propagation without new stage I/O**

Add `network.requestBodyAudit` defaults to Pkl/TS. Have `planProxy` copy it into `ProxyPlan`; pass it to the existing `SessionBrokerService.start`. The service writes the non-secret limits/enable flag into `SessionRegistryEntry` for the addon and passes the same value to `SessionBroker`.

- [ ] **Step 3: Write RED line-limit and capture validation tests**

Assert `readJsonLine(socket, N)` rejects after N bytes without logging content. Assert attached capture rejects invalid base64, byte length mismatch, digest mismatch, data on disabled/not-applicable/unavailable, and bodies above configured max.

- [ ] **Step 4: Add bounded base64 to authorize only**

The addon reads `requestBodyAudit` from the verified session registry. When disabled it does not encode bytes. When enabled it emits one `requestBodyCapture` on `authorize` from the pre-mask bytes. Broker calls `readJsonLine(socket, 48 * 1024 * 1024)` and validates capture before use.

- [ ] **Step 5: Write RED SQLite lifecycle tests**

Using a temp audit dir, assert exact byte round-trip including NUL/non-UTF8, normal audit queries never select/return `body`, expiry deletes before read/insert, capacity rejects only the new body, no truncation occurs, and DB/file mode remains owner-only where the current store establishes it.

- [ ] **Step 6: Implement one BLOB table and transaction**

Create `request_body` exactly as specified. `storeRequestBody` verifies decoded length/digest before the transaction, deletes expired rows, sums `byte_length`, and inserts only when capacity permits. It returns metadata status instead of throwing policy decisions. `getRequestBody` prunes expired data and reads one explicit BLOB.

- [ ] **Step 7: Persist before pending and display status**

Broker stores an attached capture before writing a pending entry or authorization audit and replaces the wire capture with metadata-only status. Storage failure becomes `unavailable/store-failed` and does not change allow/deny. Pending UI always renders `raw audit: saved / disabled / not applicable / unavailable (<code>)` and never receives `data`.

- [ ] **Step 8: Verify Task 3 and commit**

Run config, line reader, protocol, addon, stage, broker, store, and pending-store focused tests plus `bun run check`. Commit as `feat(audit): retain opt-in request bodies`.

---

### Task 4: Lazily view exact bodies from pending and audit (R5)

**Files:**
- Modify: `src/domain/audit/service.ts`
- Modify: `src/domain/audit/service_test.ts`
- Modify: `src/ui/data.ts`
- Modify: `src/ui/routes/api.ts`
- Modify: `src/ui/routes/api_integration_test.ts`
- Modify: `src/ui/frontend/src/api/client.ts`
- Create: `src/ui/frontend/src/components/RequestBodyPanel.tsx`
- Create: `src/ui/frontend/src/components/requestBodyView.ts`
- Create: `src/ui/frontend/src/components/requestBodyView_test.ts`
- Modify: `src/ui/frontend/src/components/PendingPane.tsx`
- Modify: `src/ui/frontend/src/components/settings/AuditPage.tsx`
- Modify: `src/ui/frontend/src/components/settings/SettingsShell.tsx`
- Modify: `src/ui/frontend/src/App.tsx`
- Modify: `src/ui/frontend/src/styles.css`

**Interfaces:**
- Consumes: `getRequestBody(sessionId, requestId)` from audit store.
- Produces: `GET /api/network/body/:sessionId/:requestId` and frontend `getNetworkRequestBody` returning metadata plus base64.

- [ ] **Step 1: Write RED domain/API tests**

Assert the audit client returns exact bytes from a temp DB. Assert the route rejects unsafe IDs, returns 404 for disabled/expired/missing bodies, and returns base64 plus metadata for saved bodies. Assert no route response or error log contains bytes for missing/invalid requests.

- [ ] **Step 2: Implement the thin retrieval path**

Extend the existing `AuditQueryService` and its plain-async client; `ui/data.ts` delegates to it. Add one safe-ID-validated GET route. Do not add a new service or access SQLite directly from the route.

- [ ] **Step 3: Write RED body-view tests**

Pin lossless display conversion:

```ts
expect(displayRequestBody(base64OfUtf8("{\"x\":1}"))).toEqual({ encoding: "utf-8", text: "{\"x\":1}" });
expect(displayRequestBody(base64OfBytes([0xff, 0x00]))).toEqual({ encoding: "base64", text: "/wA=" });
```

Assert fetch is not called before `View raw body`, loading/error is local to the panel, and closing/reopening does not log body content.

- [ ] **Step 4: Render one reusable lazy panel in both consumers**

`RequestBodyPanel` owns idle/loading/loaded/error state and calls the injected client only on click. Pending card renders it below status. Audit page adds an expandable detail row for network entries with attached metadata; it passes the same `(sessionId, requestId)`.

- [ ] **Step 5: Browser-check the actual UI**

Run `bun run build-ui`, launch the UI with mocked/fixture data, and use the repository Playwright workflow to verify: session label, `once` text, a non-once lifetime sentence, indeterminate cause, saved status, lazy raw text, audit re-open, and unavailable error. Record screenshots only as ignored verification artifacts.

- [ ] **Step 6: Run final verification and commit**

Run focused UI/API/domain tests, then the project post-change flow:

```bash
bun run fmt
bun run lint
bun run check
bun test src/
bun run build-ui
```

Run the full suite only if Docker capabilities are available; report capability skips and unrelated baseline failures exactly. Commit Task 4 as `feat(ui): inspect audited request bodies`.

## Self-review result

- R1 is delivered by committed `docs/todo/ui.md`; no implementation task repeats it.
- R2 and R3 terminate visibly in Task 1.
- R4 terminates visibly and durably in Task 2.
- R5 first exposes honest capture status in Task 3, then exact lazy content in Task 4.
- No task is merely a type, schema, protocol, or service foundation.
- No placeholder work, second framing protocol, group-ID UI model, evidence-ID lifecycle, or generic action contract remains.
