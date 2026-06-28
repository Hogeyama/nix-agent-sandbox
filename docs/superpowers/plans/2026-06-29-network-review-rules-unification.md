# Network ReviewRules Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate `network.allowlist`, `network.prompt.denylist`, and `network.prompt.reviewRules` into a single `network.reviewRules` list with first-match evaluation; remove the `network.prompt` nesting.

**Architecture:** Replace the current three-list evaluation model (allowlist → denylist → promptEnabled) with a single ordered `reviewRules` list evaluated top-to-bottom (first match wins, no match → deny). The `NetworkPromptConfig` type and `prompt` nesting are deleted; pending-related settings move to `NetworkConfig` as flat `pending*` fields. The mitmproxy addon's review-rule matching is preserved but the broker no longer uses `matchedReviewRule` — it evaluates rules itself.

**Tech Stack:** Pkl (Schema), TypeScript (Bun runtime), Python (mitmproxy addon)

## Global Constraints

- Runtime: Bun. Tests use `bun:test`.
- Breaking change — no backwards compatibility layer.
- `matchesAllowlist` is renamed to `matchesHostPattern` (same logic, new name).
- `ReviewRule.action` gains `"allow"` as a new variant (existing `"review"` | `"deny"` kept).
- Evaluation order: deny-by-default targets → reviewRules first-match → implicit deny.
- Session-scoped approve/deny caches remain for the `review → approved` flow.

---

### Task 1: Types and Schema — replace NetworkConfig / ReviewRule / defaults

**Files:**
- Modify: `src/config/types.ts:116-291` (NetworkConfig, NetworkPromptConfig, ReviewRule, defaults)
- Modify: `src/config/Schema.pkl:162-208` (ReviewRule, NetworkPromptConfig, NetworkConfig)

**Interfaces:**
- Produces: `NetworkConfig { reviewRules: ReviewRule[]; proxy: ProxyConfig; pendingTimeoutSeconds: number; pendingDefaultScope: ApprovalScope; pendingNotify: NetworkPromptNotify; }`, `ReviewRule { method?: string; host?: string; pathPrefix?: string; action: "allow" | "review" | "deny"; }`, `DEFAULT_NETWORK_CONFIG`

- [ ] **Step 1: Update Schema.pkl**

Replace the `ReviewRule`, `NetworkPromptConfig`, and `NetworkConfig` classes:

```pkl
class ReviewRule {
  /// HTTP メソッド（大文字小文字無視）。省略時は全メソッドにマッチ。
  method: String?
  /// ホストパターン。allowlist と同じ形式（"*.example.com" 等）。省略時は全ホストにマッチ。
  host: String?
  /// パスプレフィックス。省略時は全パスにマッチ。
  pathPrefix: String?
  /// マッチ時のアクション。
  action: "allow"|"review"|"deny" = "review"
}

class NetworkConfig {
  /// ネットワークアクセス制御ルール。上から順に評価し、最初にマッチしたルールの
  /// action を適用する。どのルールにもマッチしない場合は暗黙 deny。
  reviewRules: Listing<ReviewRule> = new {}

  proxy: ProxyConfig = new {}

  /// review ルールで pending に回されたリクエストの待機秒数。タイムアウト時は deny。
  pendingTimeoutSeconds: Int = 300

  /// 承認の既定スコープ。
  pendingDefaultScope: "once"|"host-port"|"host" = "host-port"

  /// pending 発生時の通知 backend。
  pendingNotify: "auto"|"desktop"|"off" = "auto"
}
```

Delete the `NetworkPromptConfig` class entirely.

- [ ] **Step 2: Update types.ts**

Replace the TypeScript types. Delete `NetworkPromptConfig` interface and `DEFAULT_NETWORK_PROMPT_CONFIG`. Update `ReviewRule`, `NetworkConfig`, and `DEFAULT_NETWORK_CONFIG`:

```typescript
export interface ReviewRule {
  method?: string;
  host?: string;
  pathPrefix?: string;
  action: "allow" | "review" | "deny";
}

export interface NetworkConfig {
  reviewRules: ReviewRule[];
  proxy: ProxyConfig;
  pendingTimeoutSeconds: number;
  pendingDefaultScope: ApprovalScope;
  pendingNotify: NetworkPromptNotify;
}

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  reviewRules: [],
  proxy: DEFAULT_PROXY_CONFIG,
  pendingTimeoutSeconds: 300,
  pendingDefaultScope: "host-port",
  pendingNotify: "auto",
};
```

- [ ] **Step 3: Run type check to find all downstream breakages**

Run: `bun run check`
Expected: compilation errors in validate.ts, broker.ts, stage.ts, session_broker_service.ts, cli.ts, and test files. These are addressed in subsequent tasks.

- [ ] **Step 4: Commit**

```
feat(config): replace allowlist/denylist/prompt with unified reviewRules

ReviewRule.action gains "allow". NetworkPromptConfig deleted.
Pending settings moved to NetworkConfig as flat pending* fields.
```

---

### Task 2: Validation — replace allowlist/denylist checks with reviewRules validation

**Files:**
- Modify: `src/config/validate.ts:47-171` (validateProfile, validateHostList, validateAllowlistDenylistOverlap)
- Modify: `src/config/validate_test.ts` (full rewrite of network-related tests)

**Interfaces:**
- Consumes: `NetworkConfig.reviewRules: ReviewRule[]` from Task 1
- Produces: `validateProfile()` that validates `ReviewRule.host` patterns and warns on shadowing

- [ ] **Step 1: Write failing tests for reviewRules host validation**

In `src/config/validate_test.ts`, replace the `allowlist/denylist` test block (lines 107-354) with new tests:

```typescript
test("validate: reviewRules accepts valid host entries", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            reviewRules: [
              { host: "github.com", action: "allow" },
              { host: "*.anthropic.com", action: "allow" },
              { host: "example.com:443", action: "deny" },
            ],
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.reviewRules).toHaveLength(3);
});

test("validate: reviewRules rejects wildcard in middle of host", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              reviewRules: [{ host: "git*hub.com", action: "allow" }],
            },
          }),
        },
      }),
    ),
  ).toThrow("contains wildcard");
});

test("validate: reviewRules rejects trailing wildcard in host", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              reviewRules: [{ host: "github.*", action: "allow" }],
            },
          }),
        },
      }),
    ),
  ).toThrow("contains wildcard");
});

test("validate: reviewRules accepts rule with no host (catch-all)", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            reviewRules: [{ action: "review" }],
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.reviewRules).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/config/validate_test.ts`
Expected: FAIL — `makeProfile` still references old `NetworkConfig` shape.

- [ ] **Step 3: Update makeProfile in validate_test.ts**

Update the `makeProfile` helper to use the new `NetworkConfig` shape. Remove `DEFAULT_NETWORK_PROMPT_CONFIG` from imports, use `DEFAULT_NETWORK_CONFIG` which now has the new shape.

- [ ] **Step 4: Update validate.ts**

In `validateProfile()`, replace the allowlist/denylist/overlap validation (lines 50-71) with:

```typescript
// --- reviewRules host pattern validation ---
for (const [i, rule] of profile.network.reviewRules.entries()) {
  if (rule.host !== undefined) {
    errors.push(
      ...validateHostList(
        `profile "${name}": network.reviewRules[${i}].host`,
        [rule.host],
      ),
    );
  }
}

// --- reviewRules shadowing warnings ---
warnShadowedReviewRules(name, profile.network.reviewRules);
```

Delete `validateAllowlistDenylistOverlap()` entirely (lines 144-171).

Add the shadowing warning function:

```typescript
function warnShadowedReviewRules(
  profileName: string,
  rules: import("./types.ts").ReviewRule[],
): void {
  for (let i = 0; i < rules.length; i++) {
    const earlier = rules[i];
    if (earlier.method === undefined && earlier.host === undefined && earlier.pathPrefix === undefined) {
      // catch-all — everything after it is shadowed
      for (let j = i + 1; j < rules.length; j++) {
        logWarn(
          `[warn] profile "${profileName}": network.reviewRules[${i}] (catch-all, action="${earlier.action}") ` +
            `shadows reviewRules[${j}]; consider reordering`,
        );
      }
      break;
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test src/config/validate_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```
feat(config): validate reviewRules host patterns, remove allowlist/denylist overlap check
```

---

### Task 3: Protocol — rename matchesAllowlist, remove matchedReviewRule

**Files:**
- Modify: `src/network/protocol.ts:34,206-226` (AuthorizeRequest.matchedReviewRule, matchesAllowlist)
- Modify: `src/network/protocol_test.ts` (update import names)

**Interfaces:**
- Produces: `matchesHostPattern(target, hostPatterns): boolean` (renamed from `matchesAllowlist`)
- Produces: `AuthorizeRequest` without `matchedReviewRule` field

- [ ] **Step 1: Rename matchesAllowlist → matchesHostPattern in protocol.ts**

At line 206, rename the function:

```typescript
export function matchesHostPattern(
  target: NormalizedTarget,
  patterns: string[],
): boolean {
  // ... body unchanged
}
```

Also export the old name as a deprecated alias if needed, or just rename everywhere. For a breaking change, just rename.

- [ ] **Step 2: Remove matchedReviewRule from AuthorizeRequest**

In `src/network/protocol.ts:34`, remove the `matchedReviewRule?: boolean;` field from `AuthorizeRequest`.

- [ ] **Step 3: Remove allowlist/promptEnabled from SessionRegistryEntry**

In `src/network/protocol.ts:60-71`, remove `allowlist` and `promptEnabled` from `SessionRegistryEntry`:

```typescript
export interface SessionRegistryEntry {
  version: 1;
  sessionId: string;
  tokenHash: string;
  brokerSocket: string;
  profileName: string;
  createdAt: string;
  pid: number;
  agent?: string;
}
```

- [ ] **Step 4: Update protocol_test.ts imports**

Replace `matchesAllowlist` with `matchesHostPattern` in imports and all test function calls in `src/network/protocol_test.ts`.

- [ ] **Step 5: Run tests**

Run: `bun test src/network/protocol_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```
refactor(network): rename matchesAllowlist to matchesHostPattern, remove matchedReviewRule
```

---

### Task 4: Broker — first-match reviewRules evaluation

**Files:**
- Modify: `src/network/broker.ts:40-313` (BrokerOptions, SessionBroker constructor, authorize method)
- Modify: `src/network/broker_integration_test.ts` (rewrite all tests)

**Interfaces:**
- Consumes: `ReviewRule` with `action: "allow" | "review" | "deny"` from Task 1, `matchesHostPattern` from Task 3
- Produces: `SessionBroker` with new constructor accepting `reviewRules`, `pendingTimeoutSeconds`, `pendingDefaultScope`, `pendingNotify`

- [ ] **Step 1: Rewrite broker_integration_test.ts**

Replace all `SessionBroker` constructor calls to use the new interface. Key test rewrites:

```typescript
test("SessionBroker: allow rule returns allow immediately", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ host: "example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_1", "example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("review-rule");
    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("allow");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny rule returns deny immediately", async () => {
  // ... similar pattern, reviewRules: [{ host: "evil.com", action: "deny" }]
  // expect response.reason === "review-rule"
});

test("SessionBroker: review rule sends to pending", async () => {
  // ... reviewRules: [{ action: "review" }]  (catch-all)
  // expect pending queue populated, then approve
});

test("SessionBroker: no matching rule returns deny", async () => {
  // ... reviewRules: [{ host: "allowed.com", action: "allow" }]
  // send request for "other.com" → expect deny with reason "no-matching-rule"
});

test("SessionBroker: first matching rule wins", async () => {
  // reviewRules: [
  //   { host: "example.com", action: "deny" },
  //   { host: "*.com", action: "allow" },
  // ]
  // request for example.com → deny (first rule wins)
});

test("SessionBroker: deny-by-default targets blocked even with allow rule", async () => {
  // reviewRules: [{ host: "localhost", action: "allow" }]
  // request for localhost → deny ("blocked-special-host")
});
```

Keep existing tests for: pending resume after approve, close resolves pending, denied target cached as recent-deny, negative cache expires, deny with scope persists, approve after group resolved returns error, approve with unknown scope rejected.

Rewrite them to use `reviewRules: [{ action: "review" }]` (catch-all review) instead of `allowlist: [], promptEnabled: true`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/network/broker_integration_test.ts`
Expected: FAIL — `BrokerOptions` no longer accepts `allowlist`/`denylist`/`promptEnabled`.

- [ ] **Step 3: Rewrite BrokerOptions and SessionBroker constructor**

In `src/network/broker.ts`, replace `BrokerOptions`:

```typescript
interface BrokerOptions {
  paths: NetworkRuntimePaths;
  sessionId: string;
  reviewRules: ReviewRule[];
  pendingTimeoutSeconds: number;
  pendingDefaultScope: ApprovalScope;
  pendingNotify: ResolvedNotifyBackend;
  uiEnabled?: boolean;
  uiPort?: number;
  uiIdleTimeout?: number;
  negativeCacheTtlMs?: number;
  auditDir?: string;
}
```

Replace private fields:

```typescript
private readonly reviewRules: ReviewRule[];
// remove: allowlist, denylist, promptEnabled
```

Update constructor:

```typescript
constructor(options: BrokerOptions) {
  this.paths = options.paths;
  this.sessionId = options.sessionId;
  this.reviewRules = options.reviewRules;
  this.timeoutSeconds = options.pendingTimeoutSeconds;
  this.defaultScope = options.pendingDefaultScope;
  this.notify = options.pendingNotify;
  this.uiEnabled = options.uiEnabled;
  this.uiPort = options.uiPort;
  this.uiIdleTimeout = options.uiIdleTimeout;
  this.auditDir = options.auditDir;
  this.negativeCache = new TtlLruCache<string, true>({
    maxSize: 1024,
    ttlMs: options.negativeCacheTtlMs ?? 30_000,
  });
}
```

- [ ] **Step 4: Rewrite authorize() method**

Replace the allowlist → denylist → promptEnabled logic with first-match:

```typescript
private async authorize(message: AuthorizeRequest): Promise<DecisionResponse> {
  const targetStr = `${message.target.host}:${message.target.port}`;

  // deny-by-default targets (localhost, loopback, RFC1918, link-local, ULA)
  const denyReason = denyReasonForTarget(message.target);
  if (denyReason) {
    await this.recordAudit(message.requestId, "deny", denyReason, targetStr);
    return denyDecision(message.requestId, denyReason);
  }

  const targetCacheKey = targetKey(message.target);

  // Session-scoped deny/approve caches (from prior user decisions)
  if (this.deniedTargets.has(targetCacheKey) || this.deniedHosts.has(message.target.host)) {
    await this.recordAudit(message.requestId, "deny", "denied-by-user", targetStr);
    return denyDecision(message.requestId, "denied-by-user");
  }
  if (this.approvedTargets.has(targetCacheKey) || this.approvedHosts.has(message.target.host)) {
    await this.recordAudit(message.requestId, "allow", "approved", targetStr);
    return allowDecision(message.requestId, "approved");
  }
  if (this.negativeCache.get(targetCacheKey) !== undefined) {
    await this.recordAudit(message.requestId, "deny", "recent-deny", targetStr);
    return denyDecision(message.requestId, "recent-deny");
  }

  // First-match evaluation of reviewRules
  const matchedRule = this.findMatchingRule(message);
  if (matchedRule) {
    if (matchedRule.action === "allow") {
      await this.recordAudit(message.requestId, "allow", "review-rule", targetStr);
      return allowDecision(message.requestId, "review-rule");
    }
    if (matchedRule.action === "deny") {
      await this.recordAudit(message.requestId, "deny", "review-rule", targetStr);
      return denyDecision(message.requestId, "review-rule");
    }
    // action === "review" → fall through to pending
  } else {
    // No rule matched → implicit deny
    await this.recordAudit(message.requestId, "deny", "no-matching-rule", targetStr);
    return denyDecision(message.requestId, "no-matching-rule");
  }

  // Pending queue (action === "review")
  const groupKey = `${this.sessionId}:${targetCacheKey}`;
  const group = this.groups.get(groupKey) ?? (await this.createPendingGroup(groupKey, message));

  if (!group.requests.has(message.requestId)) {
    group.requests.set(message.requestId, message);
    this.requestIndex.set(message.requestId, groupKey);
    await writePendingEntry(this.paths, toPendingEntry(message, group.createdAt));
  }

  const deferred = Promise.withResolvers<DecisionResponse>();
  group.waiters.set(message.requestId, { resolve: deferred.resolve, reject: deferred.reject });
  return await deferred.promise;
}

private findMatchingRule(message: AuthorizeRequest): ReviewRule | null {
  for (const rule of this.reviewRules) {
    if (rule.method !== undefined && rule.method.toUpperCase() !== message.method.toUpperCase()) continue;
    if (rule.host !== undefined && !matchesHostPattern(message.target, [rule.host])) continue;
    if (rule.pathPrefix !== undefined) {
      const path = message.reviewContext?.path ?? "";
      if (!path.startsWith(rule.pathPrefix)) continue;
    }
    return rule;
  }
  return null;
}
```

Update the import at top of file: `matchesAllowlist` → `matchesHostPattern`.

Remove the `allowlist` and `denylist` private fields.

- [ ] **Step 5: Run tests**

Run: `bun test src/network/broker_integration_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```
feat(network): replace allowlist/denylist/prompt with first-match reviewRules in broker
```

---

### Task 5: Pipeline state and stage — update ProxyPlan, PromptState, stage planner

**Files:**
- Modify: `src/pipeline/state.ts:78-81` (PromptState)
- Modify: `src/stages/proxy/stage.ts:67-236` (ProxyPlan, planProxy)
- Modify: `src/stages/proxy/session_broker_service.ts:27-45,78-107` (SessionBrokerConfig, live impl)
- Modify: `src/stages/proxy/stage_test.ts` (update all tests)
- Modify: `src/cli.ts:272-273` (notify backend resolution)

**Interfaces:**
- Consumes: `NetworkConfig` from Task 1, `SessionBroker` from Task 4
- Produces: Updated `ProxyPlan`, `PromptState`, `planProxy()`

- [ ] **Step 1: Update PromptState in state.ts**

Remove `promptEnabled` from `PromptState`:

```typescript
export interface PromptState {
  readonly promptToken: string;
}
```

- [ ] **Step 2: Update ProxyPlan in stage.ts**

Remove `allowlist`, `denylist`, `promptEnabled` from `ProxyPlan`. The `reviewRules`, `timeoutSeconds`, `defaultScope`, `notify` fields are already there or renamed:

```typescript
export interface ProxyPlan {
  // ... keep existing fields ...
  // Remove: readonly allowlist: string[];
  // Remove: readonly denylist: string[];
  // Remove: readonly promptEnabled: boolean;
  readonly reviewRules: ReviewRule[];
  readonly pendingTimeoutSeconds: number;
  readonly pendingDefaultScope: import("../../network/protocol.ts").ApprovalScope;
  readonly pendingNotify: import("../../lib/notify_utils.ts").ResolvedNotifyBackend;
  // ... rest unchanged ...
}
```

- [ ] **Step 3: Update planProxy() in stage.ts**

Replace the config reading to use new `NetworkConfig` structure:

```typescript
export function planProxy(
  input: StageInput & Pick<PipelineState, "container" | "observability">,
  options: ProxyStageOptions = {},
): ProxyPlan {
  // ...existing setup...

  const network = input.profile.network;
  const token = generateSessionToken();
  // ... existing env/mount setup ...

  const promptState: PromptState = {
    promptToken: token,
  };

  return {
    // ...existing fields...
    reviewRules: [...network.reviewRules],
    pendingTimeoutSeconds: network.pendingTimeoutSeconds,
    pendingDefaultScope: network.pendingDefaultScope,
    pendingNotify: resolveNotifyBackend(network.pendingNotify),
    // Remove: allowlist, denylist, promptEnabled
    // ...rest unchanged...
    outputOverrides: {
      network: networkState,
      prompt: promptState,
      proxy,
      container,
    },
  };
}
```

- [ ] **Step 4: Update SessionBrokerConfig and live impl in session_broker_service.ts**

Replace `allowlist`, `denylist`, `promptEnabled` with `reviewRules` and `pending*` fields:

```typescript
export interface SessionBrokerConfig {
  readonly paths: NetworkRuntimePaths;
  readonly sessionId: string;
  readonly socketPath: string;
  readonly profileName: string;
  readonly agent?: string;
  readonly reviewRules: ReviewRule[];
  readonly pendingTimeoutSeconds: number;
  readonly pendingDefaultScope: ApprovalScope;
  readonly pendingNotify: ResolvedNotifyBackend;
  readonly uiEnabled?: boolean;
  readonly uiPort?: number;
  readonly uiIdleTimeout?: number;
  readonly auditDir?: string;
  readonly tokenHash: string;
}
```

Update the live `start` implementation to pass new field names to `SessionBroker` constructor and `writeSessionRegistry`:

```typescript
const broker = new SessionBroker({
  paths: config.paths,
  sessionId: config.sessionId,
  reviewRules: config.reviewRules,
  pendingTimeoutSeconds: config.pendingTimeoutSeconds,
  pendingDefaultScope: config.pendingDefaultScope,
  pendingNotify: config.pendingNotify,
  uiEnabled: config.uiEnabled,
  uiPort: config.uiPort,
  uiIdleTimeout: config.uiIdleTimeout,
  auditDir: config.auditDir,
});
// ...
await writeSessionRegistry(config.paths, {
  version: 1,
  sessionId: config.sessionId,
  tokenHash: config.tokenHash,
  brokerSocket: config.socketPath,
  profileName: config.profileName,
  createdAt: new Date().toISOString(),
  pid: process.pid,
  agent: config.agent,
});
```

- [ ] **Step 5: Update runProxy() in stage.ts**

The `sessionBrokerService.start()` call (around line 347-368) needs to pass new fields:

```typescript
yield* Effect.acquireRelease(
  sessionBrokerService.start({
    paths: plan.runtimePaths,
    sessionId: plan.sessionId,
    socketPath: plan.brokerSocket,
    profileName: plan.profileName,
    agent: plan.agent,
    reviewRules: plan.reviewRules,
    pendingTimeoutSeconds: plan.pendingTimeoutSeconds,
    pendingDefaultScope: plan.pendingDefaultScope,
    pendingNotify: plan.pendingNotify,
    uiEnabled: plan.uiEnabled,
    uiPort: plan.uiPort,
    uiIdleTimeout: plan.uiIdleTimeout,
    auditDir: plan.auditDir,
    tokenHash,
  }),
  (handle: SessionBrokerHandle) => handle.close(),
);
```

- [ ] **Step 6: Update cli.ts**

At line 272-273, change `effectiveProfile.network.prompt.notify` to `effectiveProfile.network.pendingNotify`:

```typescript
const networkNotify = resolveNotifyBackend(
  effectiveProfile.network.pendingNotify,
);
```

- [ ] **Step 7: Update stage_test.ts**

Rewrite the `DEFAULT_PROMPT` block and `makeProfile` helper to use new `NetworkConfig`:

```typescript
function makeProfile(
  overrides: Partial<Omit<Profile, "network">> & {
    network?: Partial<Profile["network"]>;
  } = {},
): Profile {
  const networkOverrides = overrides.network ?? {};
  const { network: _ignored, ...rest } = overrides;
  const network: Profile["network"] = {
    reviewRules: networkOverrides.reviewRules ?? [],
    proxy: networkOverrides.proxy
      ? { forwardPorts: [...networkOverrides.proxy.forwardPorts] }
      : { forwardPorts: [] },
    pendingTimeoutSeconds: networkOverrides.pendingTimeoutSeconds ?? 300,
    pendingDefaultScope: networkOverrides.pendingDefaultScope ?? "host-port",
    pendingNotify: networkOverrides.pendingNotify ?? "auto",
  };
  // ... rest unchanged
}
```

Rewrite all test assertions that reference `result.allowlist`, `result.promptEnabled`, `result.outputOverrides.prompt.promptEnabled` etc.:
- `result.allowlist` → `result.reviewRules`
- `result.promptEnabled` → removed (no longer a field)
- `result.outputOverrides.prompt.promptEnabled` → removed from PromptState
- Tests referencing `network: { allowlist: [...] }` → `network: { reviewRules: [{ host: "...", action: "allow" }] }`
- Tests referencing `network: { prompt: { enable: true } }` → `network: { reviewRules: [{ action: "review" }] }`

- [ ] **Step 8: Run all tests**

Run: `bun test src/`
Expected: PASS (except possibly integration tests needing Docker)

- [ ] **Step 9: Commit**

```
feat(stages): update proxy stage, pipeline state, and session broker for unified reviewRules
```

---

### Task 6: Mitmproxy addon — stop sending matchedReviewRule, broker handles rule matching

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py:208-243` (authorize request construction)

**Interfaces:**
- Consumes: `AuthorizeRequest` without `matchedReviewRule` from Task 3

The mitmproxy addon currently matches review rules and sets `matchedReviewRule: true` on the authorize request. With the new model, the broker itself does first-match evaluation. The addon still needs to:
1. Load review rules to decide whether to attach `reviewContext` (body preview) — we only want to capture and send body content for requests that match a rule.
2. NOT set `matchedReviewRule` (deleted from the protocol).

- [ ] **Step 1: Update addon to stop setting matchedReviewRule**

In `src/docker/mitmproxy/nas_addon.py`, around line 229-230, change:

```python
        if matched_rule:
            # Attach review context for rules that need body inspection
            authorize_req["reviewContext"] = {
                "path": request_path,
                "contentType": flow.request.headers.get("content-type"),
                "bodyPreview": body_preview,
                "bodySize": len(body_bytes),
            }
            # matchedReviewRule removed — broker evaluates rules directly
```

Remove the line `authorize_req["matchedReviewRule"] = True`.

The addon's rule loading and matching logic stays — it's used to decide when to capture and send `reviewContext` body previews (expensive for every request).

- [ ] **Step 2: Always send reviewContext path info**

For allow/review/deny rules that match, always send at least the path (no body for allow rules, body for review rules). Actually, keep current behavior: only send reviewContext when a rule matches. The broker uses rule evaluation, not the presence of reviewContext, to decide the action.

- [ ] **Step 3: Commit**

```
fix(addon): stop sending matchedReviewRule, broker evaluates rules directly
```

---

### Task 7: Project config and migration guide

**Files:**
- Modify: `.nas/config.pkl` (rewrite network section)
- Create: `docs/migration/network-review-rules.md` (migration guide for AI-assisted rewrite)

**Interfaces:**
- Consumes: New `Schema.pkl` from Task 1

- [ ] **Step 1: Rewrite .nas/config.pkl**

Replace the `commonNetwork` block:

```pkl
local function allow(host: String) = new ReviewRule { host = host; action = "allow" }
local function deny(host: String) = new ReviewRule { host = host; action = "deny" }

local commonNetwork: NetworkConfig = new {
  reviewRules {
    // Deny: telemetry endpoints
    deny("http-intake.logs.us5.datadoghq.com")
    deny("copilot-telemetry.githubusercontent.com")

    // Allow: Anthropic / Claude
    for (h in List(
      "api.anthropic.com",
      "statsig.anthropic.com",
      "platform.claude.com",
      "mcp-proxy.anthropic.com",
      "code.claude.com",
      "claude.ai",
      "downloads.claude.ai",
    )) { allow(h) }

    // Allow: OpenAI / ChatGPT
    for (h in List(
      "api.openai.com",
      "*.api.openai.com",
      "ab.chatgpt.com",
      "chatgpt.com",
      "developers.openai.com",
    )) { allow(h) }

    // Allow: Google
    allow("storage.googleapis.com")

    // Allow: GitHub
    for (h in List(
      "api.github.com",
      "release-assets.githubusercontent.com",
      "codeload.github.com",
      "github.com",
      "gist.github.com",
      "raw.githubusercontent.com",
      "api.githubcopilot.com",
      "telemetry.individual.githubcopilot.com",
      "api.individual.githubcopilot.com",
      "telemetry.business.githubcopilot.com",
      "api.business.githubcopilot.com",
      "camo.githubusercontent.com",
      "avatars.githubusercontent.com",
    )) { allow(h) }

    // Allow: Docker Hub
    for (h in List(
      "registry-1.docker.io",
      "auth.docker.io",
      "index.docker.io",
      "hub.docker.com",
      "www.docker.com",
      "production.cloudflare.docker.com",
      "download.docker.com",
    )) { allow(h) }

    // Allow: Container Registries
    for (h in List(
      "*.gcr.io",
      "ghcr.io",
      "mcr.microsoft.com",
      "*.data.mcr.microsoft.com",
      "public.ecr.aws",
    )) { allow(h) }

    // Allow: Package Registries
    for (h in List(
      "registry.npmjs.org",
      "jsr.io",
      "deno.land",
      "dl.deno.land",
      "esm.sh",
      "httpbin.org",
    )) { allow(h) }

    // Review: specific patterns
    new { method = "POST"; host = "httpbin.org"; action = "review" }

    // Catch-all: send unknown traffic to pending queue
    new { action = "review" }
  }
  proxy {
    forwardPorts = new Listing {
      8080
      5432
      3939
    }
  }
}
```

- [ ] **Step 2: Run pkl eval to verify config is valid**

Run: `pkl eval .nas/config.pkl`
Expected: valid JSON output with new structure

- [ ] **Step 3: Write migration guide**

Create `docs/migration/network-review-rules.md`:

```markdown
# Network Config Migration: reviewRules Unification

This guide is designed to be handed to an AI assistant to mechanically rewrite
your `.nas/config.pkl` file.

## What Changed

The `network` section of `config.pkl` has been restructured:

| Before | After |
|--------|-------|
| `network.allowlist` | `network.reviewRules` entries with `action = "allow"` |
| `network.prompt.enable` | Catch-all `new { action = "review" }` at end of rules (or omit for deny-all) |
| `network.prompt.denylist` | `network.reviewRules` entries with `action = "deny"` |
| `network.prompt.timeoutSeconds` | `network.pendingTimeoutSeconds` |
| `network.prompt.defaultScope` | `network.pendingDefaultScope` |
| `network.prompt.notify` | `network.pendingNotify` |
| `network.prompt.reviewRules` | Merged into `network.reviewRules` |

## Evaluation Model

Rules are evaluated top-to-bottom. The first matching rule wins:
- `action = "allow"` → request is immediately allowed
- `action = "deny"` → request is immediately denied
- `action = "review"` → request goes to pending queue for user approval

If no rule matches, the request is **denied** (implicit deny).

**Important:** Rule ordering matters. Place deny rules before allow rules for
the same host if you want deny to take precedence. Place a catch-all
`new { action = "review" }` at the end to send unmatched traffic to pending
(replaces `prompt.enable = true`).

## Step-by-Step Conversion

### 1. Convert denylist entries to deny rules

```pkl
// Before:
prompt {
  denylist = new Listing { "evil.com"; "telemetry.example.com" }
}

// After (place BEFORE allow rules):
reviewRules {
  new { host = "evil.com"; action = "deny" }
  new { host = "telemetry.example.com"; action = "deny" }
}
```

### 2. Convert allowlist entries to allow rules

```pkl
// Before:
allowlist = new Listing { "api.anthropic.com"; "*.github.com" }

// After:
reviewRules {
  new { host = "api.anthropic.com"; action = "allow" }
  new { host = "*.github.com"; action = "allow" }
}
```

Use Pkl helper functions to reduce verbosity:

```pkl
local function allow(host: String) = new ReviewRule { host = host; action = "allow" }
local function deny(host: String) = new ReviewRule { host = host; action = "deny" }

reviewRules {
  deny("evil.com")
  for (h in List("api.anthropic.com", "*.github.com")) { allow(h) }
}
```

### 3. Convert existing reviewRules

```pkl
// Before:
prompt {
  reviewRules {
    new { method = "POST"; host = "httpbin.org"; action = "review" }
  }
}

// After (place in the reviewRules list):
reviewRules {
  // ... deny rules ...
  // ... allow rules ...
  new { method = "POST"; host = "httpbin.org"; action = "review" }
}
```

### 4. Replace prompt.enable with catch-all

```pkl
// Before:
prompt { enable = true }

// After (place as the LAST rule):
reviewRules {
  // ... all other rules ...
  new { action = "review" }  // catch-all: unmatched → pending
}

// If prompt.enable was false (or default), simply omit the catch-all.
// Unmatched requests will be denied.
```

### 5. Flatten prompt settings

```pkl
// Before:
prompt {
  timeoutSeconds = 600
  defaultScope = "host"
  notify = "desktop"
}

// After (direct fields on network):
pendingTimeoutSeconds = 600
pendingDefaultScope = "host"
pendingNotify = "desktop"
```

## Complete Before/After Example

```pkl
// ===== BEFORE =====
local commonNetwork: NetworkConfig = new {
  allowlist = new Listing {
    "api.anthropic.com"
    "*.github.com"
  }
  prompt {
    enable = true
    denylist = new Listing {
      "telemetry.example.com"
    }
    timeoutSeconds = 600
    reviewRules {
      new { method = "POST"; host = "httpbin.org"; action = "review" }
    }
  }
}

// ===== AFTER =====
local function allow(host: String) = new ReviewRule { host = host; action = "allow" }
local function deny(host: String) = new ReviewRule { host = host; action = "deny" }

local commonNetwork: NetworkConfig = new {
  reviewRules {
    deny("telemetry.example.com")
    for (h in List("api.anthropic.com", "*.github.com")) { allow(h) }
    new { method = "POST"; host = "httpbin.org"; action = "review" }
    new { action = "review" }  // catch-all (replaces prompt.enable = true)
  }
  pendingTimeoutSeconds = 600
}
```
```

- [ ] **Step 4: Commit**

```
docs: add network reviewRules migration guide, rewrite project config
```

---

### Task 8: Final verification — type check and full test suite

**Files:**
- No new files — verification only

- [ ] **Step 1: Run type check**

Run: `bun run check`
Expected: PASS — no type errors

- [ ] **Step 2: Run unit tests**

Run: `bun test src/`
Expected: PASS

- [ ] **Step 3: Verify pkl eval of project config**

Run: `pkl eval .nas/config.pkl`
Expected: valid JSON output

- [ ] **Step 4: Commit spec and plan (if not already committed)**

```
docs: add network reviewRules unification spec and plan
```
