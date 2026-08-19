# Configurable Review-Rule Request Policies

## Status and relationship to the Anthropic endpoint-policy spec

This design generalizes the not-yet-released Anthropic endpoint policy from
`2026-07-23-anthropic-egress-endpoint-policy-design.md`.

Where the two documents conflict, this design takes precedence:

- `mask.anthropicEgress` is removed without a compatibility alias.
- There is no separate `network.egressPolicies` collection.
- Anthropic endpoint rules become the versioned `anthropic@1` preset, exposed
  as a Pkl function that expands into `network.reviewRules`.
- The generic name is `requestPolicy`, not `egress`.
- Protocol, audit, and log names use `request-policy`.

The earlier guarantees remain: telemetry is not acknowledged locally, Files API
uploads are not passed, unknown Anthropic endpoints fail closed, and raw
request data is not written to request-policy logs or audit entries.

## Goal

Extend `NetworkConfig.reviewRules` so a matched rule may apply a structured,
fail-closed request policy after authorization and before credential injection
or upstream forwarding.

Users can:

- enable an immutable built-in preset explicitly;
- drop or replace preset rules by stable ID using ordinary Pkl list operations;
- add exact bodyless GET rules;
- define JSON request policies with the same DSL used by built-in presets.

The first built-in preset is `anthropic@1`, provided as `anthropicV1()` in
`Schema.pkl`. The model must permit a future OpenAI preset and a future GraphQL
request-policy handler without changing the review-rule matcher, authorization
flow, or audit contract.

## Non-goals

- No OpenAI preset in this change.
- No GraphQL parser or accepted `graphql` handler kind.
- No multipart, file-upload, archive, or compressed-document handler.
- No regex endpoint matching or executable predicates.
- No telemetry `local-success`.
- No compatibility support for `mask.anthropicEgress`.
- No automatic preset selection from `profile.agent`.

## Configuration model

`network.reviewRules` stays an ordered `Listing<ReviewRule>`. Presets are Pkl
functions that return `List<ReviewRule>`, so a preset is not a distinct
configuration node: by the time the TypeScript compiler sees the config, there
are only ordinary review rules.

### ReviewRule

The existing fields remain valid:

```text
ReviewRule
  id?: String
  method?: String
  host?: String
  pathPrefix?: String
  action: "allow" | "review" | "deny"
  audit?: Boolean
```

The new fields are:

```text
  path?: String
  requestPolicy?: BodylessRequestPolicy | JsonRequestPolicy
```

Rules without `requestPolicy` preserve the existing network behavior.

Validation:

- `path` compares the query-free raw path by exact string equality. Matching
  does not normalize slashes, remove a trailing slash, percent-decode, or
  otherwise canonicalize the path.
- `path` and `pathPrefix` are mutually exclusive.
- A rule with `requestPolicy` requires `id`, `host`, `method`, and `path`.
- A request-policy `host` must be one exact hostname, not a wildcard or
  host-port pattern.
- In version 1, `BodylessRequestPolicy` requires `method = "GET"` and
  `JsonRequestPolicy` requires `method = "POST"`.
- `deny` may not carry a `requestPolicy`.
- IDs use `[a-z][a-z0-9._-]{0,63}`.
- Existing rules without IDs remain valid.

The raw path is used only for matching inside the existing authenticated
addon-to-broker flow. It is not copied into request-policy outcome messages or
block logs.

### Built-in presets

A preset is a function on the `Schema.pkl` module. It takes a rule-ID prefix
and an exact host, and returns a plain `List<ReviewRule>`:

```pkl
network {
  reviewRules {
    // 追加ルールは終端 deny より前に置く (first-match)。
    new ReviewRule {
      id = "anthropic.company-bootstrap"
      method = "GET"
      host = "api.anthropic.com"
      path = "/company/bootstrap"
      action = "allow"
      requestPolicy = new BodylessRequestPolicy {}
    }
    for (r in module.anthropicV1("anthropic", "api.anthropic.com")
                .filter((r) -> r.id != "anthropic.bodyless.settings")) { r }
  }
}
```

```text
anthropicV1(prefix: String, host: String): List<ReviewRule>
```

`prefix` is a safe namespace for runtime rule IDs and uses the same safe-ID
syntax; every returned rule is named `<prefix>.<localId>`, for example
`anthropic.messages.create`. Applying the same preset to two hosts requires two
prefixes, otherwise the IDs collide and the compiler reports a duplicate.

`host` replaces the preset's default host and must be one exact hostname. This
supports a compatible private gateway without weakening host matching.

Why a Pkl function and not a configuration node:

- `.nas/Schema.pkl` is overwritten from the shipped asset on every load, so a
  preset defined there is as immutable as a TypeScript constant was — a user
  cannot edit the preset body.
- Only `config.pkl`, `Schema.pkl`, and `PklProject` are kept in `.nas/`, so
  shipping the preset inside `Schema.pkl` needs no runtime changes at all.
- A new provider can be added in Pkl alone.

Pkl scoping note: inside an amend block such as `reviewRules { ... }` the
receiver is the `Listing`, and unqualified method resolution does not walk up to
the module. Preset calls therefore need the `module.` qualifier.

Overlays are ordinary list operations rather than a dedicated mechanism:

- to drop a rule, `filter` it out by ID;
- to replace one, filter it out and append your own rule;
- to add an endpoint, place it **before** the preset so first-match reaches it
  ahead of the terminal deny.

This is strictly less validated than the previous `removeRules` / `addRules`
overlay: a typo in a filtered ID is silently a no-op, and there is no check
that an addition's host matches the preset host. The compensating guarantee is
the shadowing check below — an addition placed after the terminal deny is a
configuration error, not a silently dead rule.

Duplicate IDs and duplicate exact `method + host + path` matchers remain
configuration errors, as does an ID longer than 64 bytes; the runtime protocol
never accepts one.

Preset versions are immutable. A nas release never adds an allowed endpoint to
an existing version. API changes produce `anthropicV2`, and users opt in
explicitly. This prevents a nas update from silently widening egress.

Any earlier rule that fully shadows a *protected* rule is a configuration error
rather than the existing warning. Users must reorder the rules or drop the
protected rule. A rule is protected when it carries a `requestPolicy` **or**
has an `id`.

The `id` half of that condition is what keeps the preset's terminal
`default-deny` — which carries no `requestPolicy` — from being silently covered
by an earlier blanket `allow`. The rationale generalizes: a rule the user
bothered to name is one they meant to reach, so it should not be quietly dead.
Rules without an `id` keep the previous warn-only behavior.

For this check, an earlier rule `A` fully shadows a protected rule `B` exactly
when every request matched by `B` is also matched by `A`. The compiler uses
these testable per-field subsumption rules:

- Method: if `B.method` is absent, `A.method` must be absent. If `B.method` is
  present, `A.method` is absent or equal case-insensitively.
- Host: protected rules always have one exact, non-port-qualified host.
  `A.host` is absent, the same exact host, or an existing wildcard pattern that
  matches that host. A port-qualified `A.host` does not subsume it because the
  protected rule matches every port.
- Path: if `B` has no path constraint, `A` must also have none. If `B.path` is
  exact, `A` has no path constraint, has the same exact path, or has a
  `pathPrefix` for which the existing `matchesPathPrefix(B.path, A.pathPrefix)`
  returns true. If a future protected rule has `B.pathPrefix`, `A` must have no
  path constraint or a prefix that is equal to or a segment-boundary ancestor
  of `B.pathPrefix`; an exact path cannot subsume a prefix.

Rule action does not affect shadowing because first-match evaluation prevents
`B` from being selected regardless of what `A` decides. If the compiler cannot
prove subsumption with these rules, it does not raise this hard error.

## Authorization and cache semantics

`action` and `requestPolicy` are orthogonal:

- `action` decides whether the request is authorized.
- `requestPolicy` inspects and possibly rewrites an authorized request.

Evaluation order is:

1. Apply the existing deny-by-default IP policy.
2. Find the first matching resolved review rule.
3. If no rule matches, deny.
4. If the rule action is `deny`, deny. A cached approval cannot override it.
5. If the action is `allow`, authorize directly.
6. If the action is `review`, consult the existing session decision caches and
   prompt when no reusable decision exists.
7. If authorization succeeds and the matched rule has `requestPolicy`, execute
   it before credential injection and forwarding.

Approval and denial caches apply only while resolving a currently matched
`review` rule. They do not override explicit `allow` or `deny` rules. A
host-scoped approval may satisfy another `review` rule for that host, but the
newly matched rule's own request policy still executes.

The broker returns the authoritative resolved rule ID with an allow decision.
The addon selects the request policy by that ID from the same resolved
review-rules document. Its local pre-match is used only to decide whether a
body preview is needed for an interactive review; it is not authoritative for
request-policy selection.

For `action = "review"`, the request policy does not run before the human
decision. The addon sends the current bounded preview over the authenticated
per-session UDS. Before persistence or UI display, the broker applies the
existing `mask.values` byte-pattern masking to the path and preview. A binary
or unavailable body is represented by bounded metadata rather than raw bytes.
The preview does not perform JSON structural validation or encoded-field
decoding; those fail-closed checks run only after approval and before
forwarding.

## Request-policy handlers

The public handler model is a tagged union. Version 1 accepts `bodyless` and
`json`. Unknown kinds, including `graphql`, are configuration errors and
runtime fail-closed errors.

GraphQL support can later add a new handler and parser while reusing exact
endpoint matching, authorization, outcome reporting, audit, and fixed block
responses.

### BodylessRequestPolicy

A bodyless policy passes only when:

- the request body is available; and
- its decoded length is exactly zero.

A non-empty body produces `unexpected-body`. An unavailable or undecodable
body produces `body-unavailable`. Both block before credential injection and
upstream connection.

### JsonRequestPolicy

```pkl
new JsonRequestPolicy {
  maxBodyBytes = 33554432
  maxDepth = 64
  maxNodes = 200000
  maxDecodedBytes = 33554432

  taggedUnions {
    new TaggedUnionGuard {
      at = "/messages/*/content/*"
      discriminator = "type"
      allowedTags {
        "text"
        "image"
        "document"
        "tool_use"
        "tool_result"
      }
    }
  }

  encodedFields {
    new EncodedField {
      at = "/messages/*/content/*/source"
      whenField = "type"
      whenEquals = "base64"
      dataField = "data"
      encoding = "base64"
    }
  }
}
```

The four limits default to the shown values. They are also hard ceilings in
version 1, so configuration may only lower them:

- body bytes: 32 MiB;
- JSON depth: 64;
- visited nodes: 200,000;
- total decoded encoded-field bytes per request: 32 MiB.

With version 1's strict base64-only decoder, decoded bytes are mathematically
bounded below the enclosing 32 MiB body limit. `maxDecodedBytes` remains an
explicit cumulative defense-in-depth budget so future encoding kinds cannot
silently introduce unbounded aggregate decode work.

Processing is:

1. Obtain the decoded body and enforce the byte limit.
2. Parse JSON while rejecting duplicate object members. Empty, malformed, or
   duplicate-member JSON produces `invalid-json`.
3. Require an object root.
4. Traverse with depth and node accounting.
5. Validate every matching tagged-union guard.
6. Decode, mask, and re-encode every matching encoded field.
7. Apply existing secret patterns recursively to every string value and every
   object key, except encoded data fields already consumed by step 6.
8. Fail closed if masking two keys would create a duplicate key.
9. Serialize with a deterministic compact JSON representation only when the
   body changed.

If the body is valid and unchanged, the result is `pass`. If it is rewritten,
the result is `rewrite`.

The parser does not rely on `Content-Type`; the exact endpoint rule selects the
JSON handler. A non-object root produces `schema-mismatch`, a masked-key
collision produces `key-collision`, and serialization failure produces
`serialization-failed`.

### Restricted selector grammar

`TaggedUnionGuard.at` and `EncodedField.at` use a restricted JSON Pointer
pattern:

- literal segments use JSON Pointer `~0` and `~1` escaping;
- `*` matches exactly one object member or array element;
- `**` matches zero or more descendants;
- regex, filters, script expressions, and percent decoding do not exist.

Traversal is deterministic and a node matched through multiple selector paths
is processed once for each distinct guard, not once per traversal route. The
global depth and node limits bound recursive `**` evaluation.

For a tagged-union match:

- the selected node must be an object;
- the discriminator must be its own string property;
- the value must be present in `allowedTags`.

No selector match is valid because the corresponding API field is optional.
A matched node with the wrong shape, a missing discriminator, or an unknown tag
produces `schema-mismatch`.

For an encoded-field match:

- a match on a non-object node is skipped, not blocked;
- if `whenField` does not equal `whenEquals`, the rule does nothing;
- if it does match, `dataField` must be a string;
- version 1 accepts only strict standard `base64`;
- decode failure produces `encoded-decode-failed`;
- decoded bytes receive the existing byte-pattern masking;
- changed bytes are re-encoded canonically.

An encoded `dataField` consumed by this rule is not subsequently treated as an
ordinary string. This avoids corrupting its encoded representation through a
second textual replacement pass.

The non-object skip above is deliberate and differs from the tagged-union rule,
which does block on a wrong-shaped node. An encoded-field selector names a set
of candidate carriers rather than a required structure: `anthropic@1` selects
`/**`, which matches every scalar and array in the document, so blocking on
non-object matches would reject every request. A non-object node cannot carry a
`dataField` member, so skipping it cannot leave an undecoded secret unmasked —
all such nodes still receive ordinary recursive string masking. Tagged unions
keep the strict blocking reading because their selectors name a structure the
request is asserting, and an unfamiliar shape there must fail closed.

A consequence is that pointing an encoded-field selector one level too high, at
an array rather than at its object elements, degrades to a silent no-op instead
of an error. Custom policies must select the object that owns the encoded
member.

The encoding field is an enum so a future version can add
`data-url-base64` without changing the containing AST. Version 1 rejects it.
Strict decoding deliberately rejects whitespace and line-wrapped MIME-style
base64; this is an availability trade-off in exchange for one canonical input
language.

## `anthropic@1`

`anthropicV1(prefix, host)` is normally called with
`host = "api.anthropic.com"`.

JSON rules:

| local rule ID | method | exact path | action | request policy |
| --- | --- | --- | --- | --- |
| `messages.create` | POST | `/v1/messages` | allow | JSON |
| `messages.count-tokens` | POST | `/v1/messages/count_tokens` | allow | JSON |

Bodyless rules:

| local rule ID | method | exact path | action |
| --- | --- | --- | --- |
| `bodyless.bootstrap` | GET | `/api/claude_cli/bootstrap` | allow |
| `bodyless.penguin-mode` | GET | `/api/claude_code_penguin_mode` | allow |
| `bodyless.policy-limits` | GET | `/api/claude_code/policy_limits` | allow |
| `bodyless.settings` | GET | `/api/claude_code/settings` | allow |
| `bodyless.mcp-registry` | GET | `/mcp-registry/v0/servers` | allow |
| `bodyless.code-triggers` | GET | `/v1/code/triggers` | allow |
| `bodyless.mcp-servers` | GET | `/v1/mcp_servers` | allow |

The final `default-deny` rule matches the exact preset host and has action
`deny`. It has no request policy.

The JSON policy expresses the existing Anthropic behavior as data. Its
tagged-union selectors name **only the places that actually carry message
content**:

```text
/messages/*/content/*
/messages/*/content/*/content/*
/messages/*/content/*/source/content/*
/messages/*/content/*/content/*/source/content/*
/system/*
```

They deliberately avoid `**`. A `**` selector reaches arbitrary depth, so
`/**/content/*` also matches `tools[].input_schema.properties.content` — and
Claude Code sends a `Write` tool with a `content` parameter on every request.
The tool's JSON Schema (`{"type": "string"}`) then fails the tag check and the
request is blocked as `schema-mismatch`.

The cost of dropping `**` is that every place a content block can nest must be
enumerated; anything missed falls outside the fail-closed net. Version 1
enumerates:

- directly under a message;
- one level down, inside a `tool_result` or `search_result` `content`;
- inside a `document` whose `source.type` is `"content"`, which can appear
  under either of the two positions above.

An unknown tag at any of those positions still blocks, so narrowing does not
weaken fail-closed behavior for the shapes the API defines.

All five use discriminator `type` and this exact allowed-tag set:

```text
text
image
document
thinking
redacted_thinking
tool_use
tool_result
server_tool_use
web_search_tool_result
code_execution_tool_result
mcp_tool_use
mcp_tool_result
search_result
container_upload
```

Its encoded-field rule selects `/**`, requires `type = "base64"`, reads
`data`, and uses strict `base64`. The broad selector is correct here: it names
*candidate carriers* of a base64 payload rather than imposing a structural
requirement, and non-objects are skipped rather than blocked.

These complete known-tag and selector lists live in preset data, not in
provider-named branches in the Python addon.

`fallback` is intentionally not a wildcard and is not in `anthropic@1`.
Neither the observed-request note nor the
[current official SDK input-block union](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)
establishes it as an accepted request content-block type. A request that uses
it fails closed until a verified preset version adds a concrete type.

Telemetry, eval, Files API, descendant Files paths, and all other endpoints
reach `default-deny`. Files and multipart uploads have no handler that a preset
can accidentally select. A user would have to filter out or precede the
terminal rule and add an explicit supported request policy; there is no generic
passthrough inside the preset.

Query strings do not participate in exact-path matching. Exact matching does
not percent-decode, normalize doubled slashes, or remove trailing slashes. URL
and header masking still runs before upstream forwarding.

## Relationship to MaskConfig

`requestPolicy` is configured under `NetworkConfig`, but structured masking
continues to consume `mask.values`.

- Any resolved request policy, including `BodylessRequestPolicy`, requires
  `mask.proxy = true`. This validation is independent of which other preset
  rules the user kept.
- `mask.values` remains the only secret-source configuration.
- Secret resolution stays in the host-side broker/stage boundary.
- Resolved secret values are never written to the review-rules file or session
  registry.
- The addon receives mask values only in an authenticated broker allow
  response, as it does today.

Consequently, every bodyless pass applies the configured mask patterns to the
URL and all headers before forwarding, even when every JSON rule was removed
from the preset. An empty `mask.values` list yields an empty pattern set but
does not bypass the masking phase.

The existing `mask.proxy` behavior for rules without `requestPolicy` is
unchanged.

## Runtime data flow and component boundaries

The host resolves configuration once:

```text
Pkl config (presets already expanded to ReviewRule by Pkl)
  -> pure validation and shadow analysis
  -> ResolvedReviewRules { contractVersion: 1, rules: [...] }
       -> existing per-session review-rules JSON
       -> SessionBroker configuration
```

The proxy stage calls the pure compiler and passes the result to existing
stage-facing services. It performs no file, socket, or Docker primitives.

The existing network runtime service writes the resolved review-rules
document. The broker receives the same resolved value directly. The addon
defensively validates the document before using it.

Runtime request flow:

1. The addon authenticates the session.
2. It sends the existing authorization request, including the raw path only on
   the authenticated per-session UDS.
3. The broker applies the resolved first-match rules and returns the
   authoritative matched rule ID when it allows.
4. The addon masks URL and request headers before any request-policy log.
5. It loads the matched request policy by rule ID and executes it.
6. It reports a sanitized outcome.
7. If the policy passed, it injects broker-provided credentials and forwards.
8. If the policy blocked, it returns a fixed 403 without opening upstream.

The TypeScript compiler and Python addon share checked contract fixtures.
Unknown contract versions, unknown fields where the contract is closed,
unknown handler kinds, malformed rule IDs, and malformed AST nodes fail closed.

## Request-policy outcome protocol and audit

The Anthropic-specific `egress_outcome` protocol becomes the generic
`request_policy_outcome` protocol.

The addon sends only:

```text
version
type = "request_policy_outcome"
requestId
sessionId
ruleId
result = "pass" | "rewrite" | "block"
reason
```

It does not send host, raw method, raw path, query, headers, body, filename,
credential, mask value, or detected-secret status.

The broker validates:

- protocol and session version;
- session ID;
- safe rule ID syntax;
- that the rule ID identifies a resolved rule with `requestPolicy`;
- that the result and closed reason are valid for the rule's policy kind.

The broker derives method, exact route, and policy kind from its own resolved
rule. It never trusts those values from the addon.

Closed success reasons:

- bodyless `pass`: `empty-body`;
- JSON `pass`: `recognized-json`;
- JSON `rewrite`: `masked-json`.

Closed block reasons:

- `body-unavailable`;
- `unexpected-body`;
- `invalid-json`;
- `schema-mismatch`;
- `encoded-decode-failed`;
- `resource-limit`;
- `key-collision`;
- `serialization-failed`;
- `processing-failed`.

Reason mapping is fixed:

- mitmproxy cannot provide the decoded body: `body-unavailable`;
- empty or malformed JSON, including duplicate members: `invalid-json`;
- non-object root, guard shape failure, or unknown discriminator:
  `schema-mismatch`;
- declared encoded field cannot be decoded: `encoded-decode-failed`;
- any configured or hard resource budget is exceeded: `resource-limit`;
- recursive key masking would collapse two members: `key-collision`;
- deterministic JSON serialization fails: `serialization-failed`;
- an otherwise unclassified internal policy-engine exception:
  `processing-failed`.

Audit entries use:

```text
phase = "request-policy"
ruleId
method
route
requestPolicyKind = "bodyless" | "json"
requestPolicyResult = "pass" | "rewrite" | "block"
reason
```

Authorization audit remains a separate row with the same `requestId`.
Pre-existing rows without a phase still read as `authorization`.

Text audit output groups repeated identical request-policy outcomes. JSON audit
output returns individual entries unchanged.

Outcome persistence failure is a sanitized local audit error. It does not
change the already computed pass/rewrite/block result.

## Errors and safe logging

All request-policy 403 responses use one fixed body. They contain no provider,
host, method, path, query, rule ID, body detail, or parse error.

Request-policy block logs contain only:

- safe session identifier;
- validated rule ID;
- policy kind;
- result;
- closed reason;
- aggregate count.

They use the existing powers-of-two cadence for repeated identical blocks. The
aggregation key is:

```text
session + ruleId + policy kind + result + reason
```

The addon never logs a raw unmatched path. Unknown Anthropic endpoints are
normally denied by the preset's broker-side `default-deny` rule and therefore
produce only the existing sanitized authorization audit.

Configuration and preset errors prevent the session from starting. Runtime
policy-contract errors, body access errors, parser errors, selector errors,
resource-limit errors, and serialization errors block.

## Testing

### Configuration and compiler

- Existing ID-less review rules load unchanged.
- `path` exact matching excludes the query and performs no normalization or
  percent decoding.
- `path` and `pathPrefix` are mutually exclusive.
- Request-policy rules require safe IDs, exact hosts, methods, and paths.
- `deny + requestPolicy` is rejected.
- `graphql` and unknown policy kinds are rejected.
- Duplicate-ID and duplicate-endpoint cases.
- Runtime ID validation, including length overflow.
- Fully shadowed request-policy rules and fully shadowed named rules are
  rejected, including an addition placed after the terminal deny.
- ID-less rules stay unprotected and keep the warn-only behavior.
- Method, host, exact-path, prefix, absent-field, wildcard, and port-qualified
  shadow-subsumption cases.
- Existing non-policy shadow warnings remain unchanged.

### Shared contract

- The committed `anthropic-v1` fixture is generated from `Schema.pkl` through
  the real `pkl` -> `loadConfig` -> `resolveReviewRules` path, and a test fails
  if the two drift.
- Re-resolving the committed fixture is a fixed point, so it is a canonical
  resolved document.
- Python accepts every valid fixture.
- Both sides reject unknown versions, kinds, fields, invalid IDs, and malformed
  AST nodes.
- The `anthropic@1` expanded fixture contains no provider-special executable
  behavior.

### Python policy engine

- Empty, non-empty, and unavailable bodies for bodyless rules.
- JSON root, duplicate members, invalid encoding, and parse failures.
- `*`, `**`, escaped literals, overlapping selector matches, and absent paths.
- Tagged-union valid, missing, wrong-type, and unknown discriminator cases.
- Nested Anthropic content blocks.
- The **shipped** `anthropic@1` policy, taken from the fixture rather than
  hand-written, passes a realistic Claude Code request that carries a `system`
  array, a `tools` array whose schemas contain a `content` property, and a
  nested `tool_result`; and still blocks an unknown tag at each of the three
  guarded positions.
- Base64 unchanged, rewritten, malformed, and decoded-size cases.
- Strict base64 rejects whitespace and line-wrapped input.
- Recursive masking of values and keys.
- Masked-key collision blocks.
- Invalid JSON, schema mismatch, key collision, serialization failure, and
  unclassified processing errors map to their closed reasons.
- Body, depth, node, and decoded-byte limits.
- Every exception path returns a block result and fixed response.

### Broker and authorization

- Explicit deny cannot be overridden by an approval cache.
- Caches apply only to a currently matched review rule.
- A cached approval never skips the newly matched request policy.
- Broker allow decisions return the authoritative rule ID.
- Outcome session, rule ID, result, and reason validation.
- Method, route, and policy kind are derived from broker-owned rules.
- Audit persistence failures return sanitized protocol errors.
- Existing credential matching and ID-less rules do not regress.

### Preset matrix

- Both Messages endpoints use JSON policy.
- All seven observed GET endpoints pass only with an available empty body.
- Query strings do not change exact matching and are masked before forwarding.
- Telemetry, eval, Files, Files descendants, unsupported methods, trailing
  slashes, percent-encoded lookalikes, doubled slashes, and unknown paths hit
  the terminal deny.
- Filtering a preset rule out makes that endpoint hit terminal deny.
- Adding and replacing rules changes only the named exact endpoint.
- A custom prefix and host are applied to every returned rule.

### Integration and security

- A representative JSON request is passed or rewritten and reaches only the
  fake upstream.
- Bodyless non-empty and unavailable cases never reach upstream.
- Human approval of a `review` rule still executes its request policy.
- Review previews are pattern-masked before persistence/UI and do not run
  structural or encoded-field processing before approval.
- Credential injection occurs only after request-policy success.
- Raw path, query, body, headers, filenames, credentials, and mask values are
  absent from logs, outcomes, and request-policy audit rows.
- Docker tests use random resources, skip honestly without Docker, clean up
  partial setup, and cannot contact real provider endpoints.

Standard formatting, linting, composed-effect linting, type checking, Python
unit tests, Bun tests, and available Docker integration tests finish the
change.

## Security constraints

This design preserves the repository security constraints:

- Resolved secret values remain host-side and are never mounted as files into
  the agent container.
- No control socket is exposed to the agent container.
- Proxy-to-broker communication remains on authenticated per-session Unix
  sockets.
- The review-rules document contains configuration only, not resolved secrets.
- Request-policy failure is fail closed.
- The proxy stage remains orchestration-only; primitive I/O stays in the
  existing services.

## Deliberate trade-offs

- Exact paths reject provider changes until the preset or the user's own rules
  change.
- Immutable preset versions require explicit upgrades.
- Expressing overlays as Pkl list operations trades the previous overlay
  validation (unknown-ID rejection, host inheritance, automatic insertion before
  the terminal rule) for a preset mechanism that needs no TypeScript changes to
  extend. A mistyped filter ID is silently a no-op; a misplaced addition is
  caught by the named-rule shadowing check rather than the overlay compiler.
- The compact JSON DSL validates security-sensitive unions and encodings, not a
  complete standards-based JSON Schema.
- Unknown JSON fields are allowed but all string keys and values are masked.
- Opaque encodings in fields not named by `encodedFields` are not decoded; a
  custom policy must declare every encoded carrier it intends to inspect.
- Recursive selectors can conservatively block unfamiliar structures; hard
  resource limits bound their work.
- No multipart handler means file uploads remain unavailable through the
  preset.
- Integrating request policy into review rules changes cache precedence:
  explicit rules now win, and cached decisions only resolve `review` actions.
