# Envoy to mitmproxy Replacement

Replace the shared Envoy proxy container with mitmproxy to enable HTTPS MitM inspection, request body review, and flexible review rules. Eliminate the auth-router daemon layer.

## Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| HTTPS handling | MitM mode | Enables POST body inspection for HTTPS traffic |
| Deploy method | Docker container | Same as current Envoy; no host-side Python dependency |
| auth-router | Abolish | addon queries broker UDS directly; removes unnecessary indirection |
| local-proxy.mjs | Keep | Proxy-Authorization for session identification + forward-port |
| Review rules config | `network.prompt.reviewRules` | Consistent with existing denylist location |
| Review UI | Extend existing pending queue | Reuse CLI + Web UI, add body preview |
| CA cert generation | `docker run mitmproxy` | No host OpenSSL dependency; correct mitmproxy key format |
| CA cert distribution | `update-ca-certificates` in entrypoint | System-wide trust, all tools covered |
| `nas network serve-auth-router` CLI | Abolish | No longer needed |

## Architecture

### Before

```
Agent Container
  -> local-proxy (127.0.0.1:18080, adds Proxy-Authorization)
    -> Envoy Container (nas-envoy:15001)
      -> Lua filter -> auth-router UDS -> session broker UDS
      -> CONNECT: passthrough (TLS content invisible)
```

### After

```
Agent Container
  -> local-proxy (127.0.0.1:18080, adds Proxy-Authorization)
    -> mitmproxy Container (nas-proxy:8080)
      -> Python addon -> session broker UDS (direct)
      -> CONNECT: MitM (TLS decrypted, body inspectable)
```

### Key Properties

- Deny-by-default network policy is preserved.
- Session broker (per-session UDS, approval logic) is unchanged.
- Per-session Docker network topology is unchanged.
- local-proxy.mjs continues to handle Proxy-Authorization injection and forward-port relay.

## mitmproxy Container

### Startup

```
docker run --name nas-proxy-shared \
  -v <runtimeDir>:/nas-network:rw \
  mitmproxy/mitmproxy \
  mitmdump --mode regular@8080 \
    --set connection_strategy=lazy \
    --set confdir=/nas-network/mitmproxy-ca \
    -s /nas-network/nas_addon.py
```

- `mitmdump` (headless); mitmweb is not used.
- `--mode regular@8080`: standard forward proxy on port 8080.
- `connection_strategy=lazy`: defer upstream connection until after authorization.
- `confdir`: use persisted CA certificates.
- Container name: `nas-proxy-shared` (replaces `nas-envoy-shared`).
- Network alias: `nas-proxy` (replaces `nas-envoy`).
- Proxy port: 8080 (replaces 15001).

### Docker Labels

Same labeling scheme as Envoy:

```
nas.managed=true
nas.kind=proxy        # was "envoy"
```

## Python Addon (`nas_addon.py`)

Located at `src/docker/mitmproxy/nas_addon.py`, copied to `runtimeDir/nas_addon.py` at startup.

### Request Flow

```python
class NasAddon:
    def request(self, flow):
        # 1. Decode Proxy-Authorization -> sessionId, token
        # 2. Read /nas-network/sessions/<sessionId>/registry.json
        # 3. Verify token hash (SHA-256)
        # 4. Check reviewRules (method/host/path matching)
        # 5. Send authorize request to broker UDS:
        #    /nas-network/brokers/<sessionId>/sock
        #    JSON-line protocol (same as current auth-router -> broker)
        # 6. If matchedReviewRule: set reviewContext with body preview
        # 7. If denied: flow.response = 403
        # 8. If allowed: remove Proxy-Authorization header, forward
```

### Broker Communication

Uses the existing JSON-line-over-UDS protocol (`writeJsonLine` / `readJsonLine` equivalent in Python via `socket.AF_UNIX`). The addon sends `AuthorizeRequest` and receives `DecisionResponse` — same schema as today.

### Registry Caching

The addon caches `registry.json` entries in memory with a short TTL (~5s) to avoid reading the file on every request. Cache is keyed by `sessionId`.

### reviewRules Evaluation

The addon loads reviewRules from a config file written by the proxy stage at `runtimeDir/review-rules/<sessionId>.json`. Matching logic:

- `method`: case-insensitive exact match (optional; omit to match all methods)
- `host`: same pattern syntax as allowlist — exact, `*.domain.com`, with optional port (optional)
- `pathPrefix`: prefix match on request path (optional)
- All specified fields must match (AND logic). Omitted fields match everything.

When a rule matches, the addon sets `matchedReviewRule: true` and populates `reviewContext` in the `AuthorizeRequest` sent to the broker.

## Review Rules

### Profile Configuration

```pkl
network {
  allowlist = List("*.npmjs.org", "api.github.com")
  prompt {
    enable = true
    denylist = List("evil.com")
    reviewRules {
      new {
        method = "POST"
        host = "*.openai.com"
        pathPrefix = "/v1/chat"
        action = "review"
      }
      new {
        method = "DELETE"
        action = "review"
      }
    }
  }
}
```

### TypeScript Types

```typescript
interface ReviewRule {
  method?: string;
  host?: string;
  pathPrefix?: string;
  action: "review" | "deny";
}

interface NetworkPromptConfig {
  enable: boolean;
  denylist: string[];
  timeoutSeconds: number;
  defaultScope: ApprovalScope;
  notify: "auto" | "desktop" | "off";
  reviewRules: ReviewRule[];  // new
}
```

### Authorization Order (in broker)

1. Hard-blocked (localhost, private IP) -> **deny**
2. Allowlist match -> **check reviewRules** (was: immediate allow)
3. Denylist match -> **deny**
4. approved-by-user cache -> **allow** (previously approved targets skip re-review)
5. denied-by-user cache -> **deny**
6. Negative cache -> **deny**
7. `matchedReviewRule == true` -> **pending queue with body preview**
8. promptEnabled and not in allowlist -> **pending queue** (existing behavior)
9. Default deny

Key change: allowlist hits are no longer unconditionally allowed — they are checked against reviewRules first. This enables "allow GET to *.openai.com but review POST" patterns.

### Extended PendingEntry

```typescript
interface PendingEntry {
  version: 1;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  state: "pending";
  createdAt: string;
  updatedAt: string;
  // New fields
  reviewContext?: {
    path: string;
    contentType: string | null;
    bodyPreview: string | null;  // first ~1KB as string
    bodySize: number;
  };
}
```

### Extended AuthorizeRequest

```typescript
interface AuthorizeRequest {
  version: 1;
  type: "authorize";
  requestId: string;
  sessionId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  observedAt: string;
  // New fields
  reviewContext?: {
    path: string;
    contentType: string | null;
    bodyPreview: string | null;
    bodySize: number;
  };
  matchedReviewRule?: boolean;
}
```

## CA Certificate Management

### Generation

On first proxy startup, if `runtimeDir/mitmproxy-ca/` does not contain `mitmproxy-ca-cert.pem`:

```bash
docker run --rm \
  -v <runtimeDir>/mitmproxy-ca:/home/mitmproxy/.mitmproxy \
  mitmproxy/mitmproxy \
  mitmdump -n -q
```

This starts mitmdump in no-server mode, which generates the CA files and exits. The generated files persist in `runtimeDir/mitmproxy-ca/`.

### Distribution to Agent Container

Mount:

```typescript
{
  source: `${runtimePaths.caCertDir}/mitmproxy-ca-cert.pem`,
  target: "/usr/local/share/ca-certificates/nas-proxy.crt",
  readOnly: true,
}
```

Entrypoint (`src/docker/embed/entrypoint.sh`):

```bash
#!/bin/sh
if [ -f /usr/local/share/ca-certificates/nas-proxy.crt ]; then
  update-ca-certificates 2>/dev/null
fi
exec "$@"
```

The agent container's Dockerfile adds the entrypoint:

```dockerfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

## Effect Service Layer Changes

### New / Renamed Services

| Old | New | Notes |
|-----|-----|-------|
| `EnvoyService` | `ProxyService` | Container name, image, port, startup command change |
| — | `CaService` | CA cert generation via docker run mitmproxy |
| `AuthRouterService` | (abolished) | |
| `NetworkRuntimeService.renderEnvoyConfig` | (abolished) | |

### ProxyService Interface

```typescript
export class ProxyService extends Context.Tag("nas/ProxyService")<
  ProxyService,
  {
    readonly ensureSharedProxy: (plan: EnsureProxyPlan) => Effect.Effect<void, unknown>;
    readonly createSessionNetwork: (plan: SessionNetworkPlan) => Effect.Effect<() => Effect.Effect<void>>;
  }
>() {}

interface EnsureProxyPlan {
  readonly proxyContainerName: string;
  readonly proxyImage: string;
  readonly runtimePaths: NetworkRuntimePaths;
  readonly proxyReadyTimeoutMs: number;
}
```

### runProxy Effect Chain

```
1. ensureRuntimeDirs        (keep; add caCertDir)
2. gcStaleRuntime           (keep)
3. renderEnvoyConfig        (REMOVE)
4. ensureCaCert             (NEW: docker run mitmproxy if cert missing)
5. writeAddonScript         (NEW: copy nas_addon.py to runtimeDir)
6. writeReviewRules         (NEW: per-session review rules JSON)
7. session broker           (keep)
8. auth-router daemon       (REMOVE)
9. forward-port relays      (keep)
10. ensureSharedProxy       (was ensureSharedEnvoy)
11. createSessionNetwork    (keep)
```

### NetworkRuntimePaths

```typescript
interface NetworkRuntimePaths {
  runtimeDir: string;
  sessionsDir: string;
  pendingDir: string;
  brokersDir: string;
  caCertDir: string;        // new: runtimeDir/mitmproxy-ca
  addonScriptPath: string;  // new: runtimeDir/nas_addon.py
  // Removed: authRouterSocket, authRouterPidFile, authRouterLogFile, envoyConfigFile
}
```

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `src/docker/mitmproxy/nas_addon.py` | mitmproxy addon (auth, reviewRules, broker UDS communication) |
| `src/stages/proxy/proxy_service.ts` | ProxyService (replaces EnvoyService) |
| `src/stages/proxy/ca_service.ts` | CA certificate generation via docker run |
| `src/docker/embed/entrypoint.sh` | Agent container entrypoint (update-ca-certificates) |

### Modified Files

| File | Changes |
|------|---------|
| `src/stages/proxy/stage.ts` | Envoy -> mitmproxy constants, remove auth-router step, add CA/addon/reviewRules steps |
| `src/stages/proxy/network_runtime_service.ts` | Remove renderEnvoyConfig, add caCertDir to ensureRuntimeDirs |
| `src/network/broker.ts` | Handle matchedReviewRule, reviewContext in authorize flow |
| `src/network/protocol.ts` | Add reviewContext/matchedReviewRule to AuthorizeRequest, ReviewRule type, reviewContext to PendingEntry |
| `src/network/registry.ts` | Update NetworkRuntimePaths (remove envoy/auth-router paths, add caCertDir/addonScriptPath) |
| `src/config/types.ts` | Add ReviewRule type, reviewRules to NetworkPromptConfig |
| `src/config/Schema.pkl` | Add ReviewRule class, reviewRules to NetworkPromptConfig |
| `src/docker/embed/Dockerfile` | Add entrypoint.sh, ENTRYPOINT directive |
| `src/docker/embed/local-proxy.mjs` | Upstream port 15001 -> 8080 (via env var, no code change needed) |
| `src/docker/nas_resources.ts` | NAS_KIND_ENVOY -> NAS_KIND_PROXY |

### Deleted Files

| File | Reason |
|------|--------|
| `src/docker/envoy/envoy.template.yaml` | Envoy config template no longer needed |
| `src/stages/proxy/envoy_service.ts` | Replaced by proxy_service.ts |
| `src/stages/proxy/auth_router_service.ts` | auth-router abolished |
| `src/network/envoy_auth_router.ts` | auth-router implementation abolished |

### CLI Changes

- Remove `nas network serve-auth-router` subcommand.

## Runtime Directory Structure (After)

```
$XDG_RUNTIME_DIR/nas/network/
  mitmproxy-ca/
    mitmproxy-ca.pem
    mitmproxy-ca-cert.pem
    mitmproxy-ca-cert.cer
    mitmproxy-dhparam.pem
  nas_addon.py
  review-rules/
    <sessionId>.json
  sessions/
    <sessionId>/
      registry.json
  pending/
    <sessionId>/
      <requestId>.json
  brokers/
    <sessionId>/
      sock
  forward-ports/
    <sessionId>/
      <port>.sock
```
