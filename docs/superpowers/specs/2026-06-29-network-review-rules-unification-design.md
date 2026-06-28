# Network ReviewRules Unification

Consolidate `network.allowlist`, `network.prompt.denylist`, and `network.prompt.reviewRules` into a single `network.reviewRules` list with first-match evaluation. Remove the `network.prompt` nesting entirely.

## Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config model | Single `reviewRules` list | One mechanism for allow/deny/review eliminates redundancy |
| Evaluation | First-match, implicit deny | Explicit ordering; no ambiguous precedence between lists |
| `prompt.enable` | Remove | Catch-all `{ action = "review" }` rule replaces it |
| `prompt` nesting | Remove | Flatten `pending*` fields into `NetworkConfig` |
| `allowlist` / `denylist` | Remove | Expressed as `action = "allow"` / `action = "deny"` rules |
| Migration | Breaking change | Few external users; migration guide + AI rewrite |
| Verbosity mitigation | Pkl `local function` + `for` | No schema-level sugar needed |

## Schema: Before

```pkl
class NetworkConfig {
  allowlist: Listing<String> = new {}
  prompt: NetworkPromptConfig = new {}
  proxy: ProxyConfig = new {}
}

class NetworkPromptConfig {
  enable: Boolean = false
  denylist: Listing<String> = new {}
  timeoutSeconds: Int = 300
  defaultScope: "once"|"host-port"|"host" = "host-port"
  notify: "auto"|"desktop"|"off" = "auto"
  reviewRules: Listing<ReviewRule> = new {}
}

class ReviewRule {
  method: String?
  host: String?
  pathPrefix: String?
  action: "review"|"deny" = "review"
}
```

## Schema: After

```pkl
class NetworkConfig {
  reviewRules: Listing<ReviewRule> = new {}
  proxy: ProxyConfig = new {}
  pendingTimeoutSeconds: Int = 300
  pendingDefaultScope: "once"|"host-port"|"host" = "host-port"
  pendingNotify: "auto"|"desktop"|"off" = "auto"
}

class ReviewRule {
  method: String?
  host: String?
  pathPrefix: String?
  action: "allow"|"review"|"deny" = "review"
}
```

Deleted: `NetworkPromptConfig` class, `NetworkConfig.allowlist`.

## Evaluation Model

```
1. deny-by-default targets (localhost, loopback, RFC1918, link-local, ULA)
   → deny (unchanged from current behavior)

2. Walk reviewRules top-to-bottom:
   - All specified fields (method, host, pathPrefix) must match
   - Omitted fields match everything
   - First matching rule wins:
     - allow  → immediate allow
     - deny   → immediate deny
     - review → pending queue (user approval)

3. No rule matched → deny ("no-matching-rule")
```

Session-scoped approve/deny caches (`approvedTargets`, `deniedTargets`) remain active for the `review → approved` flow.

## TypeScript Type Changes

```typescript
// DELETE
interface NetworkPromptConfig { ... }

// CHANGE
interface NetworkConfig {
  reviewRules: ReviewRule[];
  proxy: ProxyConfig;
  pendingTimeoutSeconds: number;
  pendingDefaultScope: ApprovalScope;
  pendingNotify: NetworkPromptNotify;
}

interface ReviewRule {
  method?: string;
  host?: string;
  pathPrefix?: string;
  action: "allow" | "review" | "deny";
}
```

## Affected Files

| File | Change |
|------|--------|
| `src/config/Schema.pkl` | Replace `NetworkConfig` + delete `NetworkPromptConfig` |
| `src/config/types.ts` | Replace `NetworkConfig` / `ReviewRule` types, delete `NetworkPromptConfig`, update defaults |
| `src/config/validate.ts` | Delete allowlist/denylist overlap check; validate `host` field on ReviewRule; add shadowing warnings |
| `src/network/broker.ts` | Replace constructor params and `authorize()` with first-match loop over `reviewRules` |
| `src/network/protocol.ts` | Rename `matchesAllowlist` → `matchesHostPattern` |
| `src/stages/proxy/stage.ts` | Update `ProxyStagePlan` and config reading to new structure |
| `src/stages/proxy/network_runtime_service.ts` | Update review rules serialization |
| `src/config/validate_test.ts` | Replace allowlist/denylist tests with reviewRules validation tests |
| `src/network/broker_integration_test.ts` | Rewrite to use reviewRules-based config |
| `src/network/protocol_test.ts` | Rename `matchesAllowlist` references |
| `.nas/config.pkl` | Rewrite to new structure |

## Validation Changes

- Delete `validateAllowlistDenylistOverlap()`.
- Apply existing host-pattern validation (`*.` prefix only, no mid/trailing wildcard) to `ReviewRule.host`.
- Add shadowing warning: if rule N matches a strict superset of rule M (where M > N), warn that M is shadowed. Same pattern as hostexec rule warnings.

## Config Migration Example

Before:
```pkl
local commonNetwork: NetworkConfig = new {
  allowlist = new Listing {
    "api.anthropic.com"
    "*.github.com"
    "registry.npmjs.org"
  }
  prompt {
    enable = true
    denylist = new Listing {
      "http-intake.logs.us5.datadoghq.com"
    }
    reviewRules {
      new { method = "POST"; host = "httpbin.org"; action = "review" }
    }
  }
}
```

After:
```pkl
local function allow(host: String) = new ReviewRule { host = host; action = "allow" }
local function deny(host: String) = new ReviewRule { host = host; action = "deny" }

local commonNetwork: NetworkConfig = new {
  reviewRules {
    // deny telemetry
    deny("http-intake.logs.us5.datadoghq.com")
    // allow known services
    for (h in List(
      "api.anthropic.com",
      "*.github.com",
      "registry.npmjs.org",
    )) {
      allow(h)
    }
    // review specific patterns
    new { method = "POST"; host = "httpbin.org"; action = "review" }
    // catch-all: send unknown traffic to pending queue
    new { action = "review" }
  }
}
```

The trailing `new { action = "review" }` replaces `prompt.enable = true`. Omitting it gives deny-by-default behavior (equivalent to `prompt.enable = false`).

## Migration Guide

A standalone migration guide document will be provided at `docs/migration/network-review-rules.md`. It is designed to be handed to an AI assistant to mechanically rewrite an existing `config.pkl`. Contents:

1. Before/after schema mapping table
2. Step-by-step conversion rules
3. Pkl helper function patterns (`allow()`, `deny()`, `for` loops)
4. Evaluation model explanation (first-match, implicit deny)
5. Common pitfalls (rule ordering, catch-all placement)
