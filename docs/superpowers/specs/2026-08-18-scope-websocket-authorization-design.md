# Scope-Gated WebSocket Authorization Design

**Date:** 2026-08-18

## Problem

The shared network proxy runs mitmproxy in regular mode with a lazy upstream
connection strategy. The addon currently authorizes `CONNECT` and HTTP
requests, but it does not handle WebSocket or raw TCP events.

This leaves two protocol transitions outside the request policy:

- After an HTTP `101 Switching Protocols` response, mitmproxy forwards
  WebSocket messages without calling the addon's HTTP `request` hook again.
- mitmproxy enables raw TCP by default. Non-HTTP bytes inside an authenticated
  `CONNECT` tunnel can therefore fall through to a TCP layer and be forwarded
  without an HTTP request decision.

The network policy must remain closed for protocols it does not inspect. At
the same time, Codex uses a long-lived WebSocket connection to ChatGPT, so a
scope needs an explicit way to opt in to that protocol without prompting for
every message.

## Goals

- Deny WebSocket by default and allow it only for an explicitly opted-in
  network scope.
- Authorize the WebSocket HTTP handshake exactly once with the existing rule
  and fallback model.
- Apply the existing secret byte-pattern masking and forbidding to outbound
  WebSocket messages as a supplementary control.
- Deny non-HTTP `CONNECT` tunnels and raw TCP for every scope, with no escape
  hatch in configuration.
- Fail closed when protocol state, session state, or contract data is missing
  or invalid.
- Keep the unreleased resolved authorization document at contract version 1.

## Non-Goals

- Per-message operator review.
- JSON `match` or `expect` evaluation over WebSocket messages.
- A guarantee that byte-pattern masking detects custom encryption, arbitrary
  application encodings, or a secret split across multiple WebSocket
  messages.
- Raw TCP policy, masking, or per-scope raw TCP enablement.
- A per-rule WebSocket switch. HTTP method and path rules still restrict which
  handshakes a scope may authorize.

## Configuration Model

`Scope` gains one property:

```pkl
webSocket: "allow"|"deny" = "deny"
```

For example:

```pkl
["chatgpt"] {
  targets { "chatgpt.openai.com:443" }
  webSocket = "allow"
  fallback = "review"

  rules {
    // Add a method/path rule once the handshake endpoint is pinned. Until
    // then, the fallback reviews the handshake once per approval identity.
  }
}
```

`webSocket = "allow"` only makes an HTTP Upgrade eligible. It does not grant
the handshake by itself. The normal method, path, body selection, rule action,
and scope fallback still decide whether the handshake is allowed, reviewed,
or denied. A scope with `webSocket = "deny"` rejects a WebSocket attempt even
if an ordinary HTTP rule would otherwise allow the request.

A target that matches no scope cannot open a WebSocket. Network fallback does
not override the protocol gate.

## Contract Shape

The resolved scope carries an explicit `webSocket` value in newly generated
documents. Consumers treat a missing value as `deny`, and reject any value
other than `allow` or `deny`.

The authorization document is not released yet. Its final format, including
`webSocket`, is contract version 1. TypeScript declarations, the Python addon,
JSON fixtures, and parity tests all use version 1; intermediate development
version numbers are removed rather than supported as compatibility contracts.

The addon marks each authorization request as HTTP or WebSocket. A missing or
unknown transport marker is invalid and denied. The broker and addon evaluate
the same scope protocol gate so that neither side can approve a request the
other side classified differently.

## Handshake Data Flow

For a secure WebSocket connection through the regular proxy:

1. The client authenticates an outer `CONNECT host:443` request.
2. mitmproxy terminates the client TLS connection.
3. The client sends the HTTP WebSocket handshake inside that TLS connection.
4. The addon recognizes the WebSocket Upgrade request before any upstream
   connection is made.
5. The addon and broker select the target scope and enforce its `webSocket`
   value.
6. If the scope allows WebSocket, the existing rule/fallback decision
   authorizes the handshake once. Review, if selected, occurs here only.
7. The addon masks the HTTP handshake and performs any configured header
   injection as it does for other authorized HTTP requests.
8. Only after an authorized upstream returns `101 Switching Protocols` does
   the addon retain state for WebSocket message processing.

A denied protocol gate returns a fixed `403` before the handshake reaches the
upstream. It does not create a review item. The denial uses bounded labels and
never logs request headers, paths, or message contents.

## WebSocket Connection State

Authorization state is held in the addon's private memory and keyed by the
HTTP flow identity. It is not placed in flow metadata, dump files, or audit
records because it contains patterns derived from secret values.

The state contains only what subsequent client messages need:

- session identity;
- selected rule or fallback identity;
- effective `maxBodyBytes`;
- derived mask patterns; and
- derived forbid patterns.

The HTTP response hook retains the state only for a valid WebSocket `101`
transition and removes it for every ordinary response. `websocket_start`
requires this state as a defense-in-depth check. Missing state kills the
connection before a message is relayed.

State is removed at `websocket_end`, client disconnect, failed upgrade, or
any fail-closed termination. A client message also rechecks that its session
registry entry still exists, so removing the session closes an otherwise
long-lived socket on its next message.

## Message Processing

Only client-to-server WebSocket messages are egress and are rewritten.
Server-to-client messages are forwarded unchanged.

mitmproxy calls `websocket_message` with a complete logical message after
reassembling WebSocket fragments and processing negotiated per-message
compression. The addon applies the same derived byte patterns used for HTTP
request masking:

1. If any effective forbid pattern occurs, drop the message and close the
   connection.
2. Replace effective mask patterns with the fixed mask marker.
3. Forward the rewritten message.

If the message exceeds the selected rule or fallback `maxBodyBytes`, the
session is missing, state is invalid, or processing raises, the addon drops
the message and closes the connection.

The handshake keeps the existing authorization and request-policy audit
behavior. WebSocket hooks do not create one structured audit row per message:
an attacker controls the message count and could otherwise amplify the audit
log without bound. A fail-closed message termination emits one fixed,
content-free addon diagnostic with only validated session and rule labels.
Successful and rewritten messages create no additional audit rows in this
change.

This is deliberately a supplementary control. A complete message lets the
addon catch plaintext and the existing URL/base64 variants, including a value
split across WebSocket frames within that message. It cannot prove the absence
of a value transformed by an arbitrary application encoding or split across
separate messages. Scopes that require structural egress guarantees must keep
WebSocket denied and use an HTTP rule with JSON `expect` conditions instead.

## Raw TCP Enforcement

Every production and integration mitmdump invocation sets:

```text
--set rawtcp=false
```

With raw TCP disabled, protocol detection cannot turn non-HTTP bytes inside a
`CONNECT` tunnel into a forwarding TCP layer. The addon also implements a
`tcp_start` hook that unconditionally kills any TCP flow. This hook is a
backstop for a future startup-option regression or an unexpected mitmproxy
layer transition; there is no configuration that relaxes it.

WebSocket support remains enabled globally in mitmproxy because scope policy
is enforced by the addon. A denied scope never reaches the WebSocket layer.

## Failure Semantics

The following conditions close rather than forward:

- no matching scope for a WebSocket attempt;
- `webSocket` missing, `deny`, or invalid;
- broker/addon transport or rule disagreement;
- handshake denial, review denial, or review timeout;
- a `101` transition without retained authorization state;
- missing session state during a client message;
- forbidden secret pattern in a client message;
- client message over the effective byte budget;
- masking or message-processing exception; and
- any raw TCP flow.

An ordinary authorized HTTP request is unchanged by this feature.

## Testing Strategy

### Schema and Resolver

- Pkl accepts `webSocket = "allow"` and rejects other values.
- Omission resolves to `deny`.
- Resolved documents and all fixtures use contract version 1.
- Scope serialization contains the resolved value.

### Host/Addon Contract and Parity

- Both evaluators cover HTTP and WebSocket transport across scope
  allow/deny and rule allow/review/deny outcomes.
- Missing or unknown transport and invalid `webSocket` values fail closed.
- A WebSocket scope denial cannot be changed into review by a rule or
  fallback.

### Addon Unit Tests

- Unauthorized `websocket_start` kills the flow.
- Authorized client messages are masked; server messages are unchanged.
- Forbid matches, oversize messages, missing sessions, and invalid state drop
  the message and close the flow.
- State is cleaned up on non-101 responses, WebSocket end, and disconnect.
- `tcp_start` always kills the flow.

### Real mitmproxy Integration

- Default-denied WebSocket handshakes return `403` without reaching a fake
  upstream.
- An opted-in scope performs one handshake approval, then exchanges multiple
  messages without per-message review.
- A plaintext secret in a client message reaches the fake echo server only as
  the mask marker.
- Forbid, oversize, and expired-session paths close before their offending
  message reaches the fake upstream.
- Arbitrary bytes after an authenticated `CONNECT` never reach a raw TCP fake
  upstream.
- The production command test pins `rawtcp=false`.

All Docker integration tests use random resource names and clean up containers
and networks in `finally` blocks.

## Documentation

The public network configuration reference and migration guide document:

- the default-deny behavior;
- the one-time handshake approval boundary;
- the absence of per-message review;
- the supplementary, non-structural nature of WebSocket masking; and
- raw TCP's unconditional denial.
