# Envoy to mitmproxy Replacement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared Envoy proxy container with mitmproxy, enabling HTTPS MitM inspection and flexible review rules for request body inspection. Abolish the auth-router daemon layer.

**Architecture:** mitmproxy runs as a shared Docker container (`nas-proxy-shared`) with a Python addon (`nas_addon.py`) that directly queries per-session broker UDS sockets for authorization. The addon also evaluates `reviewRules` (method/host/path matching) and populates `reviewContext` with request body previews for manual approval. CA certificates are generated via `docker run mitmproxy` on first use and distributed to agent containers via `update-ca-certificates` in the entrypoint.

**Tech Stack:** mitmproxy (Docker), Python (addon script), Effect (service layer), Bun (tests), Pkl (config schema)

## Global Constraints

- Runtime: Bun. Tests use `bun:test`.
- Tests import from relative paths, not import maps.
- Effect services follow the `Context.Tag` + `Live` + `Fake` pattern.
- Config schema: Pkl (`src/config/Schema.pkl`) + TypeScript (`src/config/types.ts`).
- Docker labels: `nas.managed=true`, `nas.kind=<kind>` via constants in `nas_resources.ts`.
- Existing `NAS_KIND_PROXY` constant already exists in `nas_resources.ts` — use it.
- Test patterns: unit tests use fakes with call-recording, integration tests use temp dirs with `try/finally` cleanup.

---

### Task 1: Add ReviewRule type and extend config schema

**Files:**
- Modify: `src/config/Schema.pkl:162-183` (NetworkPromptConfig class)
- Modify: `src/config/types.ts:119-125` (NetworkPromptConfig interface)
- Modify: `src/config/types.ts:270-276` (DEFAULT_NETWORK_PROMPT_CONFIG)
- Test: `src/config/types_test.ts` (if exists; otherwise verify via `bun run check`)

**Interfaces:**
- Produces: `ReviewRule` type (`{ method?: string; host?: string; pathPrefix?: string; action: "review" | "deny" }`), `NetworkPromptConfig.reviewRules: ReviewRule[]`

- [ ] **Step 1: Add ReviewRule class to Pkl schema**

In `src/config/Schema.pkl`, add before `NetworkPromptConfig`:

```pkl
class ReviewRule {
  /// HTTP メソッド（大文字小文字無視）。省略時は全メソッドにマッチ。
  method: String?
  /// ホストパターン。allowlist と同じ形式（"*.example.com" 等）。省略時は全ホストにマッチ。
  host: String?
  /// パスプレフィックス。省略時は全パスにマッチ。
  pathPrefix: String?
  /// マッチ時のアクション。
  action: "review"|"deny" = "review"
}
```

Add `reviewRules` to `NetworkPromptConfig`:

```pkl
class NetworkPromptConfig {
  enable: Boolean = false
  denylist: Listing<String> = new {}
  timeoutSeconds: Int = 300
  defaultScope: "once"|"host-port"|"host" = "host-port"
  notify: "auto"|"desktop"|"off" = "auto"
  reviewRules: Listing<ReviewRule> = new {}
}
```

- [ ] **Step 2: Add ReviewRule interface to TypeScript types**

In `src/config/types.ts`, add before `NetworkPromptConfig`:

```typescript
export interface ReviewRule {
  method?: string;
  host?: string;
  pathPrefix?: string;
  action: "review" | "deny";
}
```

Add `reviewRules` to `NetworkPromptConfig`:

```typescript
export interface NetworkPromptConfig {
  enable: boolean;
  denylist: string[];
  timeoutSeconds: number;
  defaultScope: ApprovalScope;
  notify: NetworkPromptNotify;
  reviewRules: ReviewRule[];
}
```

Update `DEFAULT_NETWORK_PROMPT_CONFIG`:

```typescript
export const DEFAULT_NETWORK_PROMPT_CONFIG: NetworkPromptConfig = {
  enable: false,
  denylist: [],
  timeoutSeconds: 300,
  defaultScope: "host-port",
  notify: "auto",
  reviewRules: [],
};
```

- [ ] **Step 3: Verify types compile**

Run: `bun run check`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add src/config/Schema.pkl src/config/types.ts
git commit -m "feat(config): add ReviewRule type and reviewRules to NetworkPromptConfig"
```

---

### Task 2: Extend protocol and broker to support reviewRules

**Files:**
- Modify: `src/network/protocol.ts:17-48` (AuthorizeRequest, PendingEntry)
- Modify: `src/network/broker.ts:104,223-305` (SessionBroker.authorize)
- Test: `src/network/broker_integration_test.ts`

**Interfaces:**
- Consumes: `ReviewRule` from `src/config/types.ts`
- Produces: Extended `AuthorizeRequest` with `reviewContext?` and `matchedReviewRule?`. Extended `PendingEntry` with `reviewContext?`. Broker constructor takes `reviewRules: ReviewRule[]`.

- [ ] **Step 1: Add reviewContext and matchedReviewRule to protocol types**

In `src/network/protocol.ts`, add:

```typescript
export interface ReviewContext {
  path: string;
  contentType: string | null;
  bodyPreview: string | null;
  bodySize: number;
}
```

Add optional fields to `AuthorizeRequest`:

```typescript
export interface AuthorizeRequest {
  version: 1;
  type: "authorize";
  requestId: string;
  sessionId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  observedAt: string;
  reviewContext?: ReviewContext;
  matchedReviewRule?: boolean;
}
```

Add optional field to `PendingEntry`:

```typescript
export interface PendingEntry {
  version: 1;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  state: "pending";
  createdAt: string;
  updatedAt: string;
  reviewContext?: ReviewContext;
}
```

- [ ] **Step 2: Write failing test for reviewRule-matched allowlist target going to pending**

In `src/network/broker_integration_test.ts`, add:

```typescript
test("SessionBroker: reviewRule match on allowlisted target sends to pending", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    allowlist: ["api.openai.com"],
    denylist: [],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
    reviewRules: [{ method: "POST", host: "*.openai.com", action: "review" }],
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // POST to allowlisted host with matching reviewRule → pending
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      {
        ...authorize("sess_test", "req_review_1", "api.openai.com", 443),
        method: "POST",
        matchedReviewRule: true,
        reviewContext: {
          path: "/v1/chat/completions",
          contentType: "application/json",
          bodyPreview: '{"model":"gpt-4"}',
          bodySize: 18,
        },
      },
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items.length).toEqual(1);
    expect(pending.items[0].reviewContext).toBeDefined();
    expect(pending.items[0].reviewContext!.path).toEqual("/v1/chat/completions");
    expect(pending.items[0].reviewContext!.bodyPreview).toEqual('{"model":"gpt-4"}');

    // Approve to unblock
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_review_1",
      scope: "once",
    });
    const decision = await authorizePromise;
    expect(decision.decision).toEqual("allow");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: GET to allowlisted host bypasses reviewRule", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    allowlist: ["api.openai.com"],
    denylist: [],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
    reviewRules: [{ method: "POST", host: "*.openai.com", action: "review" }],
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // GET to allowlisted host, reviewRule only matches POST → immediate allow
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_get", "api.openai.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("allowlist");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/network/broker_integration_test.ts`
Expected: FAIL — `reviewRules` is not a known property on `SessionBroker`

- [ ] **Step 4: Implement reviewRules in broker**

In `src/network/broker.ts`, add `reviewRules` to `BrokerOptions`:

```typescript
import type { ReviewRule } from "../config/types.ts";
import { matchesAllowlist } from "./protocol.ts";

interface BrokerOptions {
  // ... existing fields ...
  reviewRules?: ReviewRule[];
}
```

Add field to `SessionBroker`:

```typescript
private readonly reviewRules: ReviewRule[];

constructor(options: BrokerOptions) {
  // ... existing ...
  this.reviewRules = options.reviewRules ?? [];
}
```

Add a private method to check review rules:

```typescript
private matchesReviewRule(method: string, host: string, path?: string): ReviewRule | null {
  for (const rule of this.reviewRules) {
    if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) continue;
    if (rule.host) {
      const target = { host, port: 0 };
      if (!matchesAllowlist(target, [rule.host])) continue;
    }
    if (rule.pathPrefix && path && !path.startsWith(rule.pathPrefix)) continue;
    return rule;
  }
  return null;
}
```

Modify `authorize` method. After allowlist check (around line 250) and before returning the allow decision, check review rules:

```typescript
const allowlistHit = matchesAllowlist(message.target, this.allowlist);
if (allowlistHit) {
  // Check if a reviewRule overrides the allowlist
  if (message.matchedReviewRule) {
    // Fall through to pending logic below
  } else {
    await this.recordAudit(message.requestId, "allow", "allowlist", targetStr);
    return allowDecision(message.requestId, "allowlist");
  }
}
```

In the `toPendingEntry` function, propagate `reviewContext`:

```typescript
function toPendingEntry(
  message: AuthorizeRequest,
  createdAt: string,
): PendingEntry {
  return {
    version: 1,
    sessionId: message.sessionId,
    requestId: message.requestId,
    target: message.target,
    method: message.method,
    requestKind: message.requestKind,
    state: "pending",
    createdAt,
    updatedAt: new Date().toISOString(),
    reviewContext: message.reviewContext,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/network/broker_integration_test.ts`
Expected: PASS

- [ ] **Step 6: Run full unit test suite**

Run: `bun test src/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/network/protocol.ts src/network/broker.ts src/network/broker_integration_test.ts
git commit -m "feat(broker): support reviewRules and reviewContext in authorization flow"
```

---

### Task 3: Update NetworkRuntimePaths — remove Envoy/auth-router, add mitmproxy

**Files:**
- Modify: `src/network/registry.ts:32-37,44-63,90-111` (NetworkRuntimePaths, resolve, gc)
- Modify: `src/stages/proxy/network_runtime_service.ts` (remove renderEnvoyConfig, remove auth-router GC)
- Modify: `src/stages/proxy/envoy_service_test.ts:134-146` (runtimePaths helper)
- Test: existing tests via `bun test src/`

**Interfaces:**
- Produces: `NetworkRuntimePaths` without `authRouterSocket`, `authRouterPidFile`, `authRouterLogFile`, `envoyConfigFile`; with `caCertDir: string`, `addonScriptPath: string`, `reviewRulesDir: string`.

- [ ] **Step 1: Update NetworkRuntimePaths interface**

In `src/network/registry.ts`:

```typescript
export interface NetworkRuntimePaths extends BaseRuntimePaths {
  caCertDir: string;
  addonScriptPath: string;
  reviewRulesDir: string;
}
```

Remove `NetworkGcResult` (auth-router specific GC is no longer needed). Simplify `gcNetworkRuntime` to just delegate to generic `gcRuntime`:

```typescript
export async function gcNetworkRuntime(
  paths: NetworkRuntimePaths,
): Promise<GcResult> {
  return await gcRuntime<SessionRegistryEntry>(paths);
}
```

Update `resolveNetworkRuntimePaths`:

```typescript
export async function resolveNetworkRuntimePaths(
  runtimeDir?: string,
): Promise<NetworkRuntimePaths> {
  const resolved = runtimeDir ?? defaultRuntimeDir("network");
  const paths: NetworkRuntimePaths = {
    runtimeDir: resolved,
    sessionsDir: path.join(resolved, "sessions"),
    pendingDir: path.join(resolved, "pending"),
    brokersDir: path.join(resolved, "brokers"),
    caCertDir: path.join(resolved, "mitmproxy-ca"),
    addonScriptPath: path.join(resolved, "nas_addon.py"),
    reviewRulesDir: path.join(resolved, "review-rules"),
  };
  await ensureDir(paths.runtimeDir, 0o755);
  await ensureDir(paths.sessionsDir);
  await ensureDir(paths.pendingDir);
  await ensureDir(paths.brokersDir);
  await ensureDir(paths.caCertDir);
  await ensureDir(paths.reviewRulesDir);
  return paths;
}
```

- [ ] **Step 2: Update NetworkRuntimeService — remove renderEnvoyConfig and auth-router GC**

In `src/stages/proxy/network_runtime_service.ts`:

Remove the `renderEnvoyConfig` method from the service tag, Live implementation, and Fake factory. Remove the `resolveAsset` import. Remove `ProcessService` dependency since `kill -0` is no longer used for auth-router GC.

Update `gcStaleRuntime` to remove auth-router PID file handling:

```typescript
export class NetworkRuntimeService extends Context.Tag(
  "nas/NetworkRuntimeService",
)<
  NetworkRuntimeService,
  {
    readonly ensureRuntimeDirs: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly gcStaleRuntime: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
  }
>() {}
```

The Live implementation's `ensureRuntimeDirs` adds `caCertDir` and `reviewRulesDir`:

```typescript
ensureRuntimeDirs: (paths) =>
  Effect.gen(function* () {
    yield* fs.mkdir(paths.runtimeDir, { recursive: true, mode: 0o755 });
    yield* fs.mkdir(paths.sessionsDir, { recursive: true });
    yield* fs.mkdir(paths.pendingDir, { recursive: true });
    yield* fs.mkdir(paths.brokersDir, { recursive: true });
    yield* fs.mkdir(paths.caCertDir, { recursive: true });
    yield* fs.mkdir(paths.reviewRulesDir, { recursive: true });
  }),
```

The `gcStaleRuntime` becomes a simple delegate to generic GC (no auth-router specific logic). Since the remaining GC is purely file-based, the implementation can be simplified:

```typescript
gcStaleRuntime: (_paths) => Effect.void,
```

Or if generic gcRuntime needs to stay, wrap it with `Effect.tryPromise`. But given that `gcNetworkRuntime` is called in `runNetworkCommand` CLI, and the service-layer GC is only used in the stage, simplifying to a no-op Effect for now is acceptable. The CLI's `gc` subcommand calls `gcNetworkRuntime` directly, not through the service.

Remove `ProcessService` from the Live layer's dependency:

```typescript
export const NetworkRuntimeServiceLive: Layer.Layer<
  NetworkRuntimeService,
  never,
  FsService
> = Layer.effect(
  NetworkRuntimeService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    // ...
  }),
);
```

Update the Fake:

```typescript
export interface NetworkRuntimeServiceFakeConfig {
  readonly ensureRuntimeDirs?: (
    paths: NetworkRuntimePaths,
  ) => Effect.Effect<void>;
  readonly gcStaleRuntime?: (paths: NetworkRuntimePaths) => Effect.Effect<void>;
}

export function makeNetworkRuntimeServiceFake(
  overrides: NetworkRuntimeServiceFakeConfig = {},
): Layer.Layer<NetworkRuntimeService> {
  return Layer.succeed(
    NetworkRuntimeService,
    NetworkRuntimeService.of({
      ensureRuntimeDirs: overrides.ensureRuntimeDirs ?? (() => Effect.void),
      gcStaleRuntime: overrides.gcStaleRuntime ?? (() => Effect.void),
    }),
  );
}
```

- [ ] **Step 3: Fix all compile errors from NetworkRuntimePaths changes**

Run `bun run check` and fix any remaining references to removed fields (`authRouterSocket`, `authRouterPidFile`, `authRouterLogFile`, `envoyConfigFile`). Key files to check:

- `src/stages/proxy/envoy_service_test.ts` — update `runtimePaths()` helper
- `src/stages/proxy/stage.ts` — update `buildNetworkRuntimePaths()`
- `src/cli/network.ts` — update GC result logging (remove `removedAuthRouterSocket` etc.)

For `src/stages/proxy/envoy_service_test.ts:134-146`, update the helper:

```typescript
function runtimePaths(): NetworkRuntimePaths {
  const root = "/run/user/1000/nas/abc/network";
  return {
    runtimeDir: root,
    sessionsDir: `${root}/sessions`,
    pendingDir: `${root}/pending`,
    brokersDir: `${root}/brokers`,
    caCertDir: `${root}/mitmproxy-ca`,
    addonScriptPath: `${root}/nas_addon.py`,
    reviewRulesDir: `${root}/review-rules`,
  };
}
```

For `src/stages/proxy/stage.ts:399-418`, update `buildNetworkRuntimePaths`:

```typescript
export function buildNetworkRuntimePaths(host: HostEnv): NetworkRuntimePaths {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  let runtimeDir: string;
  if (xdg && xdg.trim().length > 0) {
    runtimeDir = path.join(xdg, "nas", "network");
  } else {
    const uid = host.uid ?? "unknown";
    runtimeDir = path.join("/tmp", `nas-${uid}`, "network");
  }
  return {
    runtimeDir,
    sessionsDir: path.join(runtimeDir, "sessions"),
    pendingDir: path.join(runtimeDir, "pending"),
    brokersDir: path.join(runtimeDir, "brokers"),
    caCertDir: path.join(runtimeDir, "mitmproxy-ca"),
    addonScriptPath: path.join(runtimeDir, "nas_addon.py"),
    reviewRulesDir: path.join(runtimeDir, "review-rules"),
  };
}
```

For `src/cli/network.ts:28-34`, simplify GC logging:

```typescript
if (sub === "gc") {
  const result = await gcNetworkRuntime(paths);
  console.log(
    `[nas] GC removed ${result.removedSessions.length} session(s), ${result.removedPendingDirs.length} pending dir(s), ${result.removedBrokerSockets.length} broker socket(s).`,
  );
  return;
}
```

- [ ] **Step 4: Run type check and tests**

Run: `bun run check && bun test src/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/network/registry.ts src/stages/proxy/network_runtime_service.ts \
  src/stages/proxy/envoy_service_test.ts src/stages/proxy/stage.ts \
  src/cli/network.ts
git commit -m "refactor(network): update RuntimePaths for mitmproxy, remove auth-router GC"
```

---

### Task 4: Delete auth-router and create ProxyService (replacing EnvoyService)

**Files:**
- Delete: `src/network/envoy_auth_router.ts`
- Delete: `src/network/envoy_auth_router_integration_test.ts`
- Delete: `src/stages/proxy/auth_router_service.ts`
- Delete: `src/docker/envoy/envoy.template.yaml`
- Rename/Replace: `src/stages/proxy/envoy_service.ts` → `src/stages/proxy/proxy_service.ts`
- Rename/Replace: `src/stages/proxy/envoy_service_test.ts` → `src/stages/proxy/proxy_service_test.ts`
- Modify: `src/stages/proxy.ts` (barrel re-export)
- Modify: `src/cli/network.ts` (remove serve-auth-router)

**Interfaces:**
- Produces: `ProxyService` tag with `ensureSharedProxy(plan)` and `createSessionNetwork(plan)`. `EnsureProxyPlan` and `SessionNetworkPlan` types.

- [ ] **Step 1: Remove auth-router CLI command**

In `src/cli/network.ts`, remove the `serve-auth-router` block (lines 23-26) and the `serveAuthRouter` import.

- [ ] **Step 2: Delete auth-router files**

```bash
rm src/network/envoy_auth_router.ts
rm src/network/envoy_auth_router_integration_test.ts
rm src/stages/proxy/auth_router_service.ts
rm src/docker/envoy/envoy.template.yaml
```

- [ ] **Step 3: Create ProxyService (replacing EnvoyService)**

Create `src/stages/proxy/proxy_service.ts`. This is a near-copy of `envoy_service.ts` with renamed types and the mitmproxy-specific startup command:

```typescript
import { Context, Effect, Layer } from "effect";
import {
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_KIND_SESSION_NETWORK,
} from "../../docker/nas_resources.ts";
import { logInfo } from "../../log.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { DockerService } from "../../services/docker.ts";

export interface EnsureProxyPlan {
  readonly proxyContainerName: string;
  readonly proxyImage: string;
  readonly runtimePaths: NetworkRuntimePaths;
  readonly proxyReadyTimeoutMs: number;
}

export interface SessionNetworkPlan {
  readonly sessionNetworkName: string;
  readonly proxyContainerName: string;
  readonly proxyAlias: string;
}

export class ProxyService extends Context.Tag("nas/ProxyService")<
  ProxyService,
  {
    readonly ensureSharedProxy: (
      plan: EnsureProxyPlan,
    ) => Effect.Effect<void, unknown>;
    readonly createSessionNetwork: (
      plan: SessionNetworkPlan,
    ) => Effect.Effect<() => Effect.Effect<void>>;
  }
>() {}

export const ProxyServiceLive: Layer.Layer<ProxyService, never, DockerService> =
  Layer.effect(
    ProxyService,
    Effect.gen(function* () {
      const docker = yield* DockerService;

      return ProxyService.of({
        ensureSharedProxy: (plan) =>
          Effect.gen(function* () {
            const running = yield* docker
              .isRunning(plan.proxyContainerName)
              .pipe(Effect.orDie);
            if (running) return;

            const exists = yield* docker
              .containerExists(plan.proxyContainerName)
              .pipe(Effect.orDie);
            if (exists) {
              yield* docker
                .rm(plan.proxyContainerName)
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.sync(() =>
                      logInfo(
                        `[nas] Proxy: failed to remove stale proxy container: ${e}`,
                      ),
                    ),
                  ),
                );
            }

            yield* docker
              .runDetached({
                name: plan.proxyContainerName,
                image: plan.proxyImage,
                args: ["--add-host=host.docker.internal:host-gateway"],
                envVars: {},
                mounts: [
                  {
                    source: plan.runtimePaths.runtimeDir,
                    target: "/nas-network",
                    mode: "rw",
                  },
                ],
                labels: {
                  [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
                  [NAS_KIND_LABEL]: NAS_KIND_PROXY,
                },
                command: [
                  "mitmdump",
                  "--mode", "regular@8080",
                  "--set", "connection_strategy=lazy",
                  "--set", `confdir=/nas-network/mitmproxy-ca`,
                  "--ssl-insecure",
                  "-s", "/nas-network/nas_addon.py",
                ],
              })
              .pipe(Effect.orDie);

            const started = Date.now();
            while (Date.now() - started < plan.proxyReadyTimeoutMs) {
              const isRunning = yield* docker
                .isRunning(plan.proxyContainerName)
                .pipe(Effect.orDie);
              if (isRunning) return;
              yield* Effect.sleep("200 millis");
            }
            const logs = yield* docker
              .logs(plan.proxyContainerName)
              .pipe(Effect.orDie);
            yield* Effect.fail(
              new Error(`Proxy container failed to start:\n${logs}`),
            );
          }),

        createSessionNetwork: (plan) =>
          Effect.gen(function* () {
            let proxyConnected = false;

            yield* docker
              .networkCreate(plan.sessionNetworkName, {
                internal: true,
                labels: {
                  [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
                  [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
                },
              })
              .pipe(Effect.orDie);

            yield* docker
              .networkConnect(
                plan.sessionNetworkName,
                plan.proxyContainerName,
                { aliases: [plan.proxyAlias] },
              )
              .pipe(Effect.orDie);
            proxyConnected = true;

            const teardown = (): Effect.Effect<void> =>
              Effect.gen(function* () {
                if (proxyConnected) {
                  yield* docker
                    .networkDisconnect(
                      plan.sessionNetworkName,
                      plan.proxyContainerName,
                    )
                    .pipe(
                      Effect.catchAll((e) =>
                        Effect.sync(() =>
                          logInfo(
                            `[nas] Proxy teardown: failed to disconnect proxy from network: ${e}`,
                          ),
                        ),
                      ),
                    );
                }
                yield* docker
                  .networkRemove(plan.sessionNetworkName)
                  .pipe(
                    Effect.catchAll((e) =>
                      Effect.sync(() =>
                        logInfo(
                          `[nas] Proxy teardown: failed to remove network: ${e}`,
                        ),
                      ),
                    ),
                  );
              });

            return teardown;
          }),
      });
    }),
  );

export interface ProxyServiceFakeConfig {
  readonly ensureSharedProxy?: (
    plan: EnsureProxyPlan,
  ) => Effect.Effect<void, unknown>;
  readonly createSessionNetwork?: (
    plan: SessionNetworkPlan,
  ) => Effect.Effect<() => Effect.Effect<void>>;
}

export function makeProxyServiceFake(
  overrides: ProxyServiceFakeConfig = {},
): Layer.Layer<ProxyService> {
  return Layer.succeed(
    ProxyService,
    ProxyService.of({
      ensureSharedProxy: overrides.ensureSharedProxy ?? (() => Effect.void),
      createSessionNetwork:
        overrides.createSessionNetwork ??
        (() => Effect.succeed(() => Effect.void)),
    }),
  );
}
```

- [ ] **Step 4: Rename and update test file**

Rename `src/stages/proxy/envoy_service_test.ts` to `src/stages/proxy/proxy_service_test.ts`.

Update all references: `EnvoyService` → `ProxyService`, `ensureSharedEnvoy` → `ensureSharedProxy`, `envoyContainerName` → `proxyContainerName`, `envoyImage` → `proxyImage`, `envoyReadyTimeoutMs` → `proxyReadyTimeoutMs`, `NAS_KIND_ENVOY` → `NAS_KIND_PROXY`, `EnsureEnvoyPlan` → `EnsureProxyPlan`, `EnvoyServiceLive` → `ProxyServiceLive`.

Update error message assertion: `"Envoy sidecar failed to start"` → `"Proxy container failed to start"`.

Update container names: `"nas-envoy-shared"` → `"nas-proxy-shared"`.

Update the `sessionPlan` helper: `envoyContainerName` → `proxyContainerName`, `envoyAlias` → `proxyAlias`.

Update the command assertion to match the mitmproxy command:

```typescript
expect(run.command).toEqual([
  "mitmdump",
  "--mode", "regular@8080",
  "--set", "connection_strategy=lazy",
  "--set", "confdir=/nas-network/mitmproxy-ca",
  "--ssl-insecure",
  "-s", "/nas-network/nas_addon.py",
]);
```

- [ ] **Step 5: Delete old EnvoyService file**

```bash
rm src/stages/proxy/envoy_service.ts
```

- [ ] **Step 6: Update barrel re-export**

Replace `src/stages/proxy.ts` content. Remove `AuthRouterService` exports and `EnvoyService` exports. Add `ProxyService` exports:

```typescript
export {
  type EnsureProxyPlan,
  ProxyService,
  type ProxyServiceFakeConfig,
  ProxyServiceLive,
  makeProxyServiceFake,
  type SessionNetworkPlan,
} from "./proxy/proxy_service.ts";
```

Keep all other exports unchanged (ForwardPortRelayService, NetworkRuntimeService, SessionBrokerService, stage exports).

- [ ] **Step 7: Run type check and tests**

Run: `bun run check && bun test src/`
Expected: PASS (with possible failures in stage.ts — fixed in next task)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(proxy): replace EnvoyService with ProxyService, delete auth-router"
```

---

### Task 5: Create Python addon (`nas_addon.py`)

**Files:**
- Create: `src/docker/mitmproxy/nas_addon.py`

**Interfaces:**
- Consumes: broker UDS JSON-line protocol (`AuthorizeRequest` → `DecisionResponse`), `registry.json` schema, `review-rules/<sessionId>.json`
- Produces: mitmproxy addon that intercepts requests, authenticates via Proxy-Authorization, queries broker UDS, evaluates review rules

- [ ] **Step 1: Create the addon script**

Create `src/docker/mitmproxy/nas_addon.py`:

```python
"""
nas_addon.py — mitmproxy addon for nas network authorization.

Intercepts HTTP/HTTPS requests, extracts session credentials from
Proxy-Authorization, queries the per-session broker UDS for authorization
decisions, and evaluates review rules for request body inspection.
"""

import base64
import hashlib
import json
import os
import socket
import time
import fnmatch
from typing import Optional

from mitmproxy import http, ctx

NETWORK_DIR = "/nas-network"
SESSIONS_DIR = os.path.join(NETWORK_DIR, "sessions")
BROKERS_DIR = os.path.join(NETWORK_DIR, "brokers")
REVIEW_RULES_DIR = os.path.join(NETWORK_DIR, "review-rules")

BODY_PREVIEW_MAX = 1024

_registry_cache: dict[str, tuple[float, dict]] = {}
_review_rules_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL = 5.0


def _load_registry(session_id: str) -> Optional[dict]:
    now = time.monotonic()
    cached = _registry_cache.get(session_id)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    path = os.path.join(SESSIONS_DIR, session_id, "registry.json")
    try:
        with open(path) as f:
            data = json.load(f)
        _registry_cache[session_id] = (now, data)
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _load_review_rules(session_id: str) -> list:
    now = time.monotonic()
    cached = _review_rules_cache.get(session_id)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    path = os.path.join(REVIEW_RULES_DIR, f"{session_id}.json")
    try:
        with open(path) as f:
            rules = json.load(f)
        _review_rules_cache[session_id] = (now, rules)
        return rules
    except (FileNotFoundError, json.JSONDecodeError):
        _review_rules_cache[session_id] = (now, [])
        return []


def _hash_token(token: str) -> str:
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"sha256:{digest}"


def _decode_proxy_auth(header: Optional[str]) -> Optional[tuple[str, str]]:
    if not header:
        return None
    if not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:].strip()).decode()
        idx = decoded.index(":")
        if idx <= 0 or idx == len(decoded) - 1:
            return None
        return decoded[:idx], decoded[idx + 1:]
    except Exception:
        return None


def _query_broker(socket_path: str, request: dict) -> dict:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(10.0)
        sock.connect(socket_path)
        line = json.dumps(request) + "\n"
        sock.sendall(line.encode())
        data = b""
        while b"\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        if not data:
            return {"decision": "deny", "reason": "empty-broker-response"}
        return json.loads(data.decode().strip())
    except Exception as e:
        return {"decision": "deny", "reason": f"broker-unavailable: {e}"}
    finally:
        sock.close()


def _normalize_host(host: str) -> str:
    h = host.strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    while h.endswith("."):
        h = h[:-1]
    return h


def _default_port(scheme: str) -> int:
    return 443 if scheme == "https" else 80


def _match_host_pattern(host: str, pattern: str) -> bool:
    normalized = _normalize_host(host)
    if pattern.startswith("*."):
        suffix = pattern[2:].lower()
        return normalized == suffix or normalized.endswith(f".{suffix}")
    return normalized == pattern.lower()


def _match_review_rule(rule: dict, method: str, host: str, path: str) -> bool:
    if "method" in rule and rule["method"]:
        if rule["method"].upper() != method.upper():
            return False
    if "host" in rule and rule["host"]:
        if not _match_host_pattern(host, rule["host"]):
            return False
    if "pathPrefix" in rule and rule["pathPrefix"]:
        if not path.startswith(rule["pathPrefix"]):
            return False
    return True


def _generate_request_id() -> str:
    return f"req_{os.urandom(6).hex()}"


class NasAddon:
    def request(self, flow: http.HTTPFlow) -> None:
        proxy_auth = flow.request.headers.get("proxy-authorization", "")
        creds = _decode_proxy_auth(proxy_auth)
        if not creds:
            flow.response = http.Response.make(
                407, b"missing proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            return

        session_id, token = creds
        registry = _load_registry(session_id)
        if not registry:
            flow.response = http.Response.make(403, b"stale-session")
            return

        token_hash = _hash_token(token)
        if token_hash != registry.get("tokenHash"):
            flow.response = http.Response.make(
                407, b"invalid proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            return

        host = _normalize_host(flow.request.host)
        port = flow.request.port
        method = flow.request.method
        request_path = flow.request.path

        review_rules = _load_review_rules(session_id)
        matched_rule = None
        for rule in review_rules:
            if _match_review_rule(rule, method, host, request_path):
                matched_rule = rule
                break

        request_id = _generate_request_id()
        broker_socket = os.path.join(BROKERS_DIR, session_id, "sock")

        authorize_req = {
            "version": 1,
            "type": "authorize",
            "requestId": request_id,
            "sessionId": session_id,
            "target": {"host": host, "port": port},
            "method": method,
            "requestKind": "connect" if method == "CONNECT" else "forward",
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        }

        if matched_rule:
            authorize_req["matchedReviewRule"] = True
            body_bytes = flow.request.get_content(limit=BODY_PREVIEW_MAX + 1)
            body_preview = None
            if body_bytes:
                try:
                    body_preview = body_bytes[:BODY_PREVIEW_MAX].decode("utf-8", errors="replace")
                except Exception:
                    body_preview = f"<binary {len(body_bytes)} bytes>"
            authorize_req["reviewContext"] = {
                "path": request_path,
                "contentType": flow.request.headers.get("content-type"),
                "bodyPreview": body_preview,
                "bodySize": len(flow.request.get_content()) if flow.request.content is not None else 0,
            }

            if matched_rule.get("action") == "deny":
                flow.response = http.Response.make(403, b"denied by review rule")
                return

        decision = _query_broker(broker_socket, authorize_req)

        if decision.get("decision") != "allow":
            message = decision.get("message", decision.get("reason", "denied"))
            flow.response = http.Response.make(
                403, message.encode() if isinstance(message, str) else b"denied"
            )
            return

        del flow.request.headers["proxy-authorization"]


addons = [NasAddon()]
```

- [ ] **Step 2: Verify syntax**

Run: `python3 -c "import ast; ast.parse(open('src/docker/mitmproxy/nas_addon.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py
git commit -m "feat(proxy): add mitmproxy Python addon for network authorization"
```

---

### Task 6: Update ProxyStage — wire mitmproxy, CA cert, and review rules

**Files:**
- Modify: `src/stages/proxy/stage.ts` (constants, plan, Effect chain)
- Create: `src/stages/proxy/ca_service.ts`
- Modify: `src/stages/proxy/session_broker_service.ts` (add reviewRules to config)

**Interfaces:**
- Consumes: `ProxyService`, `NetworkRuntimeService`, `SessionBrokerService`, `ForwardPortRelayService`, `CaService`
- Produces: Updated `ProxyPlan`, `runProxy` Effect chain

- [ ] **Step 1: Create CaService**

Create `src/stages/proxy/ca_service.ts`:

```typescript
import { Context, Effect, Layer } from "effect";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { DockerService } from "../../services/docker.ts";
import { FsService } from "../../services/fs.ts";

export class CaService extends Context.Tag("nas/CaService")<
  CaService,
  {
    readonly ensureCaCert: (
      paths: NetworkRuntimePaths,
      proxyImage: string,
    ) => Effect.Effect<void>;
  }
>() {}

export const CaServiceLive: Layer.Layer<CaService, never, DockerService | FsService> =
  Layer.effect(
    CaService,
    Effect.gen(function* () {
      const docker = yield* DockerService;
      const fs = yield* FsService;

      return CaService.of({
        ensureCaCert: (paths, proxyImage) =>
          Effect.gen(function* () {
            const certPath = `${paths.caCertDir}/mitmproxy-ca-cert.pem`;
            const certExists = yield* fs.exists(certPath);
            if (certExists) return;

            yield* docker
              .run({
                image: proxyImage,
                args: ["--rm"],
                mounts: [
                  {
                    source: paths.caCertDir,
                    target: "/home/mitmproxy/.mitmproxy",
                    mode: "rw",
                  },
                ],
                command: ["mitmdump", "-n", "-q"],
              })
              .pipe(Effect.orDie);
          }),
      });
    }),
  );

export interface CaServiceFakeConfig {
  readonly ensureCaCert?: (
    paths: NetworkRuntimePaths,
    proxyImage: string,
  ) => Effect.Effect<void>;
}

export function makeCaServiceFake(
  overrides: CaServiceFakeConfig = {},
): Layer.Layer<CaService> {
  return Layer.succeed(
    CaService,
    CaService.of({
      ensureCaCert: overrides.ensureCaCert ?? (() => Effect.void),
    }),
  );
}
```

Note: The `DockerService.run` method (blocking `docker run --rm`) may not exist yet. If `DockerService` only has `runDetached`, use `runDetached` with a wait-for-exit loop, or add a `run` method. Check `src/services/docker.ts` during implementation. An alternative is to use `Effect.tryPromise` wrapping `Bun.spawn(["docker", "run", ...])` directly.

- [ ] **Step 2: Update SessionBrokerService to accept reviewRules**

In `src/stages/proxy/session_broker_service.ts`, add `reviewRules` to `SessionBrokerConfig`:

```typescript
import type { ReviewRule } from "../../config/types.ts";

export interface SessionBrokerConfig {
  // ... existing fields ...
  reviewRules?: ReviewRule[];
}
```

Pass `reviewRules` through to the `SessionBroker` constructor in the Live implementation.

- [ ] **Step 3: Update stage.ts — constants, plan, and Effect chain**

In `src/stages/proxy/stage.ts`:

Update constants:

```typescript
const PROXY_IMAGE = "mitmproxy/mitmproxy:11";
const PROXY_CONTAINER_NAME = "nas-proxy-shared";
const PROXY_ALIAS = "nas-proxy";
const PROXY_PORT = 8080;
const PROXY_READY_TIMEOUT_MS = 15_000;
```

Update imports: replace `EnvoyService` with `ProxyService`, remove `AuthRouterService`, add `CaService`.

Update `ProxyPlan` — replace `envoy*` fields with `proxy*` fields, add `reviewRules`.

Update `planProxy` — use new constants, add `reviewRules` from profile, generate proxy URL with new alias and port:

```typescript
const proxyUrl = `http://${input.sessionId}:${token}@${PROXY_ALIAS}:${PROXY_PORT}`;
```

Add CA cert mount to `buildContainerState`:

```typescript
// CA cert mount for update-ca-certificates
const caCertMount: MountSpec = {
  source: `${runtimePaths.caCertDir}/mitmproxy-ca-cert.pem`,
  target: "/usr/local/share/ca-certificates/nas-proxy.crt",
  readOnly: true,
};
```

Update `runProxy` Effect chain:

```typescript
function runProxy(plan: ProxyPlan) {
  return Effect.gen(function* () {
    const networkRuntime = yield* NetworkRuntimeService;
    const proxy = yield* ProxyService;
    const sessionBrokerService = yield* SessionBrokerService;
    const forwardPortRelayService = yield* ForwardPortRelayService;
    const caService = yield* CaService;

    // 1. Ensure runtime dirs (includes caCertDir, reviewRulesDir)
    yield* networkRuntime.ensureRuntimeDirs(plan.runtimePaths);

    // 2. GC stale sessions
    yield* networkRuntime.gcStaleRuntime(plan.runtimePaths);

    // 3. Ensure CA cert exists
    yield* Effect.acquireRelease(
      caService.ensureCaCert(plan.runtimePaths, plan.proxyImage),
      () => Effect.void,
    );

    // 4. Copy addon script to runtime dir
    yield* copyAddonScript(plan.runtimePaths);

    // 5. Write per-session review rules
    yield* writeReviewRules(plan);

    // 6. Session broker (acquireRelease)
    // ... (same as before, but pass reviewRules)

    // 7. Forward-port relays (acquireRelease)
    // ... (same as before)

    // 8. Shared proxy container (acquireRelease)
    yield* Effect.acquireRelease(
      proxy.ensureSharedProxy(plan),
      () => Effect.void,
    );

    // 9. Session network + proxy connect (acquireRelease)
    yield* Effect.acquireRelease(
      proxy.createSessionNetwork(plan),
      (teardown) => teardown(),
    );

    return plan.outputOverrides;
  });
}
```

Add helper effects:

```typescript
function copyAddonScript(paths: NetworkRuntimePaths): Effect.Effect<void> {
  return Effect.tryPromise({
    try: async () => {
      const addonSource = resolveAsset(
        "docker/mitmproxy/nas_addon.py",
        import.meta.url,
        "../../docker/mitmproxy/nas_addon.py",
      );
      const content = await Bun.file(addonSource).text();
      await Bun.write(paths.addonScriptPath, content);
    },
    catch: (e) => new Error(`Failed to copy addon script: ${e}`),
  }).pipe(Effect.orDie);
}

function writeReviewRules(plan: ProxyPlan): Effect.Effect<void> {
  return Effect.tryPromise({
    try: async () => {
      const rulesPath = `${plan.runtimePaths.reviewRulesDir}/${plan.sessionId}.json`;
      const rules = plan.reviewRules ?? [];
      await Bun.write(rulesPath, JSON.stringify(rules));
    },
    catch: (e) => new Error(`Failed to write review rules: ${e}`),
  }).pipe(Effect.orDie);
}
```

- [ ] **Step 4: Update barrel export in proxy.ts**

Add `CaService` exports. Ensure `ProxyService` is exported instead of `EnvoyService`.

- [ ] **Step 5: Run type check and tests**

Run: `bun run check && bun test src/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(proxy): wire mitmproxy in ProxyStage with CA cert and review rules"
```

---

### Task 7: Update agent container — entrypoint and Dockerfile for CA cert

**Files:**
- Modify: `src/docker/embed/entrypoint.sh` (add update-ca-certificates)
- Modify: `src/docker/embed/Dockerfile` (no change needed — already has `ca-certificates` installed)

**Interfaces:**
- Consumes: `/usr/local/share/ca-certificates/nas-proxy.crt` mount from ProxyStage

- [ ] **Step 1: Add CA cert handling to entrypoint.sh**

In `src/docker/embed/entrypoint.sh`, add after the `ENTRYPOINT_TOTAL_START` line (before the env ops section, around line 89):

```bash
# --- CA 証明書のインストール ---
CA_CERT_START="$(nas_measure_start)"
if [ -f /usr/local/share/ca-certificates/nas-proxy.crt ]; then
  update-ca-certificates 2>/dev/null || true
  nas_info "[nas] mitmproxy CA certificate installed"
fi
nas_measure_done "ca-cert" "$CA_CERT_START"
```

- [ ] **Step 2: Verify Dockerfile already has ca-certificates**

Check that `src/docker/embed/Dockerfile` installs `ca-certificates` (it does — line 3). No Dockerfile changes needed.

- [ ] **Step 3: Commit**

```bash
git add src/docker/embed/entrypoint.sh
git commit -m "feat(container): install mitmproxy CA cert via update-ca-certificates in entrypoint"
```

---

### Task 8: Update CLI pending display for reviewContext

**Files:**
- Modify: `src/cli/network.ts:42-57` (listPending adapter)
- Modify: `src/domain/network/service.ts` (if reviewContext needs to surface)

**Interfaces:**
- Consumes: `PendingEntry.reviewContext`

- [ ] **Step 1: Update pending display**

In `src/cli/network.ts`, update the `listPending` adapter to include reviewContext info:

```typescript
async listPending() {
  const items = await client.listPending(paths);
  return items.map((item) => {
    const target = `${item.target.host}:${item.target.port}`;
    const reviewInfo = item.reviewContext
      ? ` [${item.method} ${item.reviewContext.path}] body=${item.reviewContext.bodySize}B`
      : "";
    return {
      sessionId: item.sessionId,
      requestId: item.requestId,
      displayLine: `${item.sessionId} ${item.requestId} ${target}${reviewInfo} ${item.state} ${item.createdAt}`,
      structured: {
        sessionId: item.sessionId,
        requestId: item.requestId,
        host: item.target.host,
        port: item.target.port,
        state: item.state,
        createdAt: item.createdAt,
        method: item.method,
        reviewContext: item.reviewContext ?? null,
      },
    };
  });
},
```

- [ ] **Step 2: Run type check**

Run: `bun run check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/cli/network.ts
git commit -m "feat(cli): display reviewContext in network pending output"
```

---

### Task 9: Clean up — remove remaining Envoy references

**Files:**
- Modify: Any remaining files that reference "envoy" in variable names, comments, or imports
- Delete: `src/docker/envoy/` directory (if not already deleted)

**Interfaces:**
- None (cleanup only)

- [ ] **Step 1: Search for remaining Envoy references**

```bash
grep -rn -i "envoy" src/ --include='*.ts' --include='*.py' --include='*.yaml' --include='*.yml' | grep -v node_modules | grep -v '.git'
```

Fix any remaining references (variable names, comments, import paths).

- [ ] **Step 2: Delete envoy directory if still present**

```bash
rm -rf src/docker/envoy/
```

- [ ] **Step 3: Run full test suite and type check**

Run: `bun run check && bun test src/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove remaining Envoy references"
```
