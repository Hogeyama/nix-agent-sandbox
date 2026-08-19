# Anthropic Egress Endpoint Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow only the seven observed bodyless Anthropic GET endpoints while preserving schema masking for Messages requests and failing closed for telemetry, Files API, and unknown traffic.

**Architecture:** `nas_addon.py` owns a pure endpoint classifier and applies one of three actions: `schema-mask`, `bodyless-pass`, or `block`. The addon reports a sanitized final outcome over the existing session-broker UDS; the broker persists that as a separate egress-phase audit row, and `nas audit` groups repeated egress rows without changing authorization audit semantics.

**Tech Stack:** Python 3 `unittest`, mitmproxy addon APIs, Bun/TypeScript, `bun:sqlite`, Bun test, Docker integration tests.

## Global Constraints

- Read and follow `test-policy`, `effect-separation`, `security-constraints`, `test-driven-development`, and `post-change-checks` before editing.
- Repository instructions override the stale Deno commands in `test-policy`: runtime and test runner are Bun, and internal test imports use relative paths.
- Implement strictly test-first: add one focused failing test, observe the expected failure, add the minimum production change, and rerun the focused test.
- Do not add a telemetry `local-success`; metrics, event logging, and eval requests remain 403.
- `POST /v1/files` remains blocked; do not add multipart parsing in this plan.
- Never log or persist a raw query, unknown raw path, request header value, body preview, body, filename, credential, or resolved mask value from an Anthropic egress outcome.
- Keep endpoint policy in `src/docker/mitmproxy/nas_addon.py`; the TypeScript broker validates sanitized outcome values but must not duplicate HTTP routing policy.
- Proxy stages remain orchestration-only. This plan adds no primitive I/O to `src/stages/`.
- Each task ends in its own commit and must pass the patched-superpowers rule-based reviewer before the next task starts.
- Spec: `docs/superpowers/specs/2026-07-23-anthropic-egress-endpoint-policy-design.md`.

## File Structure

- Modify `src/audit/types.ts`: add optional egress-phase audit fields and their literal types.
- Modify `src/audit/store.ts`: migrate, write, and read the new nullable SQLite columns.
- Modify `src/audit/store_integration_test.ts`: cover round-trip and legacy-database migration.
- Modify `src/network/protocol.ts`: define sanitized `egress_outcome` request/response types and closed value sets.
- Modify `src/network/broker.ts`: validate outcome messages and append egress-phase audit rows.
- Modify `src/network/broker_integration_test.ts`: cover valid, mismatched-session, and invalid-enum outcomes.
- Modify `src/docker/mitmproxy/nas_addon.py`: classify endpoints, enforce empty bodies, sanitize logs, aggregate block logs, and report outcomes.
- Modify `src/docker/mitmproxy/nas_addon_mask_test.py`: cover the pure policy matrix and logging helpers.
- Modify `src/docker/mitmproxy/nas_addon_integration_test.ts`: cover actual forwarding/blocking and teach the fake broker to acknowledge outcomes.
- Modify `src/cli/audit.ts`: group repeated egress outcomes in text mode.
- Create `src/cli/audit_test.ts`: cover grouping and authorization-output compatibility.

---

### Task 1: Persist Egress Audit Fields

**Files:**
- Modify: `src/audit/types.ts`
- Modify: `src/audit/store.ts`
- Test: `src/audit/store_integration_test.ts`

**Interfaces:**
- Produces: `AuditPhase`, `AnthropicEgressAction`, and optional `AuditLogEntry.phase`, `.method`, `.route`, `.egressAction`.
- Preserves: existing callers may omit every new field; rows created before this change read back with `phase: "authorization"`.

- [ ] **Step 1: Add a failing round-trip test for egress fields**

Append this test to `src/audit/store_integration_test.ts`:

```ts
test("appendAuditLog: round-trips Anthropic egress outcome fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-egress-"));
  try {
    await appendAuditLog(
      makeEntry({
        requestId: "req-egress",
        phase: "egress",
        method: "POST",
        route: "/v1/files",
        egressAction: "block",
        decision: "deny",
        reason: "file-upload-blocked",
      }),
      dir,
    );

    const [entry] = await queryAuditLogs({}, dir);
    expect(entry).toMatchObject({
      phase: "egress",
      method: "POST",
      route: "/v1/files",
      egressAction: "block",
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 2: Run the focused test and verify the type failure**

Run: `bun test src/audit/store_integration_test.ts`

Expected: FAIL during type checking/editor validation because the four fields are not members of `AuditLogEntry`, or at runtime because they are not persisted.

- [ ] **Step 3: Add the audit literal types and optional fields**

Add to `src/audit/types.ts`:

```ts
export type AuditPhase = "authorization" | "egress";
export type AnthropicEgressAction = "schema-mask" | "bodyless-pass" | "block";

export interface AuditLogEntry {
  // existing fields remain unchanged
  phase?: AuditPhase;
  method?: string;
  route?: string;
  egressAction?: AnthropicEgressAction;
}
```

Place the four properties after `reason`, with comments stating that absent `phase` means a legacy authorization entry.

- [ ] **Step 4: Migrate and round-trip the four SQLite columns**

In `src/audit/store.ts`, add the columns to `CREATE TABLE`:

```sql
phase            TEXT,
method           TEXT,
route            TEXT,
egress_action    TEXT,
```

Replace the single-purpose injected-header migration with a helper and calls for all nullable columns:

```ts
function addColumnIfMissing(db: Database, definition: string): void {
  try {
    db.run(`ALTER TABLE audit_log ADD COLUMN ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column name")) throw error;
  }
}

addColumnIfMissing(db, "injected_headers TEXT");
addColumnIfMissing(db, "phase TEXT");
addColumnIfMissing(db, "method TEXT");
addColumnIfMissing(db, "route TEXT");
addColumnIfMissing(db, "egress_action TEXT");
```

Extend `INSERT OR REPLACE`, its argument list, `SELECT`, `AuditLogRow`, and `rowToEntry`. `rowToEntry` must use:

```ts
entry.phase = row.phase === null ? "authorization" : (row.phase as AuditPhase);
if (row.method !== null) entry.method = row.method;
if (row.route !== null) entry.route = row.route;
if (row.egress_action !== null) {
  entry.egressAction = row.egress_action as AnthropicEgressAction;
}
```

- [ ] **Step 5: Add and pass a legacy-schema migration test**

Import `Database` from `bun:sqlite` and `_closeAuditDb` from `./store.ts`. Create a database with the pre-change schema, close it, call `queryAuditLogs`, and assert the old row reads as authorization:

```ts
expect(entry.phase).toEqual("authorization");
expect(entry.method).toBeUndefined();
expect(entry.route).toBeUndefined();
expect(entry.egressAction).toBeUndefined();
```

Also append a new egress row after migration and assert both rows remain readable.

Run: `bun test src/audit/store_integration_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the audit storage change**

```bash
git add src/audit/types.ts src/audit/store.ts src/audit/store_integration_test.ts
git commit -m "feat(audit): persist Anthropic egress outcomes"
```

---

### Task 2: Validate and Record Broker Egress Outcomes

**Files:**
- Modify: `src/network/protocol.ts`
- Modify: `src/network/broker.ts`
- Test: `src/network/broker_integration_test.ts`

**Interfaces:**
- Consumes: Task 1's `AuditLogEntry` egress fields.
- Produces: `EgressOutcomeRequest`, `EgressOutcomeResponse`, and broker handling for `type: "egress_outcome"`.
- Wire contract: the response is `{ version: 1, type: "egress_outcome_recorded", requestId }` on success and the existing `{ type: "error", requestId, message }` shape on validation failure.

- [ ] **Step 1: Write failing broker integration tests**

Add one success test to `src/network/broker_integration_test.ts` that starts a broker with an audit directory, sends:

```ts
const response = await sendBrokerRequest<EgressOutcomeResponse>(socketPath, {
  version: 1,
  type: "egress_outcome",
  requestId: "req-egress",
  sessionId: "sess_test",
  method: "POST",
  route: "/v1/files",
  action: "block",
  reason: "file-upload-blocked",
});
```

Assert the acknowledgement and an audit row with `phase: "egress"`, `decision: "deny"`, and no `target`.

Add table-driven rejection cases for a mismatched session, an unlisted route, an invalid action, an invalid reason, and an invalid action/reason pairing. Assert `type: "error"` and that no egress audit row is written.

- [ ] **Step 2: Run the broker test and verify it fails**

Run: `bun test src/network/broker_integration_test.ts --test-name-pattern "egress outcome"`

Expected: FAIL because the protocol types and broker message branch do not exist.

- [ ] **Step 3: Define the closed wire types in `protocol.ts`**

Add literal tuples and derived types:

```ts
export const ANTHROPIC_EGRESS_ACTIONS = [
  "schema-mask",
  "bodyless-pass",
  "block",
] as const;

export const ANTHROPIC_EGRESS_METHODS = ["GET", "POST"] as const;

export const ANTHROPIC_EGRESS_REASONS = [
  "recognized-schema",
  "known-bodyless-endpoint",
  "unknown-endpoint",
  "unexpected-body",
  "body-unavailable",
  "schema-unknown",
  "decode-failed",
  "file-upload-blocked",
] as const;

export const ANTHROPIC_EGRESS_ROUTES = [
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/api/claude_cli/bootstrap",
  "/api/claude_code_penguin_mode",
  "/api/claude_code/policy_limits",
  "/api/claude_code/settings",
  "/mcp-registry/v0/servers",
  "/v1/code/triggers",
  "/v1/mcp_servers",
  "/api/claude_code/metrics",
  "/api/event_logging/v2/batch",
  "/api/eval/:id",
  "/v1/files",
  "unknown",
] as const;
```

Define the request and response interfaces using the tuple-derived unions, including
`method: (typeof ANTHROPIC_EGRESS_METHODS)[number]`. Export a pure validator:

```ts
export function validateEgressOutcome(
  value: unknown,
  expectedSessionId: string,
): string | null;
```

The validator returns `null` only when method, route, action, and reason all match their
closed sets and these pairs hold:

```ts
const validPair =
  (action === "schema-mask" && reason === "recognized-schema") ||
  (action === "bodyless-pass" && reason === "known-bodyless-endpoint") ||
  (action === "block" && ![
    "recognized-schema",
    "known-bodyless-endpoint",
  ].includes(reason));
```

- [ ] **Step 4: Add the broker message branch and audit record**

Extend the private `BrokerMessage` and `BrokerResponse` unions. Handle outcomes before `list_pending` fallback:

```ts
if (message.type === "egress_outcome") {
  return await this.recordEgressOutcome(message);
}
```

Implement `recordEgressOutcome` so it validates first, returns an error without writing on failure, and otherwise appends:

```ts
const entry: AuditLogEntry = {
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  domain: "network",
  sessionId: this.sessionId,
  requestId: message.requestId,
  decision: message.action === "block" ? "deny" : "allow",
  reason: message.reason,
  phase: "egress",
  method: message.method,
  route: message.route,
  egressAction: message.action,
};
```

Set `phase: "authorization"` in existing `recordAudit` entries. If `auditDir` is absent, still acknowledge a valid outcome.

- [ ] **Step 5: Run focused and regression tests**

Run: `bun test src/network/broker_integration_test.ts src/audit/store_integration_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the broker protocol change**

```bash
git add src/network/protocol.ts src/network/broker.ts src/network/broker_integration_test.ts
git commit -m "feat(network): record sanitized egress outcomes"
```

---

### Task 3: Add the Pure Anthropic Endpoint Classifier

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Produces: `_classify_anthropic_endpoint(method: str, path: str) -> tuple[str, str]` returning `(endpoint_class, safe_route)`.
- Produces: `_block_reason_for_route(route: str) -> str`.
- Preserves: `_plan_anthropic_masking` remains the schema-body planner returning `block`, `rewrite`, or `passthrough`.

- [ ] **Step 1: Replace routing tests with a failing policy matrix**

In `AnthropicRoutingTest`, test all seven GET paths with query variants and assert `("bodyless-pass", path)`. Test both Messages paths as `schema-mask`. Add these explicit rejection cases:

```python
cases = [
    ("POST", "/api/claude_code/metrics", "/api/claude_code/metrics"),
    ("POST", "/api/event_logging/v2/batch", "/api/event_logging/v2/batch"),
    ("POST", "/api/eval/sdk-secret", "/api/eval/:id"),
    ("POST", "/v1/files", "/v1/files"),
    ("GET", "/v1/files", "/v1/files"),
    ("GET", "/api/claude_code/settings/", "unknown"),
    ("GET", "/api/claude_code/settings/child", "unknown"),
    ("GET", "/api%2Fclaude_code%2Fsettings", "unknown"),
    ("GET", "//api/claude_code/settings", "unknown"),
    ("HEAD", "/api/claude_code/settings", "/api/claude_code/settings"),
]
```

Every case must return class `block` and the expected safe route. Assert `_block_reason_for_route("/v1/files") == "file-upload-blocked"` and every other blocked route yields `unknown-endpoint`.
Also assert `POST /v1/messages/` is blocked as `unknown`; this intentionally removes the
old trailing-slash normalization.

- [ ] **Step 2: Run the Python wrapper and verify failure**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: FAIL with `AttributeError` for `_classify_anthropic_endpoint`.

- [ ] **Step 3: Implement exact-match endpoint tables**

Add immutable endpoint tables and a non-decoding path splitter:

```python
_ANTHROPIC_SCHEMA_ENDPOINTS = frozenset({
    ("POST", "/v1/messages"),
    ("POST", "/v1/messages/count_tokens"),
})

_ANTHROPIC_BODYLESS_ENDPOINTS = frozenset({
    ("GET", "/api/claude_cli/bootstrap"),
    ("GET", "/api/claude_code_penguin_mode"),
    ("GET", "/api/claude_code/policy_limits"),
    ("GET", "/api/claude_code/settings"),
    ("GET", "/mcp-registry/v0/servers"),
    ("GET", "/v1/code/triggers"),
    ("GET", "/v1/mcp_servers"),
})
```

`_classify_anthropic_endpoint` must uppercase the method, split only at the first `?`, perform exact ASCII string comparison, and never call URL decoding or slash normalization. `_safe_anthropic_route` returns exact known labels, `/api/eval/:id` for any path beginning `/api/eval/`, `/v1/files` for `/v1/files` and descendants, or `unknown`.

Keep `_anthropic_json_endpoint` as a compatibility wrapper only if another caller still needs it; otherwise replace it and update all tests in the same commit.

- [ ] **Step 4: Run the Python tests**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the classifier**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): classify Anthropic egress endpoints"
```

---

### Task 4: Enforce Bodyless GETs, Sanitize Logs, and Report Outcomes

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Test: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Consumes: Task 2's `egress_outcome` wire contract and Task 3's classifier.
- Produces: `_should_emit_block_log(count: int) -> bool` and `_report_egress_outcome(...)`.
- Behavior: every authorized Anthropic request reports exactly one final outcome; report failure never changes the egress decision.

- [ ] **Step 1: Add failing unit tests for body state and safe log cadence**

Add tests asserting:

```python
self.assertEqual(
    nas_addon._plan_bodyless_anthropic_request(b""),
    ("bodyless-pass", "known-bodyless-endpoint"),
)
self.assertEqual(
    nas_addon._plan_bodyless_anthropic_request(b"x"),
    ("block", "unexpected-body"),
)
self.assertEqual(
    nas_addon._plan_bodyless_anthropic_request(None),
    ("block", "body-unavailable"),
)
self.assertEqual(
    [n for n in range(1, 10) if nas_addon._should_emit_block_log(n)],
    [1, 2, 4, 8],
)
```

Add a test that patches `nas_addon._query_broker`, calls `_report_egress_outcome`, and asserts the serialized request contains only the closed fields and safe route. Add a failure test proving a broker exception is swallowed after writing only a constant local error without request data.

- [ ] **Step 2: Run the Python wrapper and verify failure**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Implement bodyless planning, reporting, and log aggregation helpers**

Implement:

```python
def _plan_bodyless_anthropic_request(body: Optional[bytes]) -> tuple[str, str]:
    if body is None:
        return "block", "body-unavailable"
    if len(body) != 0:
        return "block", "unexpected-body"
    return "bodyless-pass", "known-bodyless-endpoint"


def _should_emit_block_log(count: int) -> bool:
    return count > 0 and (count & (count - 1)) == 0
```

Initialize `self._anthropic_block_counts: dict[tuple[str, ...], int] = {}` in `NasAddon.__init__`. The emitted line uses only the closed route/action/reason values and count.

`_report_egress_outcome` must call the broker with `type: "egress_outcome"`, catch all exceptions, and print only `[nas-addon] egress outcome audit unavailable` on failure.

- [ ] **Step 4: Refactor the Anthropic request branch in the required order**

After authorization returns mask values:

1. Call `_mask_url_and_headers(flow, patterns)` before classification or block logging.
2. Classify using the now-masked `flow.request.path`.
3. Retrieve body inside `try/except ValueError`; use `None` on failure.
4. For `schema-mask`, run `_plan_anthropic_masking`; map success to action/reason `schema-mask/recognized-schema`, and use its precise block reason.
5. For `bodyless-pass`, call `_plan_bodyless_anthropic_request`.
6. For policy block, use `file-upload-blocked` for `/v1/files`, otherwise `unknown-endpoint`.
7. Report the outcome over the broker socket.
8. On block, emit an aggregated safe log and return a fixed `403` body: `b"blocked: Anthropic egress policy"`.
9. On allow, inject credentials only after masking and continue upstream.

Do not include `request_path` or `flow.request.pretty_url` in the new block line. Keep generic non-Anthropic behavior unchanged.

Change the schema helper contracts explicitly:

```python
def _schema_mask_json(
    body: bytes, patterns: list[bytes]
) -> tuple[Optional[bytes], Optional[str]]:
    # success: (rewritten_body_or_None, None)
    # unknown content block: (None, "schema-unknown")
    # JSON parse/serialize/decode failure: (None, "decode-failed")


def _plan_anthropic_masking(
    body: Optional[bytes], patterns: list[bytes]
) -> tuple[str, Optional[bytes], str]:
    # ("block", None, "body-unavailable" | "schema-unknown" | "decode-failed")
    # ("rewrite", body, "recognized-schema")
    # ("passthrough", None, "recognized-schema")
```

The endpoint check moves out of `_plan_anthropic_masking` into the routing classifier.
Update every existing `SchemaMaskTest` and `AnthropicPlanTest` assertion to the new tuples
in the same test-first cycle; do not leave compatibility booleans that collapse the reason.

- [ ] **Step 5: Add request-branch regression tests with fake flows**

Patch registry lookup and broker calls so `NasAddon.request` can be exercised without mitmproxy. Cover:

- bodyless known GET stays unblocked and sends `bodyless-pass` outcome;
- non-empty known GET gets fixed 403 and `unexpected-body`;
- telemetry and Files POST get fixed 403 and sanitized routes;
- a query/header containing `SECRET123` is rewritten before any captured log call;
- an unknown path containing `SECRET123` never appears in stderr or outcome data;
- schema rewrite still masks the body and reports `schema-mask`.

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the addon enforcement change**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): enforce Anthropic endpoint policy"
```

---

### Task 5: Group Repeated Egress Outcomes in `nas audit`

**Files:**
- Modify: `src/cli/audit.ts`
- Create: `src/cli/audit_test.ts`

**Interfaces:**
- Consumes: Task 1's optional audit fields.
- Produces: exported pure `formatAuditEntries(entries: AuditLogEntry[]): string[]` used by `runAuditCommand` text mode.
- Preserves: JSON mode returns ungrouped stored entries and existing authorization lines retain their exact format.

- [ ] **Step 1: Add failing formatter tests**

Create `src/cli/audit_test.ts` with a local entry factory. Cover:

```ts
expect(formatAuditEntries([authorizationEntry])).toEqual([
  "2026-07-23T00:00:00.000Z sess-1 network allow review-rule api.anthropic.com:443",
]);
```

Create three identical egress block entries separated by authorization entries. Assert only the first egress position emits:

```text
2026-07-23T00:00:01.000Z sess-1 network deny file-upload-blocked POST /v1/files block x3
```

Also assert grouping stops when session, method, route, action, or reason changes, and that a single egress entry omits `x1`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test src/cli/audit_test.ts`

Expected: FAIL because `formatAuditEntries` is not exported.

- [ ] **Step 3: Implement projection-aware egress grouping**

Export a pure formatter. First scan the egress-only projection in original order and assign a count to the first index of each run keyed by:

```ts
const key = [
  entry.sessionId,
  entry.method,
  entry.route,
  entry.egressAction,
  entry.reason,
].join("\u0000");
```

Authorization rows do not terminate an egress run, but remain in their original output positions. Skip later egress rows in the same run. Format egress rows as:

```ts
`${entry.timestamp} ${entry.sessionId} network ${entry.decision} ${entry.reason} ${entry.method ?? ""} ${entry.route ?? "unknown"} ${entry.egressAction ?? ""}${count > 1 ? ` x${count}` : ""}`
```

Keep the current `formatEntry` logic unchanged for authorization and hostexec rows. Change text mode to:

```ts
for (const line of formatAuditEntries(entries)) console.log(line);
```

- [ ] **Step 4: Run CLI and audit regression tests**

Run: `bun test src/cli/audit_test.ts src/audit/store_integration_test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the CLI grouping change**

```bash
git add src/cli/audit.ts src/cli/audit_test.ts
git commit -m "feat(cli): group repeated egress audit outcomes"
```

---

### Task 6: Prove Policy Behavior Through the Real Proxy

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 wire protocol and addon behavior.
- Produces: Docker-backed evidence that allowed requests reach a fake upstream and blocked requests do not.

- [ ] **Step 1: Make the fake broker understand both message types**

Change `startAllowMaskBroker` to record received JSON messages in an array supplied by the fixture. For `authorize`, return the existing allow decision. For `egress_outcome`, return:

```ts
{
  version: 1,
  type: "egress_outcome_recorded",
  requestId: request.requestId,
}
```

Expose `brokerMessages: unknown[]` on `AnthropicFixture` so every integration test can assert the sanitized outcome.

- [ ] **Step 2: Add a failing bodyless GET forwarding test**

Reuse the benchmark network and raw echo upstream pattern from the Messages test. Send:

```ts
GET /api/claude_cli/bootstrap?entrypoint=cli&model=SECRET123
X-Test-Secret: SECRET123
```

Assert 200, an empty upstream body, no `SECRET123` in upstream logs, `****` in the query/header, and a `bodyless-pass/known-bodyless-endpoint` broker outcome.

Run: `bun test src/docker/mitmproxy/nas_addon_integration_test.ts --test-name-pattern "bodyless GET"`

Expected before Tasks 3–4 are present: FAIL with 403. Expected now: PASS.

- [ ] **Step 3: Add blocked-request integration cases**

Add table-driven cases for:

- `GET /api/claude_code/settings` with body `x` -> `unexpected-body`;
- `POST /api/claude_code/metrics` -> `unknown-endpoint`;
- `POST /v1/files` -> `file-upload-blocked`;
- `GET /unknown/SECRET123?token=SECRET123` -> `unknown-endpoint` and route `unknown`.

Pin `api.anthropic.com` to loopback for these tests so a regression cannot contact the real service. Assert 403, fixed response text, sanitized broker outcome, and container logs that do not contain `SECRET123`.

- [ ] **Step 4: Run all addon tests**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/nas_addon_integration_test.ts`

Expected: PASS, or Docker integration cases are explicitly skipped only when the existing Docker/bind-mount guard says the environment cannot run them.

- [ ] **Step 5: Commit the integration coverage**

```bash
git add src/docker/mitmproxy/nas_addon_integration_test.ts
git commit -m "test(network): cover Anthropic endpoint policy end to end"
```

---

### Task 7: Run Repository Verification

**Files:**
- Modify only files changed automatically by the formatter, and only when those changes belong to Tasks 1–6.

**Interfaces:**
- Verifies the complete branch; produces no new runtime interface.

- [ ] **Step 1: Run formatting**

Run: `bun run fmt`

Expected: exit 0. Inspect `git diff`; do not retain unrelated formatter changes.

- [ ] **Step 2: Run lint**

Run: `bun run lint`

Expected: exit 0.

- [ ] **Step 3: Run composed-effect lint**

Run: `bun run lint:composed-effects`

Expected: exit 0 with no new findings.

- [ ] **Step 4: Run type checks**

Run: `bun run check`

Expected: exit 0 for Biome and all three TypeScript configurations.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`

Expected: exit 0. Record passed, failed, and skipped counts. Docker-only tests may be skipped only through their existing environment guards.

- [ ] **Step 6: Commit formatter-only changes if any**

If `bun run fmt` changed task-owned files:

```bash
git add src/audit src/network src/docker/mitmproxy src/cli
git commit -m "style: format Anthropic endpoint policy changes"
```

If the worktree is clean, do not create an empty commit.
