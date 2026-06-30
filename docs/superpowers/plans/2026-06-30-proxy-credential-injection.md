# Proxy Credential Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the mitmproxy proxy to automatically inject authentication headers (e.g. `Authorization: token <GITHUB_TOKEN>`) into proxied requests based on host/path/method matching, so sandboxed agents can access authenticated APIs without direct credential access.

**Architecture:** Credentials are defined in `NetworkConfig.credentials` as `CredentialRule[]` with `val`/`valCmd` value specs. At session startup, `NetworkRuntimeService.resolveCredentials()` executes `valCmd` commands on the host. Resolved values are passed to `SessionBroker` in-memory. When the broker returns an `allow` decision, it includes matching credentials as `injectHeaders` in the `DecisionResponse`. The mitmproxy addon attaches these headers before forwarding.

**Tech Stack:** Effect (service layer), Bun (runtime + tests), Pkl (config schema), Python (mitmproxy addon)

## Global Constraints

- Runtime: Bun. Tests use `bun:test`.
- Tests import from relative paths, not import maps.
- Effect services follow the `Context.Tag` + `Live` + `Fake` pattern (see `effect-separation` skill).
- Config schema: Pkl (`src/config/Schema.pkl`) + TypeScript (`src/config/types.ts`).
- Stage code orchestrates service calls only — no direct I/O primitives (see `effect-separation` skill).
- Test patterns: unit tests use fakes with call-recording, integration tests use temp dirs with `try/finally` cleanup (see `test-policy` skill).
- Forbidden headers for injection: `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Proxy-Authorization`, `Proxy-Connection`, `Keep-Alive`, `TE`, `Trailer`, `Upgrade`.
- Credential matching is **all-match** (all matching rules inject), not first-match.
- Credential injection is independent from review rules — credentials only inject headers, access control requires separate review rules.

---

### Task 1: Config types, Pkl schema, and validation

**Files:**
- Modify: `src/config/Schema.pkl:162-188` (add `CredentialRule` class, update `NetworkConfig`)
- Modify: `src/config/types.ts:116-132` (add `CredentialValSpec`, `CredentialRule`, update `NetworkConfig`)
- Modify: `src/config/types.ts:271-277` (update `DEFAULT_NETWORK_CONFIG`)
- Modify: `src/config/validate.ts:47-98` (add credential validation in `validateProfile`)
- Test: `src/config/validate_test.ts` (new — credential validation tests)

**Interfaces:**
- Produces: `CredentialValSpec` type, `CredentialRule` interface, `NetworkConfig.credentials: CredentialRule[]`, `FORBIDDEN_CREDENTIAL_HEADERS` constant

- [ ] **Step 1: Add `CredentialRule` class to Pkl schema**

In `src/config/Schema.pkl`, add after the `ReviewRule` class (after line 171) and before `NetworkConfig`:

```pkl
class CredentialRule {
  /// ホストパターン。"*.example.com" 等のワイルドカード対応。
  host: String

  /// パスプレフィックス。省略時は全パスにマッチ。
  pathPrefix: String?

  /// HTTP メソッド（大文字小文字無視）。省略時は全メソッドにマッチ。
  method: String?

  /// 注入するヘッダー名。"Authorization" 等。
  header: String

  /// ヘッダー値（固定値）。`valCmd` と排他。
  val: String?

  /// ヘッダー値をコマンド出力から取得する。`val` と排他。
  valCmd: String?
}
```

Add `credentials` field to `NetworkConfig` (after `reviewRules` line 176):

```pkl
  /// ホスト別認証情報。allow 判定されたリクエストにヘッダーを注入する。
  /// アクセス許可は reviewRules で別途設定が必要。
  credentials: Listing<CredentialRule> = new {}
```

- [ ] **Step 2: Run Pkl eval to verify schema compiles**

Run: `bun run check`
Expected: No Pkl schema errors

- [ ] **Step 3: Add TypeScript types**

In `src/config/types.ts`, add after line 124 (after `ReviewRule`):

```typescript
/** Credential の値指定 */
export type CredentialValSpec = { val: string } | { valCmd: string };

/** ホスト別認証情報 */
export interface CredentialRule {
  host: string;
  pathPrefix?: string;
  method?: string;
  header: string;
  value: CredentialValSpec;
}
```

Update `NetworkConfig` (line 126) to add `credentials`:

```typescript
export interface NetworkConfig {
  reviewRules: ReviewRule[];
  credentials: CredentialRule[];
  proxy: ProxyConfig;
  pendingTimeoutSeconds: number;
  pendingDefaultScope: ApprovalScope;
  pendingNotify: NetworkPromptNotify;
}
```

Update `DEFAULT_NETWORK_CONFIG` (line 271) to add `credentials: []`:

```typescript
export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  reviewRules: [],
  credentials: [],
  proxy: DEFAULT_PROXY_CONFIG,
  pendingTimeoutSeconds: 300,
  pendingDefaultScope: "host-port",
  pendingNotify: "auto",
};
```

- [ ] **Step 4: Run type check**

Run: `bun run check`
Expected: Type errors in files that construct `NetworkConfig` without `credentials`. Fix each by adding `credentials: []`.

- [ ] **Step 5: Write failing validation tests**

Create `src/config/validate_test.ts`:

```typescript
import { expect, test } from "bun:test";
import { validateConfig } from "./validate.ts";
import type { Config, CredentialRule, Profile } from "./types.ts";
import {
  DEFAULT_AWS_CONFIG,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_GPP_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_NIX_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
} from "./types.ts";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    session: DEFAULT_SESSION_CONFIG,
    nix: DEFAULT_NIX_CONFIG,
    docker: DEFAULT_DOCKER_CONFIG,
    gcloud: DEFAULT_GCLOUD_CONFIG,
    aws: DEFAULT_AWS_CONFIG,
    gpg: DEFAULT_GPP_CONFIG,
    network: DEFAULT_NETWORK_CONFIG,
    dbus: DEFAULT_DBUS_CONFIG,
    display: DEFAULT_DISPLAY_CONFIG,
    extraMounts: [],
    env: [],
    hook: DEFAULT_HOOK_CONFIG,
    ...overrides,
  };
}

function makeConfig(profile: Profile): Config {
  return {
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
    profiles: { default: profile },
  };
}

test("validateConfig: credential with forbidden header rejects", () => {
  const forbidden = [
    "Host", "Content-Length", "Transfer-Encoding", "Connection",
    "Proxy-Authorization", "Proxy-Connection", "Keep-Alive",
    "TE", "Trailer", "Upgrade",
  ];
  for (const header of forbidden) {
    const profile = makeProfile({
      network: {
        ...DEFAULT_NETWORK_CONFIG,
        credentials: [
          { host: "example.com", header, value: { val: "x" } },
        ],
      },
    });
    expect(() => validateConfig(makeConfig(profile))).toThrow(
      /forbidden.*header/i,
    );
  }
});

test("validateConfig: credential with valid header passes", () => {
  const profile = makeProfile({
    network: {
      ...DEFAULT_NETWORK_CONFIG,
      credentials: [
        { host: "github.com", header: "Authorization", value: { val: "token abc" } },
      ],
    },
  });
  expect(() => validateConfig(makeConfig(profile))).not.toThrow();
});

test("validateConfig: credential with invalid host pattern rejects", () => {
  const profile = makeProfile({
    network: {
      ...DEFAULT_NETWORK_CONFIG,
      credentials: [
        { host: "foo.*.bar.com", header: "Authorization", value: { val: "x" } },
      ],
    },
  });
  expect(() => validateConfig(makeConfig(profile))).toThrow(/wildcard/i);
});

test("validateConfig: credential with empty header rejects", () => {
  const profile = makeProfile({
    network: {
      ...DEFAULT_NETWORK_CONFIG,
      credentials: [
        { host: "example.com", header: "", value: { val: "x" } },
      ],
    },
  });
  expect(() => validateConfig(makeConfig(profile))).toThrow(/header.*empty/i);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `bun test src/config/validate_test.ts`
Expected: FAIL — `validateCredentials` not yet implemented

- [ ] **Step 7: Implement credential validation**

In `src/config/validate.ts`, add the forbidden headers constant and validation function. At the top of the file, add the import for `CredentialRule`:

```typescript
import type { Config, CredentialRule, HostExecRule, Profile, ReviewRule } from "./types.ts";
```

Add after the `validateEnvEntries` function (after line 207):

```typescript
// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

function validateCredentials(
  profileName: string,
  credentials: CredentialRule[],
): string[] {
  const errors: string[] = [];
  for (const [i, cred] of credentials.entries()) {
    const prefix = `profile "${profileName}": network.credentials[${i}]`;

    if (!cred.header || cred.header.trim() === "") {
      errors.push(`${prefix}.header must not be empty`);
    } else if (FORBIDDEN_CREDENTIAL_HEADERS.has(cred.header.toLowerCase())) {
      errors.push(
        `${prefix}.header "${cred.header}" is a forbidden header for credential injection`,
      );
    }

    errors.push(
      ...validateHostList(`${prefix}.host`, [cred.host]),
    );
  }
  return errors;
}
```

In `validateProfile`, add credential validation call (after the reviewRules validation, around line 63):

```typescript
  // --- credentials validation ---
  errors.push(
    ...validateCredentials(name, profile.network.credentials),
  );
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test src/config/validate_test.ts`
Expected: All PASS

- [ ] **Step 9: Run full check**

Run: `bun run check && bun test src/config/`
Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add src/config/Schema.pkl src/config/types.ts src/config/validate.ts src/config/validate_test.ts
git commit -m "feat(proxy): add CredentialRule config type and validation"
```

---

### Task 2: Protocol types and broker credential matching

**Files:**
- Modify: `src/network/protocol.ts:36-44` (add `InjectHeader`, update `DecisionResponse`)
- Create: `src/network/credential_matching.ts` (pure matching logic)
- Create: `src/network/credential_matching_test.ts`
- Modify: `src/network/broker.ts:40-54` (add `resolvedCredentials` to `BrokerOptions`)
- Modify: `src/network/broker.ts:125-140` (store resolvedCredentials in constructor)
- Modify: `src/network/broker.ts:231-310` (call credential matching on allow, add to audit)
- Modify: `src/audit/types.ts:8-29` (add `injectedHeaders?` field)
- Test: `src/network/credential_matching_test.ts` (unit tests for pure matching)
- Test: `src/network/broker_integration_test.ts` (integration test for credential injection)

**Interfaces:**
- Consumes: `CredentialRule` from Task 1
- Produces: `InjectHeader` interface, `DecisionResponse.injectHeaders?`, `ResolvedCredential` interface, `findMatchingCredentials()` function

- [ ] **Step 1: Add protocol types**

In `src/network/protocol.ts`, add after the `Decision` type (after line 5):

```typescript
export interface InjectHeader {
  name: string;
  value: string;
}

export interface ResolvedCredential {
  host: string;
  pathPrefix?: string;
  method?: string;
  header: string;
  value: string;
}
```

Update `DecisionResponse` (line 36) to add `injectHeaders`:

```typescript
export interface DecisionResponse {
  version: 1;
  type: "decision";
  requestId: string;
  decision: Decision;
  scope?: ApprovalScope;
  reason: string;
  message?: string;
  injectHeaders?: InjectHeader[];
}
```

- [ ] **Step 2: Add `injectedHeaders` to audit types**

In `src/audit/types.ts`, add after the `target?: string;` field (line 27):

```typescript
  /** Network-specific: header names injected by credential rules. */
  injectedHeaders?: string[];
```

- [ ] **Step 3: Write failing tests for credential matching**

Create `src/network/credential_matching_test.ts`:

```typescript
import { expect, test } from "bun:test";
import { findMatchingCredentials } from "./credential_matching.ts";
import type { ResolvedCredential } from "./protocol.ts";

const creds: ResolvedCredential[] = [
  { host: "github.com", header: "Authorization", value: "token ghp_abc" },
  { host: "api.github.com", pathPrefix: "/repos/myorg/", header: "Authorization", value: "token ghp_abc" },
  { host: "*.npmjs.org", header: "Authorization", value: "Bearer npm_xyz" },
  { host: "api.example.com", method: "POST", header: "X-API-Key", value: "key123" },
];

test("findMatchingCredentials: matches by host", () => {
  const result = findMatchingCredentials(creds, "github.com", 443, "GET", "/");
  expect(result).toEqual([{ name: "Authorization", value: "token ghp_abc" }]);
});

test("findMatchingCredentials: matches by host + pathPrefix", () => {
  const result = findMatchingCredentials(
    creds, "api.github.com", 443, "GET", "/repos/myorg/nas",
  );
  expect(result).toEqual([{ name: "Authorization", value: "token ghp_abc" }]);
});

test("findMatchingCredentials: pathPrefix mismatch returns empty", () => {
  const result = findMatchingCredentials(
    creds, "api.github.com", 443, "GET", "/repos/other/nas",
  );
  expect(result).toEqual([]);
});

test("findMatchingCredentials: wildcard host matches subdomain", () => {
  const result = findMatchingCredentials(
    creds, "registry.npmjs.org", 443, "GET", "/",
  );
  expect(result).toEqual([{ name: "Authorization", value: "Bearer npm_xyz" }]);
});

test("findMatchingCredentials: method filter applies", () => {
  const post = findMatchingCredentials(
    creds, "api.example.com", 443, "POST", "/data",
  );
  expect(post).toEqual([{ name: "X-API-Key", value: "key123" }]);

  const get = findMatchingCredentials(
    creds, "api.example.com", 443, "GET", "/data",
  );
  expect(get).toEqual([]);
});

test("findMatchingCredentials: all-match returns multiple headers", () => {
  const multiCreds: ResolvedCredential[] = [
    { host: "api.example.com", header: "Authorization", value: "Bearer tok" },
    { host: "api.example.com", header: "X-API-Key", value: "key123" },
  ];
  const result = findMatchingCredentials(
    multiCreds, "api.example.com", 443, "GET", "/",
  );
  expect(result).toEqual([
    { name: "Authorization", value: "Bearer tok" },
    { name: "X-API-Key", value: "key123" },
  ]);
});

test("findMatchingCredentials: no match returns empty", () => {
  const result = findMatchingCredentials(creds, "unknown.com", 443, "GET", "/");
  expect(result).toEqual([]);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test src/network/credential_matching_test.ts`
Expected: FAIL — module not found

- [ ] **Step 5: Implement credential matching**

Create `src/network/credential_matching.ts`:

```typescript
import type { InjectHeader, ResolvedCredential } from "./protocol.ts";
import { matchesHostPattern, normalizeHost } from "./protocol.ts";

export function findMatchingCredentials(
  credentials: ResolvedCredential[],
  host: string,
  port: number,
  method: string,
  path: string,
): InjectHeader[] {
  const headers: InjectHeader[] = [];
  const target = { host: normalizeHost(host), port };

  for (const cred of credentials) {
    if (!matchesHostPattern(target, [cred.host])) continue;
    if (cred.method !== undefined && cred.method.toUpperCase() !== method.toUpperCase()) continue;
    if (cred.pathPrefix !== undefined && !path.startsWith(cred.pathPrefix)) continue;
    headers.push({ name: cred.header, value: cred.value });
  }

  return headers;
}
```

- [ ] **Step 6: Run matching tests**

Run: `bun test src/network/credential_matching_test.ts`
Expected: All PASS

- [ ] **Step 7: Wire credential matching into broker**

In `src/network/broker.ts`, add import:

```typescript
import { findMatchingCredentials } from "./credential_matching.ts";
import type { InjectHeader, ResolvedCredential } from "./protocol.ts";
```

Add `resolvedCredentials` to `BrokerOptions` (after `auditDir` field, around line 53):

```typescript
  resolvedCredentials?: ResolvedCredential[];
```

In the `SessionBroker` constructor, store credentials (add a private field and assignment):

```typescript
private readonly resolvedCredentials: ResolvedCredential[];
```

In the constructor body:

```typescript
this.resolvedCredentials = options.resolvedCredentials ?? [];
```

Modify the `authorize()` method: after each point where `allowDecision()` is called with the existing pattern, inject credential headers. The cleanest approach is to extract the injection into a helper method and call it at the end of `authorize()` before returning any allow decision.

Add a private method after `findMatchingRule()`:

```typescript
  private injectCredentialHeaders(
    decision: DecisionResponse,
    message: AuthorizeRequest,
  ): DecisionResponse {
    if (decision.decision !== "allow" || this.resolvedCredentials.length === 0) {
      return decision;
    }
    const path = message.reviewContext?.path ?? "";
    const headers = findMatchingCredentials(
      this.resolvedCredentials,
      message.target.host,
      message.target.port,
      message.method,
      path,
    );
    if (headers.length === 0) return decision;
    return { ...decision, injectHeaders: headers };
  }
```

Modify `recordAudit` to accept optional `injectedHeaders` parameter:

```typescript
  private async recordAudit(
    requestId: string,
    decision: "allow" | "deny",
    reason: string,
    target: string,
    injectedHeaders?: string[],
  ): Promise<void> {
    if (!this.auditDir) return;
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      domain: "network",
      sessionId: this.sessionId,
      requestId,
      decision,
      reason,
      target,
      injectedHeaders,
    };
    await appendAuditLog(entry, this.auditDir);
  }
```

In the `authorize()` method, wrap each `allowDecision()` return with credential injection. For each `return allowDecision(...)` in authorize, replace with a pattern that calls `injectCredentialHeaders` and passes audit info. The key changes:

At each allow decision point in `authorize()`, change the pattern from:

```typescript
await this.recordAudit(message.requestId, "allow", "review-rule", targetStr);
return allowDecision(message.requestId, "review-rule");
```

to:

```typescript
const decision = this.injectCredentialHeaders(
  allowDecision(message.requestId, "review-rule"),
  message,
);
const headerNames = decision.injectHeaders?.map((h) => h.name);
await this.recordAudit(message.requestId, "allow", "review-rule", targetStr, headerNames);
return decision;
```

Apply this pattern to all 3 allow paths in `authorize()`:
1. `approved` (session cache hit, around line 265)
2. `review-rule` (rule match, around line 289)
3. And in `resolveGroup()` for user-approved decisions (around line 467–479)

- [ ] **Step 8: Write broker integration test for credential injection**

Add to `src/network/broker_integration_test.ts`:

```typescript
test("SessionBroker: allow decision includes injectHeaders for matching credentials", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cred",
    reviewRules: [{ host: "github.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    auditDir,
    resolvedCredentials: [
      { host: "github.com", header: "Authorization", value: "token ghp_test123" },
    ],
  });
  const socketPath = `${paths.brokersDir}/sess_cred/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_cred", "req_cred_1", "github.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.injectHeaders).toEqual([
      { name: "Authorization", value: "token ghp_test123" },
    ]);

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].injectedHeaders).toEqual(["Authorization"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny decision does not include injectHeaders", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cred",
    reviewRules: [{ host: "github.com", action: "deny" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    resolvedCredentials: [
      { host: "github.com", header: "Authorization", value: "token ghp_test123" },
    ],
  });
  const socketPath = `${paths.brokersDir}/sess_cred/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_cred", "req_cred_deny", "github.com", 443),
    );
    expect(response.decision).toEqual("deny");
    expect(response.injectHeaders).toBeUndefined();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: all-match injects multiple credentials for same host", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_multi",
    reviewRules: [{ host: "api.example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    resolvedCredentials: [
      { host: "api.example.com", header: "Authorization", value: "Bearer tok" },
      { host: "api.example.com", header: "X-API-Key", value: "key123" },
    ],
  });
  const socketPath = `${paths.brokersDir}/sess_multi/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_multi", "req_multi", "api.example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.injectHeaders).toEqual([
      { name: "Authorization", value: "Bearer tok" },
      { name: "X-API-Key", value: "key123" },
    ]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 9: Run all broker tests**

Run: `bun test src/network/`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add src/network/protocol.ts src/network/credential_matching.ts src/network/credential_matching_test.ts src/network/broker.ts src/audit/types.ts src/network/broker_integration_test.ts
git commit -m "feat(proxy): add credential matching to broker with injectHeaders"
```

---

### Task 3: Credential resolution service and proxy stage wiring

**Files:**
- Modify: `src/stages/proxy/network_runtime_service.ts:18-38` (add `resolveCredentials` to tag)
- Modify: `src/stages/proxy/network_runtime_service.ts:44-89` (add Live implementation)
- Modify: `src/stages/proxy/network_runtime_service.ts:95-122` (add Fake implementation)
- Modify: `src/stages/proxy/session_broker_service.ts:27-42` (add `resolvedCredentials` to config)
- Modify: `src/stages/proxy/session_broker_service.ts:78-89` (pass to SessionBroker)
- Modify: `src/stages/proxy/stage.ts:66-94` (add `credentials` to `ProxyPlan`)
- Modify: `src/stages/proxy/stage.ts:105-228` (pass credentials through `planProxy`)
- Modify: `src/stages/proxy/stage.ts:292-408` (resolve credentials in `runProxy`)
- Test: `src/stages/proxy/stage_test.ts` (add credential wiring test)

**Interfaces:**
- Consumes: `CredentialRule`, `CredentialValSpec` from Task 1; `ResolvedCredential` from Task 2
- Produces: `NetworkRuntimeService.resolveCredentials()`, updated `SessionBrokerConfig`, updated `ProxyPlan`

- [ ] **Step 1: Add `resolveCredentials` to NetworkRuntimeService tag**

In `src/stages/proxy/network_runtime_service.ts`, add import:

```typescript
import type { CredentialRule } from "../../config/types.ts";
import type { ResolvedCredential } from "../../network/protocol.ts";
```

Add to the service tag interface (after `writeReviewRules`, around line 36):

```typescript
    readonly resolveCredentials: (
      credentials: CredentialRule[],
    ) => Effect.Effect<ResolvedCredential[]>;
```

- [ ] **Step 2: Implement Live `resolveCredentials`**

In the Live implementation, add the `ProcessService` dependency. Change the `Layer.effect` to depend on both `FsService` and `ProcessService`:

```typescript
import { ProcessService } from "../../services/process.ts";
```

Update the Layer type signature:

```typescript
export const NetworkRuntimeServiceLive: Layer.Layer<
  NetworkRuntimeService,
  never,
  FsService | ProcessService
> = Layer.effect(
  NetworkRuntimeService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;
```

Add the `resolveCredentials` implementation after `writeReviewRules`:

```typescript
      resolveCredentials: (credentials) =>
        Effect.gen(function* () {
          const resolved: ResolvedCredential[] = [];
          for (const [i, cred] of credentials.entries()) {
            const value = "val" in cred.value
              ? cred.value.val
              : yield* Effect.tryPromise({
                  try: async () => {
                    const result = await proc.exec("sh", ["-c", cred.value.valCmd]);
                    const output = result.stdout.trim();
                    if (!output) {
                      throw new Error(
                        `network.credentials[${i}].valCmd returned empty output`,
                      );
                    }
                    return output;
                  },
                  catch: (e) =>
                    new Error(
                      `network.credentials[${i}].valCmd failed: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                });
            resolved.push({
              host: cred.host,
              pathPrefix: cred.pathPrefix,
              method: cred.method,
              header: cred.header,
              value,
            });
          }
          return resolved;
        }),
```

- [ ] **Step 3: Update Fake implementation**

Add to the `NetworkRuntimeServiceFakeConfig` interface:

```typescript
  readonly resolveCredentials?: (
    credentials: CredentialRule[],
  ) => Effect.Effect<ResolvedCredential[]>;
```

Add to `makeNetworkRuntimeServiceFake`:

```typescript
      resolveCredentials: overrides.resolveCredentials ?? (() => Effect.succeed([])),
```

- [ ] **Step 4: Update `SessionBrokerConfig`**

In `src/stages/proxy/session_broker_service.ts`, add import:

```typescript
import type { ResolvedCredential } from "../../network/protocol.ts";
```

Add to `SessionBrokerConfig` (after `tokenHash`, around line 42):

```typescript
  readonly resolvedCredentials?: ResolvedCredential[];
```

Pass to `SessionBroker` constructor in the Live implementation (around line 89, add after `auditDir`):

```typescript
              resolvedCredentials: config.resolvedCredentials,
```

- [ ] **Step 5: Update `ProxyPlan` and `planProxy`**

In `src/stages/proxy/stage.ts`, add import:

```typescript
import type { CredentialRule } from "../../config/types.ts";
```

Add to `ProxyPlan` (after `reviewRules` field, around line 79):

```typescript
  readonly credentials: CredentialRule[];
```

In `planProxy()`, set the `credentials` field (around line 210, where the return object is built):

```typescript
    credentials: [...input.profile.network.credentials],
```

- [ ] **Step 6: Wire `resolveCredentials` in `runProxy`**

In `runProxy()`, after step 5 (writeReviewRules, around line 329) and before step 6 (sessionBrokerService.start), add credential resolution:

```typescript
    // 5.5. Resolve credential values (valCmd execution)
    const resolvedCredentials = yield* networkRuntime.resolveCredentials(
      plan.credentials,
    );
```

Then pass `resolvedCredentials` to `sessionBrokerService.start` (in the config object, around line 348):

```typescript
        resolvedCredentials,
```

- [ ] **Step 7: Write stage test for credential wiring**

Add to `src/stages/proxy/stage_test.ts`. The test verifies that credentials from the profile reach the broker config. Add a test that uses fake services and checks the `resolveCredentials` call was made and `resolvedCredentials` was passed to the broker:

```typescript
test("planProxy: includes credentials in plan", () => {
  const input = makeInput({
    profile: makeProfile({
      network: {
        ...DEFAULT_NETWORK_CONFIG,
        credentials: [
          { host: "github.com", header: "Authorization", value: { val: "token abc" } },
        ],
      },
    }),
  });
  const plan = planProxy(input);
  expect(plan.credentials).toEqual([
    { host: "github.com", header: "Authorization", value: { val: "token abc" } },
  ]);
});
```

For the Effect-based wiring test, add a test that exercises `runProxy` with a fake `NetworkRuntimeService` that records `resolveCredentials` calls and a fake `SessionBrokerService` that records the config it receives:

```typescript
test("runProxy: resolves credentials and passes to broker", async () => {
  const resolvedCreds: CredentialRule[][] = [];
  const brokerConfigs: SessionBrokerConfig[] = [];

  const fakeNetworkRuntime = makeNetworkRuntimeServiceFake({
    resolveCredentials: (creds) =>
      Effect.sync(() => {
        resolvedCreds.push(creds);
        return [{ host: "github.com", header: "Authorization", value: "token resolved_abc" }];
      }),
  });

  const fakeBroker = makeSessionBrokerServiceFake({
    start: (config) =>
      Effect.sync(() => {
        brokerConfigs.push(config);
        return { close: () => Effect.void };
      }),
  });

  // ... provide all fake layers, run the stage, then assert:
  expect(resolvedCreds.length).toBe(1);
  expect(resolvedCreds[0]).toEqual([
    { host: "github.com", header: "Authorization", value: { val: "token abc" } },
  ]);
  expect(brokerConfigs[0].resolvedCredentials).toEqual([
    { host: "github.com", header: "Authorization", value: "token resolved_abc" },
  ]);
});
```

Note: Adapt this test to match the existing test patterns in `stage_test.ts` — the exact fake setup, `Layer.mergeAll`, `Effect.scoped`, and `Effect.runPromise` patterns already present there.

- [ ] **Step 8: Run all proxy stage tests**

Run: `bun test src/stages/proxy/`
Expected: All PASS

- [ ] **Step 9: Run full test suite**

Run: `bun run check && bun test src/`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add src/stages/proxy/network_runtime_service.ts src/stages/proxy/session_broker_service.ts src/stages/proxy/stage.ts src/stages/proxy/stage_test.ts
git commit -m "feat(proxy): wire credential resolution through proxy stage to broker"
```

---

### Task 4: mitmproxy addon `injectHeaders` support

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py:175-258` (add `injectHeaders` handling in `request()`)

**Interfaces:**
- Consumes: `DecisionResponse.injectHeaders` from Task 2

- [ ] **Step 1: Modify the addon to inject headers**

In `src/docker/mitmproxy/nas_addon.py`, in the `request()` method, after the deny check (line 255) and before the proxy-authorization cleanup (line 257), add header injection:

```python
        # Inject credential headers from broker decision
        for h in decision.get("injectHeaders", []):
            flow.request.headers[h["name"]] = h["value"]
```

The full block around lines 248-259 should look like:

```python
        decision = _query_broker(broker_socket, authorize_req)

        if decision.get("decision") != "allow":
            message = decision.get("message", decision.get("reason", "denied"))
            flow.response = http.Response.make(
                403, message.encode() if isinstance(message, str) else b"denied"
            )
            return

        # Inject credential headers from broker decision
        for h in decision.get("injectHeaders", []):
            flow.request.headers[h["name"]] = h["value"]

        if "proxy-authorization" in flow.request.headers:
            del flow.request.headers["proxy-authorization"]
```

- [ ] **Step 2: Verify addon syntax**

Run: `python3 -c "import ast; ast.parse(open('src/docker/mitmproxy/nas_addon.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Run full test suite**

Run: `bun run check && bun test src/`
Expected: All PASS (the addon is copied at runtime, so existing tests should still pass)

- [ ] **Step 4: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py
git commit -m "feat(proxy): inject credential headers in mitmproxy addon"
```
