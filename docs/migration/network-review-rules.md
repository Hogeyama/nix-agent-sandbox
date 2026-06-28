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
