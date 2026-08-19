# Configurable Review-Rule Request Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreleased Anthropic-only egress switch and hard-coded addon policy with versioned, user-configurable request policies embedded in ordered network review rules, including the immutable `anthropic@1` preset.

**Architecture:** Pkl produces raw `ReviewRule | ReviewRulesPreset` specifications. A pure TypeScript compiler expands presets, validates overlays and shadowing, and emits one closed `ResolvedReviewRules { contractVersion: 1, rules }` document. The proxy stage passes that same value to the broker and the per-session review-rules file. The broker remains authoritative for authorization and matched rule ID; the untrusted Python addon defensively validates the document, executes only the broker-named policy, reports a closed sanitized outcome, and injects credentials only after policy success.

**Tech Stack:** Bun/TypeScript, Pkl, Effect services, Python 3 `unittest`, mitmproxy addon APIs, `bun:sqlite`, Docker integration tests.

## Global Constraints

- Before implementation, read and follow `test-policy`, `effect-separation`, `security-constraints`, `test-driven-development`, `post-change-checks`, and `verification-before-completion`.
- Repository instructions override stale Deno examples: use Bun and relative imports for internal test modules.
- Work test-first: add one focused failing test, confirm the expected failure, make the minimum production change, and rerun the focused test.
- This refactors unreleased branch code. Remove `mask.anthropicEgress`, `egress_outcome`, egress audit fields, and provider-specific executable branches without compatibility aliases.
- Preserve existing behavior for ID-less review rules without `path` or `requestPolicy`.
- Keep preset expansion and semantic validation pure. `src/stages/proxy/stage.ts` orchestrates but performs no primitive I/O.
- The broker is authoritative for first-match authorization and rule IDs. The addon pre-matches only to decide whether an interactive preview is needed.
- Approval caches resolve only a currently matched `review` rule. They never override explicit `allow`/`deny`, and never skip the matched request policy.
- Every resolved request policy requires `mask.proxy = true`, including bodyless-only preset overlays.
- Never write mask values to config, resolved-rule files, registries, outcomes, audits, logs, or 403 bodies.
- Never log or persist raw unknown paths, queries, body data/previews, header values, filenames, credentials, mask values, or parser/serializer exceptions.
- Accept only `bodyless` and `json`; reject `graphql` and unknown kinds in TypeScript and Python.
- Do not add telemetry `local-success`, multipart/file handlers, regex selectors, executable predicates, OpenAI presets, or automatic agent-based preset selection.
- `anthropic@1` is immutable. Future endpoint widening requires a new version.
- Docker tests use fake upstreams and random isolated resources, never contact providers, skip honestly, and clean up partial setup.
- Each task ends in its own commit and patched-superpowers rule review.
- Approved spec: `docs/superpowers/specs/2026-07-23-configurable-request-policies-design.md`.

## File Map

- `src/config/types.ts`, `src/config/Schema.pkl`, `src/config/validate.ts`: raw AST and configuration validation.
- `src/network/review_rules.ts` (new): resolved contract, compiler, matcher, overlays, shadow analysis, and preset data.
- `src/network/fixtures/resolved_review_rules/anthropic-v1.json` (new): checked cross-language contract fixture.
- `src/stages/proxy/stage.ts`, `network_runtime_service.ts`, `session_broker_service.ts`: resolve once per plan and feed both runtime consumers.
- `src/network/protocol.ts`, `src/network/broker.ts`: authoritative rule-aware authorization and closed outcome protocol.
- `src/audit/types.ts`, `src/audit/store.ts`, `src/cli/audit.ts`: generic request-policy audit persistence/output.
- `src/docker/mitmproxy/nas_addon.py`: defensive contract validation and generic policy execution.
- Corresponding `*_test.ts`, `*_integration_test.ts`, and `nas_addon_mask_test.py`: focused and end-to-end coverage.
- `.nas/config.pkl`: migrate the local demo to the preset.

---

### Task 1: Add the Public Configuration AST and Remove the Old Switch

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/Schema.pkl`
- Modify: `src/config/pkl_integration_test.ts`
- Modify: `src/config/load_integration_test.ts`
- Modify: `src/config/validate.ts`
- Modify: `src/config/validate_mask_test.ts`
- Modify fixtures: `src/stages/hostexec/stage_test.ts`, `src/stages/maskfs/mask_filter_stage_test.ts`, `src/stages/maskfs/stage_test.ts`, `src/stages/mount/stage_test.ts`, `src/stages/proxy/stage_test.ts`
- Modify old-flag wiring: `src/stages/proxy/stage.ts`, `src/stages/proxy/session_broker_service.ts`, `src/stages/proxy/session_broker_service_integration_test.ts`, `src/network/protocol.ts`, `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Produces:** raw `ReviewRuleSpec`, `ReviewRulesPreset`, `RequestPolicy`, `BodylessRequestPolicy`, `JsonRequestPolicy`, `TaggedUnionGuard`, and `EncodedField` types.

- [ ] **Step 1: Add failing Pkl tests for both rule-spec variants**

Load an exact bodyless rule and this preset overlay:

```pkl
new ReviewRulesPreset {
  id = "anthropic"
  preset = "anthropic@1"
  host = "gateway.example.com"
  removeRules { "bodyless.settings" }
  addRules {
    new ReviewRule {
      id = "company-bootstrap"
      method = "GET"
      path = "/company/bootstrap"
      action = "review"
      requestPolicy = new BodylessRequestPolicy {}
    }
  }
}
```

Assert evaluated handlers contain `kind = "bodyless"` and ordinary ID-less rules are unchanged.

Run: `bun test src/config/pkl_integration_test.ts --test-name-pattern "request policy|preset"`

Expected: FAIL because the classes do not exist.

- [ ] **Step 2: Define the TypeScript AST**

Add tagged policies and child nodes:

```ts
type RequestPolicy = BodylessRequestPolicy | JsonRequestPolicy;
interface BodylessRequestPolicy { kind: "bodyless" }
interface JsonRequestPolicy {
  kind: "json";
  maxBodyBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxDecodedBytes: number;
  taggedUnions: TaggedUnionGuard[];
  encodedFields: EncodedField[];
}
```

Add `id?`, exact `path?`, and `requestPolicy?` to `ReviewRule`. Define `ReviewRulesPreset { id, preset, host?, removeRules, addRules }`, make `NetworkConfig.reviewRules` a `ReviewRuleSpec[]`, and remove `MaskConfig.anthropicEgress`.

- [ ] **Step 3: Define Pkl classes and defaults**

Add literal serialized `kind` defaults, the four JSON limit defaults, `Listing<TaggedUnionGuard>`, `Listing<EncodedField>`, and:

```pkl
reviewRules: Listing<(ReviewRule|ReviewRulesPreset)> = new {}
```

Delete `MaskConfig.anthropicEgress`. Add rejection tests for `kind = "graphql"` and unknown fields.

Run: `bun test src/config/pkl_integration_test.ts src/config/load_integration_test.ts`

Expected: PASS.

- [ ] **Step 4: Remove old-switch tests and fixture fields**

Delete old validation cases and all `anthropicEgress` TypeScript fixture
properties listed above. Remove the flag from `ProxyPlan`,
`SessionBrokerConfig`, and `SessionRegistryEntry`, and stop writing it to the
registry. Leave Python behavior removal to Tasks 7–9, but do not retain a
TypeScript compatibility field.

Run:

```bash
rg -n "anthropicEgress" src --glob "*.ts"
bun run check
```

Expected: no `rg` matches; check passes.

- [ ] **Step 5: Commit**

```bash
git add src/config/types.ts src/config/Schema.pkl src/config/validate.ts src/config/pkl_integration_test.ts src/config/load_integration_test.ts src/config/validate_mask_test.ts src/stages/hostexec/stage_test.ts src/stages/maskfs/mask_filter_stage_test.ts src/stages/maskfs/stage_test.ts src/stages/mount/stage_test.ts src/stages/proxy/stage.ts src/stages/proxy/stage_test.ts src/stages/proxy/session_broker_service.ts src/stages/proxy/session_broker_service_integration_test.ts src/network/protocol.ts src/docker/mitmproxy/nas_addon_integration_test.ts
git commit -m "feat(config): define review-rule request policies"
```

---

### Task 2: Compile and Validate Custom Resolved Rules

**Files:**
- Create: `src/network/review_rules.ts`
- Create: `src/network/review_rules_test.ts`
- Modify: `src/config/validate.ts`
- Modify: `src/config/validate_test.ts`
- Modify: `src/config/validate_mask_test.ts`

**Produces:** `ResolvedReviewRule`, `ResolvedReviewRules`, `resolveReviewRules`, exact matching, and testable shadow subsumption.

- [ ] **Step 1: Add failing compiler tests**

Cover ID-less rules; safe 64-byte and unsafe IDs; exact query-free paths; no normalization/decoding; `path` plus `pathPrefix`; missing required policy fields; wildcard/port hosts; `deny + policy`; wrong methods; invalid/over-ceiling limits; malformed selectors; unknown encoding; duplicate IDs/endpoints.

Run: `bun test src/network/review_rules_test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 2: Implement the closed result and matching**

Return:

```ts
interface ResolvedReviewRules {
  contractVersion: 1;
  rules: ResolvedReviewRule[];
}
```

Validate IDs by matching the ASCII prefix `/^[a-z][a-z0-9._-]{0,63}/` and
requiring the matched text to equal the complete input. This avoids JavaScript
`$` accepting a position before a final line terminator. Clone nested values.
Match method case-insensitively, use existing host/prefix helpers, strip only
the first query for exact `path`, and compare it without canonicalization.

- [ ] **Step 3: Validate policies and selectors**

Require exact method/host/path/id for policies, `GET` for bodyless and `POST` for JSON, exact non-port host, non-deny action, positive limits at/below hard ceilings, valid `~0`/`~1` pointer escapes, and whole-segment `*`/`**`. Reject regex/filter/script syntax and non-base64 encodings.

Run: `bun test src/network/review_rules_test.ts --test-name-pattern "custom|path|selector|limit"`

Expected: PASS.

- [ ] **Step 4: Implement formal shadow subsumption**

Add table tests for absent/equal methods; exact/wildcard/port hosts; absent/exact/prefix paths; segment boundaries; and exact paths that cannot subsume prefixes. Ignore action, and return false when subsumption cannot be proven.

Run: `bun test src/network/review_rules_test.ts --test-name-pattern "shadow"`

Expected: PASS.

- [ ] **Step 5: Integrate configuration validation**

Resolve each profile's specs in `validate.ts`, prefix errors with profile/rule identity, hard-fail protected-rule shadowing, retain ordinary catch-all warnings, and independently require `profile.mask?.proxy === true` whenever any resolved policy exists.

Run: `bun test src/config/validate_test.ts src/config/validate_mask_test.ts src/network/review_rules_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/network/review_rules.ts src/network/review_rules_test.ts src/config/validate.ts src/config/validate_test.ts src/config/validate_mask_test.ts
git commit -m "feat(network): compile request-policy review rules"
```

---

### Task 3: Add Immutable Preset Expansion and Its Shared Fixture

**Files:**
- Modify: `src/network/review_rules.ts`
- Modify: `src/network/review_rules_test.ts`
- Create: `src/network/fixtures/resolved_review_rules/anthropic-v1.json`
- Modify: `src/config/validate_test.ts`

**Produces:** immutable `anthropic@1`, inline overlay expansion, and one TypeScript/Python fixture.

- [ ] **Step 1: Add failing overlay tests**

Cover inline position; additions before terminal deny; terminal removal; valid replacement; unknown/duplicate removes; reused IDs; duplicate endpoints; unknown preset; host override/inheritance/mismatch; namespace/local/composed ID overflow; and prior broad-rule shadow.

Run: `bun test src/network/review_rules_test.ts --test-name-pattern "preset|overlay|anthropic"`

Expected: FAIL.

- [ ] **Step 2: Encode `anthropic@1` as frozen data**

Include two JSON POST rules, seven exact bodyless GET rules, and terminal exact-host deny. JSON data contains selectors `/**/content/*`, `/**/system/*`, encoded selector `/**`, strict base64, default limits, and exactly the spec's 14 tags excluding `fallback`. No provider branch belongs in Python.

- [ ] **Step 3: Implement expansion**

Select version, apply effective host, remove local IDs, validate/host-fill additions, insert before the remaining terminal rule, prefix IDs, revalidate composed IDs, then run full duplicate/shadow validation. Clone preset data before returning.

Run: `bun test src/network/review_rules_test.ts`

Expected: PASS.

- [ ] **Step 4: Lock a cross-language fixture**

Create `anthropic-v1.json` equal to:

```ts
resolveReviewRules([
  { id: "anthropic", preset: "anthropic@1", removeRules: [], addRules: [] },
])
```

Test deep equality, version, safe composed IDs, absence of `fallback` and Files/telemetry/eval allow routes, and final exact-host deny.

Run: `bun test src/network/review_rules_test.ts --test-name-pattern "fixture|anthropic"`

Expected: PASS.

- [ ] **Step 5: Add config-level overlay failures**

Test unknown removal, inherited/mismatched hosts, composed overflow, and broad prior shadow with profile-qualified errors.

Run: `bun test src/config/validate_test.ts src/network/review_rules_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/network/review_rules.ts src/network/review_rules_test.ts src/network/fixtures src/config/validate_test.ts
git commit -m "feat(network): add anthropic request-policy preset"
```

---

### Task 4: Wire One Resolved Document Through the Proxy Stage

**Files:**
- Modify: `src/stages/proxy/stage.ts`, `src/stages/proxy/stage_test.ts`
- Modify: `src/stages/proxy/network_runtime_service.ts`, `src/stages/proxy/network_runtime_service_test.ts`
- Modify: `src/stages/proxy/session_broker_service.ts`, `src/stages/proxy/session_broker_service_integration_test.ts`
- Modify: `src/network/protocol.ts`

**Produces:** `ProxyPlan.resolvedReviewRules`; the writer and broker receive the same resolved value.

- [ ] **Step 1: Add failing plan/serialization tests**

Assert a raw preset becomes a versioned plan document. Assert `writeReviewRules` writes the complete object, not a bare array.

Run: `bun test src/stages/proxy/stage_test.ts src/stages/proxy/network_runtime_service_test.ts`

Expected: FAIL.

- [ ] **Step 2: Resolve in the pure plan builder**

Call `resolveReviewRules` in `buildProxyPlan`. Pass `plan.resolvedReviewRules` unchanged to `writeReviewRules` and `SessionBrokerService.start`. Do not expand inside services.

- [ ] **Step 3: Retype Effect boundaries and fakes**

Change both service contracts to `ResolvedReviewRules`. Keep file/process operations inside existing services.

Run: `bun test src/stages/proxy/stage_test.ts src/stages/proxy/network_runtime_service_test.ts`

Expected: PASS.

- [ ] **Step 4: Prove both runtime consumers receive the same object**

Use stage-service fakes to capture both arguments and assert each is
referentially identical (`toBe`) to `plan.resolvedReviewRules`. Keep the
session registry free of policy documents and verify broker lifecycle still
works.

Run: `bun test src/stages/proxy/session_broker_service_integration_test.ts`

Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
rg -n "anthropicEgress" src/stages src/network/protocol.ts
bun run lint:composed-effects
bun run check
git add src/stages/proxy src/network/protocol.ts
git commit -m "refactor(proxy): wire resolved review-rule documents"
```

Expected: no old-switch matches; checks pass.

---

### Task 5: Add Generic Audit Storage and CLI Output

**Files:**
- Modify: `src/audit/types.ts`, `src/audit/store.ts`, `src/audit/store_integration_test.ts`
- Modify: `src/cli/audit.ts`, `src/cli/audit_test.ts`

**Produces:** phase `request-policy` with `ruleId`, `requestPolicyKind`, and
`requestPolicyResult`; text grouping; unchanged JSON output. To keep this
intermediate commit type-correct while the old broker still emits the
unreleased egress row, old branch-only fields remain temporarily and are
removed in Task 6.

- [ ] **Step 1: Replace round-trip tests**

Use:

```ts
{
  phase: "request-policy",
  ruleId: "anthropic.messages.create",
  method: "POST",
  route: "/v1/messages",
  requestPolicyKind: "json",
  requestPolicyResult: "rewrite",
  reason: "masked-json",
}
```

Keep legacy rows without phase reading as `authorization`.

Run: `bun test src/audit/store_integration_test.ts`

Expected: FAIL.

- [ ] **Step 2: Replace types and columns**

Define `RequestPolicyKind = "bodyless" | "json"` and `RequestPolicyResult =
"pass" | "rewrite" | "block"`. Add nullable `rule_id`,
`request_policy_kind`, and `request_policy_result` throughout
create/migrate/insert/select/row conversion. Keep the old branch-only
`egress_action` field only until Task 6 so the current broker compiles; do not
read it as a request-policy field. Temporarily let `AuditPhase` include both
`"egress"` and `"request-policy"`; Task 6 deletes `"egress"` with its final
producer.

Run: `bun test src/audit/store_integration_test.ts`

Expected: PASS.

- [ ] **Step 3: Generalize CLI tests and formatter**

Group projected policy runs by session, rule ID, kind, result, and reason. Authorization rows do not break a run. Any key change does. Singletons omit `x1`. Format policy rows with method, route, rule ID, kind, and result; preserve authorization/hostexec text byte-for-byte and JSON rows individually.

Run: `bun test src/cli/audit_test.ts src/audit/store_integration_test.ts`

Expected: PASS.

- [ ] **Step 4: Verify and commit**

```bash
rg -n "phase: \"request-policy\"|requestPolicyKind|requestPolicyResult" src/audit src/cli
bun run check
git add src/audit src/cli/audit.ts src/cli/audit_test.ts
git commit -m "refactor(audit): record generic request policies"
```

Expected: generic fields are present and check passes.

---

### Task 6: Make Broker Authorization and Outcomes Rule-Aware

**Files:**
- Modify: `src/network/protocol.ts`, `src/network/protocol_test.ts`
- Modify: `src/network/broker.ts`, `src/network/broker_integration_test.ts`
- Modify cleanup: `src/audit/types.ts`, `src/audit/store.ts`, `src/audit/store_integration_test.ts`

**Produces:** allow `ruleId`, generic `request_policy_outcome`, broker-derived audit metadata, and corrected cache order.

- [ ] **Step 1: Add failing authorization tests**

Prove approval cannot override explicit deny; denial cache cannot override explicit allow; caches apply only to matched `review`; cached approval returns the newly matched ID; policy allow returns ID; ID-less allow omits it; exact path accepts query but rejects normalized/encoded lookalikes.

Run: `bun test src/network/broker_integration_test.ts --test-name-pattern "cache|rule ID|exact path"`

Expected: FAIL because caches currently precede rule matching.

- [ ] **Step 2: Reorder authorization**

Enforce IP deny, first-match resolved rule, no-match deny, explicit deny, explicit allow, then caches/prompt only for review. Carry the matched rule through waiters and decorate successful decisions with its ID. Match credentials against the real path; persist only masked review context.

Run the Step 1 command.

Expected: PASS.

- [ ] **Step 3: Define the closed protocol**

Replace egress tuples with:

```ts
interface RequestPolicyOutcomeRequest {
  version: 1;
  type: "request_policy_outcome";
  requestId: string;
  sessionId: string;
  ruleId: string;
  result: "pass" | "rewrite" | "block";
  reason: RequestPolicyReason;
}
```

The response type is `request_policy_outcome_recorded`. Validate session, ID syntax, broker-owned rule existence/policy, result, and policy-kind-specific reason pairing.

Use these exact closed reasons:

```ts
const successReasons = [
  "empty-body",
  "recognized-json",
  "masked-json",
] as const;
const blockReasons = [
  "body-unavailable",
  "unexpected-body",
  "invalid-json",
  "schema-mismatch",
  "encoded-decode-failed",
  "resource-limit",
  "key-collision",
  "serialization-failed",
  "processing-failed",
] as const;
```

Only bodyless `pass/empty-body`, JSON `pass/recognized-json`, and JSON
`rewrite/masked-json` are success pairings. Bodyless block accepts only
`body-unavailable`, `unexpected-body`, and `processing-failed`. JSON block
accepts `body-unavailable`, `invalid-json`, `schema-mismatch`,
`encoded-decode-failed`, `resource-limit`, `key-collision`,
`serialization-failed`, and `processing-failed`.

- [ ] **Step 4: Add rejection and derivation matrices**

Reject mismatched session; malformed/unknown/ID-less/non-policy IDs; unknown result/reason; bodyless/JSON reason mismatches; invalid rewrite; block with success reason. For valid outcomes, derive method, route, and kind from broker rules and persist no target/raw request data.

Run: `bun test src/network/protocol_test.ts src/network/broker_integration_test.ts --test-name-pattern "request policy outcome"`

Expected: PASS.

- [ ] **Step 5: Preserve sanitized persistence failure**

Force audit failure and assert only `request-policy outcome audit unavailable`; the already computed proxy result is unaffected.

Run: `bun test src/network/broker_integration_test.ts --test-name-pattern "audit unavailable"`

Expected: PASS.

- [ ] **Step 6: Remove the temporary egress audit shape**

Delete the old audit type/property/column now that no producer uses it. Run:

```bash
rg -n "AnthropicEgressAction|egressAction|egress_action|phase: \"egress\"" src/audit src/network
```

Expected: no matches.

- [ ] **Step 7: Commit**

```bash
bun test src/network/protocol_test.ts src/network/broker_integration_test.ts src/audit/store_integration_test.ts
rg -n "AnthropicEgressAction|egressAction|egress_action|phase: \"egress\"" src/audit src/network
git add src/network/protocol.ts src/network/protocol_test.ts src/network/broker.ts src/network/broker_integration_test.ts src/audit/types.ts src/audit/store.ts src/audit/store_integration_test.ts
git commit -m "feat(network): authorize request-policy rules"
```

Expected: tests pass and the `rg` command has no matches.

---

### Task 7: Defensively Validate the Resolved Contract in Python

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Modify: `src/docker/mitmproxy/nas_addon_test.ts`
- Consume: `src/network/fixtures/resolved_review_rules/anthropic-v1.json`

**Produces:** closed Python contract validation and exact-path local pre-match.

- [ ] **Step 1: Add failing contract tests**

Accept the shared fixture. Reject unknown/missing versions; top-level list; unknown document/rule/handler/AST keys; malformed IDs; `graphql`; illegal action/policy combinations; invalid limits/child types; and policy rules missing exact fields.

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: FAIL because the loader accepts a bare list.

- [ ] **Step 2: Implement explicit closed-shape validators**

Use exact key sets and primitive checks; reject Python booleans as numeric limits. Return an invalid sentinel without printing malformed data or exceptions.

- [ ] **Step 3: Cache only valid or fail-closed state**

Cache the validated document or invalid sentinel by session/mtime. Missing, unreadable, malformed, and unknown-version files must not become an empty permissive list.

- [ ] **Step 4: Add exact local matching**

Strip only query for `path` equality. Preserve method/host/pathPrefix behavior. Test query, trailing slash, double slash, and percent-encoded lookalikes.

- [ ] **Step 5: Block invalid contracts safely**

Return the fixed request-policy 403 before credentials/upstream and emit only a constant error with safe session identifier.

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_test.ts
git commit -m "feat(proxy): validate resolved request-policy contracts"
```

---

### Task 8: Implement the Generic Bodyless and JSON Engine

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Modify: `src/docker/mitmproxy/nas_addon_test.ts`

**Produces:** pure dispatcher `(result, rewritten_body_or_none, closed_reason)` for `bodyless`/`json`; every exception blocks.

- [ ] **Step 1: Add failing body/parse tests**

Cover bodyless empty/non-empty/unavailable; JSON empty/malformed/duplicate; scalar/array roots; unchanged and changed objects. Assert `empty-body`, `unexpected-body`, `body-unavailable`, `invalid-json`, `schema-mismatch`, `recognized-json`, and `masked-json`.

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: FAIL.

- [ ] **Step 2: Implement bounded parsing/serialization**

Enforce body bytes, reject duplicate members, require object root, traverse with explicit depth/node accounting, and serialize changed JSON compactly/deterministically. Map failures precisely to `invalid-json`, `schema-mismatch`, `resource-limit`, `serialization-failed`, or final `processing-failed`.

- [ ] **Step 3: Add selector tests and implementation**

Test literals with `~0`/`~1`, `*`, zero/many descendant `**`, absent optional paths, and overlapping routes. Process a node once per distinct guard. Tagged matches require an object with own string discriminator in `allowedTags`; wrong/missing/unknown values block as `schema-mismatch`.

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: PASS after implementation.

- [ ] **Step 4: Add strict encoded-field tests**

Test discriminator no-op; required string data; unchanged/rewritten base64; invalid alphabet/padding/whitespace/line wrap mapping to `encoded-decode-failed`; cumulative decoded limit; and no second text mask of consumed data.

- [ ] **Step 5: Implement encoded fields and recursive masking**

Decode only strict standard base64, budget cumulative bytes, mask/re-encode canonically, skip consumed data during string masking, recursively mask all other strings/keys, and return `key-collision` before duplicate masked-key insertion.

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: PASS.

- [ ] **Step 6: Test limits and injected exceptions**

Test all limits at boundary/+1. Patch parse/traverse/serialize helpers to raise and assert closed reasons, fixed result, and no exception/body details in stderr.

- [ ] **Step 7: Keep the new engine additive; defer provider-specific removal to Task 9**

The generic engine is additive in this task. Do NOT remove `_KNOWN_BLOCK_TYPES`,
`_BLOCK_LIST_KEYS`, `_walk_schema`, `_schema_mask_json`, `_plan_anthropic_masking`,
permissive base64 decoding, or the old `request()` `anthropic_egress` branch here.
Their only live call site is that branch, which Task 9 owns. Removing them now would
force either a spec-forbidden hardcoded Anthropic policy in Python or pulling Task 9's
broker-ID authoritative selection forward (and temporarily making local pre-match
authoritative for policy selection, which the spec forbids). Task 9 Step 2 rewires
`request()` to broker-authoritative policy execution and deletes this cluster
atomically at the moment it replaces the call site.

Verify only that the NEW engine (`_execute_request_policy` and its helpers) contains
no provider-named branch and that its tests pass:

```bash
bun test src/docker/mitmproxy/nas_addon_test.ts
```

Expected: tests pass. The legacy cluster/branch still exist and are removed in Task 9.

- [ ] **Step 8: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_test.ts
git commit -m "feat(proxy): execute generic request policies"
```

---

### Task 9: Integrate Authoritative Selection and Safe Outcomes

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Modify: `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Produces:** broker-ID policy execution, correct credential order, generic outcomes, fixed blocks, preset integration matrix.

- [ ] **Step 1: Add failing flow tests**

Prove broker/local disagreement executes the broker ID; missing/unknown policy ID blocks; ID-less ordinary allow keeps generic masking; approved review executes policy; policy block prevents credential injection; pass/rewrite inject afterward.

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts`

Expected: FAIL.

- [ ] **Step 2: Restrict pre-match and execute broker policy**

Use local match only for bounded preview selection. Before persistence/UI, the
broker applies existing byte-pattern masks to the raw path and preview; binary
or unavailable bodies become bounded metadata, and no structural/base64
processing runs before approval. After allow, resolve `decision.ruleId`, mask
the URL and every header, obtain the body, execute policy, apply rewrite,
report outcome, block or inject credentials in that order. Ordinary no-policy
rules retain `_apply_request_masking`. As you replace this call site, delete the
now-unreachable provider-specific cluster deferred from Task 8 Step 7
(`_KNOWN_BLOCK_TYPES`, `_BLOCK_LIST_KEYS`, `_walk_schema`, `_schema_mask_json`,
`_plan_anthropic_masking`, permissive base64 decoding) and the old
`anthropic_egress` request branch.

- [ ] **Step 3: Generalize reporting and logs**

Send only version, type, requestId, sessionId, ruleId, result, and reason. Accept only `request_policy_outcome_recorded`. Audit acknowledgement failures print a constant line and do not change the computed result. Aggregate block logs at powers of two by session/rule/kind/result/reason. Every policy block uses one provider- and detail-free 403 body.

- [ ] **Step 4: Add the Docker preset matrix**

Write the versioned fixture and use a real `SessionBroker` configured with the
same resolved document; only the upstream is fake. Cover both Messages
endpoints; seven empty GETs; query masking; telemetry/eval/Files/descendants;
wrong method; trailing/double/encoded paths; unknown path; removed rule;
added/replaced rule; non-empty/unavailable body; and secret absence from
logs/outcomes. Assert blocked requests never reach fake upstream.

Run: `bun test src/docker/mitmproxy/nas_addon_integration_test.ts`

Expected: PASS or honest existing Docker skips only.

- [ ] **Step 5: Test cleanup and remove old code**

Test disconnect cleanup keeps counters for still-active sessions. Then run:

```bash
rg -n "_ANTHROPIC_|anthropic_egress|egress_outcome|ANTHROPIC-BLOCKED|_KNOWN_BLOCK_TYPES|_BLOCK_LIST_KEYS|_walk_schema|_schema_mask_json|_plan_anthropic_masking|validate=False" src/docker/mitmproxy src/network
bun test src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/nas_addon_integration_test.ts
```

Expected: no executable-code matches (fixture/test names may say Anthropic); tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_integration_test.ts
git commit -m "refactor(proxy): enforce resolved request policies"
```

---

### Task 10: Migrate the Demo and Verify the Whole Branch

**Files:**
- Modify: `.nas/config.pkl`
- Modify only task-owned files if formatting requires it.

**Produces:** explicit preset demo and final verification evidence.

- [ ] **Step 1: Migrate the demo**

Replace the switch with:

```pkl
new ReviewRulesPreset {
  id = "anthropic"
  preset = "anthropic@1"
}
```

Place it before inherited ordinary rules in a derived network value. Exclude the inherited broad `api.anthropic.com` allow so it cannot shadow the preset. Keep `mask.proxy = true`.

Run the repository config validation command, or a focused Pkl load test against `.nas/config.pkl` if no command exists.

Expected: valid config without protected-rule shadow error.

- [ ] **Step 2: Scan removed names and unfinished markers**

```bash
rg -n "anthropicEgress|egress_outcome|egressAction|phase: \"egress\"" .nas src
rg -n "TO[D]O|TB[D]|FIXM[E]|placeholde[r]" src/network/review_rules.ts src/docker/mitmproxy/nas_addon.py
```

Expected: no removed runtime terms or unfinished markers.

- [ ] **Step 3: Run standard checks**

```bash
bun run fmt
bun run lint
bun run lint:composed-effects
bun run check
```

Expected: all exit 0; retain formatter changes only in task-owned files.

- [ ] **Step 4: Run focused security suites**

```bash
bun test src/network/review_rules_test.ts src/network/protocol_test.ts src/network/broker_integration_test.ts
bun test src/audit/store_integration_test.ts src/cli/audit_test.ts
bun test src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/nas_addon_integration_test.ts
```

Expected: all non-Docker tests pass; Docker passes or uses existing honest skips.

- [ ] **Step 5: Run the full suite**

Run: `bun test`

Expected: exit 0. Record pass/fail/skip counts and investigate any new skip.

- [ ] **Step 6: Audit final security invariants**

Inspect `git diff main...HEAD` and verify both consumers share one contract; addon requires broker ID; policy block precedes credentials/upstream; secrets exist only in authenticated memory; logs/outcomes/audits/403 use closed fields; unknown contracts/kinds/tags/endpoints/errors fail closed; terminal deny cannot be bypassed by caches.

- [ ] **Step 7: Commit demo/format changes**

```bash
git add .nas/config.pkl
# If formatting changed task-owned files, add those exact paths as printed by
# `git diff --name-only`; do not stage the whole src tree.
git commit -m "docs(config): migrate Anthropic policy demo"
```

Do not create an empty commit.

- [ ] **Step 8: Run patched-superpowers whole-branch review**

Review the approved spec, this plan, and `main...HEAD`. Fix all high/medium findings with focused regression tests and dedicated commits, then rerun Steps 3–5.
