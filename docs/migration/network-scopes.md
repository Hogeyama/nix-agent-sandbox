# Network Config Migration: Scopes and Named Secrets

Current network authorization is expressed with `network.scopes`, named
`Rule` entries, the profile-level `secrets` registry, and per-scope or
per-rule `inject` declarations. This guide migrates configurations that use
any of the removed request-policy or credential identifiers.

## Migration Order

1. Move secret sources into the profile-level `secrets` registry.
2. Replace host-oriented review rules with target-oriented `Scope` entries.
3. Put request selection in each scope's named `rules` mapping.
4. Put required body properties in `expect`, not in a broader fallback rule.
5. Choose explicit scope and network `fallback` outcomes.

## Legacy Identifier Mapping

| Removed identifier | Current form |
| --- | --- |
| `reviewRules` | `network.scopes`, with named entries in each scope's `rules` mapping |
| `ReviewRule` | `Scope` for targets and `Rule` for method, path, body, and outcome |
| `credentials` | Profile-level `secrets`, plus scope or rule `secrets` and `inject` |
| `CredentialRule` | A `Scope` or `Rule` whose `inject` entries reference named secrets |
| `CredentialValSpec` | `SecretConfig { from = "env:..." }` or another supported `from` source |
| `BodylessRequestPolicy` | `match.body { format = "none" }` for selection, or `new EmptyBody {}` for validation |
| `JsonRequestPolicy` | `match.body { format = "json" }`, optionally with JSON `expect` entries |
| `TaggedUnionGuard` | `new UnionShape { ... }` in a rule's `expect` listing |
| `anthropicV1` | `module.presets.anthropic.v1` assigned to a named scope |
| `anthropicJsonPolicy` | `module.presets.anthropic.v1`; the preset is a scope, not a function |
| `MaskValueConfig` | A named profile `secrets` entry; select maskfs/filter inputs with `mask.apply` |
| `pendingDefaultScope` | Remove it; approval reuse is derived from the matched rule and violation |

## Basic Scope and Rules

Targets belong to a scope. Named rules select requests inside that scope.
Requests that match no rule use the scope's `fallback`; requests that match no
scope use `network.fallback`.

```pkl
network {
  fallback = "deny"

  scopes {
    ["example"] {
      targets { "api.example.com" }
      fallback = "deny"

      rules {
        ["read"] {
          match {
            methods { "GET" }
            paths { "/v1/items/**" }
          }
          onMatch = "allow"
        }
      }
    }
  }
}
```

Rule order is only a tie-breaker. The resolver normally evaluates more
specific matches first. If overlapping matches cannot be ordered by
specificity, use `overrides` or make them disjoint.

## Named Secrets and Header Injection

Secret values are never written literally in `config.pkl`. Register their
source by name, mark that name as injectable in the applicable scope or rule,
then reference it from an `Inject` value.

```pkl
secrets {
  ["example-token"] {
    from = "env:EXAMPLE_TOKEN"
  }
}

network {
  scopes {
    ["example"] {
      targets { "api.example.com:443" }
      fallback = "deny"
      secrets { ["example-token"] = "inject" }
      inject {
        new Inject {
          name = "Authorization"
          value = #"template:Bearer ${example-token}"#
        }
      }

      rules {
        ["all"] {
          match { paths { "/**" } }
          onMatch = "allow"
        }
      }
    }
  }
}
```

Use `"mask"`, `"forbid"`, or `"ignore"` instead of `"inject"` when that is
the intended disposition. `network.defaults.secrets` supplies the default;
scope values override it, and rule values override the scope.

`MaskValueConfig` no longer exists. A value that should be masked is a named
secret, and `mask.apply` selects which named secrets maskfs and the output
filter use:

```pkl
secrets {
  ["workspace-secret"] {
    from = "lines:demo/secrets.txt"
  }
}

mask {
  maskfs = false
  proxy = true
  filter = true
  apply { "workspace-secret" }
}
```

Proxy masking is controlled by the effective secret disposition in the
selected scope or rule. `mask.apply` only selects inputs for maskfs and the
output filter.

## JSON and Empty-Body Policies

Use `match` to choose the rule responsible for a request. Use `expect` for a
condition that the selected request must satisfy.

```pkl
rules {
  ["json-create"] {
    match {
      methods { "POST" }
      paths { "/v1/items" }
      body { format = "json" }
    }
    onMatch = "allow"
    onIndeterminate = "deny"
    expect {
      new JsonRoot { rootType = "object" }
      new UnionShape {
        at = "/content/*"
        discriminator = "type"
        allowed { "text"; "image" }
        onViolation = "review"
      }
    }
  }

  ["empty-get"] {
    match {
      methods { "GET" }
      paths { "/v1/status" }
    }
    onMatch = "allow"
    expect { new EmptyBody {} }
  }
}
```

`match.body { format = "none" }` instead means that a body-bearing request is
not selected by that rule and evaluation continues to another rule or the
scope fallback.

## Anthropic Preset

The Anthropic preset is a complete `Scope`. Assign it directly inside the
`scopes` mapping; `module.` is required from an amend block.

```pkl
network {
  scopes {
    ["anthropic"] = module.presets.anthropic.v1
  }
}
```

The preset allows the Claude Code endpoints it knows, validates message body
shape, and denies unmatched Anthropic endpoints through its scope fallback.
Amend the same scope to add a compatible endpoint rather than creating a
second scope with the same target.

## Approval Behavior

Use `onMatch = "review"`, `onViolation = "review"`, or a `fallback = "review"`
to request operator approval. There is no `pendingDefaultScope`: approval
identity and reuse are derived from the matched rule and, for expectation
violations, the specific violation. Timeouts remain fail-closed and are
configured with `network.pendingTimeoutSeconds`.

## WebSocket and Raw TCP

WebSocket is denied by default. Opt in only on a scope whose targets need it:

```pkl
network {
  scopes {
    ["chatgpt"] {
      targets { "chatgpt.com:443" }
      webSocket = "allow"
      fallback = "review"
    }
  }
}
```

The opening HTTP Upgrade request goes through the scope's ordinary rules and
fallback exactly once. After approval, individual WebSocket messages do not
create further review requests. Client-to-server messages still receive the
configured byte-pattern mask and forbid checks, but those checks are
supplementary: they cannot establish a JSON schema or prove that a secret is
absent from an application-specific encoding. Use ordinary HTTP with JSON
`expect` conditions when a structural guarantee is required.

A forbidden, over-budget, stale-session, or otherwise unprocessable client
message is dropped and the addon's private authorization state is retired, so
later messages are not forwarded. Physical socket closure is best-effort and
is not the security boundary.

Raw TCP is not configurable per scope and is always denied. Non-HTTP tunnel
bytes are not forwarded upstream; immediate client socket closure is not
guaranteed.
