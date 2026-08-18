# Scope-Gated WebSocket Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WebSocket an explicit per-scope opt-in with one HTTP handshake authorization and supplementary outbound message masking, while denying every raw TCP tunnel.

**Architecture:** Keep mitmproxy WebSocket support enabled, add a transport marker to the existing dual-authorizer decision, and retain approved handshake state only in the addon's private memory. Disable mitmproxy raw TCP globally and kill any TCP flow in an addon backstop. Normalize the unreleased authorization document to its final contract version 1.

**Tech Stack:** Bun/TypeScript, Pkl, Python 3 unittest, mitmproxy 11 addon hooks, Docker integration tests

## Global Constraints

- `Scope.webSocket` is exactly `"allow" | "deny"` and defaults to `"deny"`.
- `webSocket = "allow"` permits evaluation of the HTTP handshake; an existing rule or fallback still authorizes it once.
- WebSocket messages never prompt for review.
- Client-to-server WebSocket masking is supplementary byte-pattern masking, not structural validation.
- Raw TCP is denied globally and has no configuration escape hatch.
- The resolved authorization document's final unreleased `contractVersion` is `1`.
- Missing or unknown transport, invalid protocol state, stale session state, oversize messages, and processing errors fail closed.
- Secret-derived patterns stay in addon-private memory and never enter flow metadata, audits, or logs.
- Ordinary HTTP authorization behavior remains unchanged.
- Docker tests use random resource names and `finally` cleanup.

## File Map

- `src/config/Schema.pkl`: public Pkl field and default.
- `src/network/authz/config.ts`: source configuration type.
- `src/network/authz/resolve.ts`: resolved field, contract version, and host decision.
- `src/network/protocol.ts`, `src/network/broker.ts`: wire transport and broker decision.
- `src/docker/mitmproxy/nas_addon.py`: Python contract, local decision, hooks, and state.
- `src/network/fixtures/authz/anthropic-v1.json`: generated contract fixture.
- `src/docker/mitmproxy/decide_parity*`, `message_parity*`: cross-language parity.
- `src/stages/proxy/proxy_service.ts`: production mitmdump options.
- `src/docker/mitmproxy/nas_addon_integration_test.ts`: real protocol tests.
- `docs/migration/network-scopes.md`: public semantics and limitations.

---

### Task 1: Add the Scope Field and Normalize Contract Version 1

**Files:**
- Modify: `src/config/Schema.pkl`
- Modify: `src/network/authz/config.ts`
- Modify: `src/network/authz/resolve.ts`
- Modify: `src/config/pkl_integration_test.ts`
- Modify: `src/network/authz/resolve_test.ts`
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Regenerate: `src/network/fixtures/authz/anthropic-v1.json`
- Modify: `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Interfaces:**
- Produces: `type WebSocketPolicy = "allow" | "deny"`.
- Produces: `ScopeConfig.webSocket?: WebSocketPolicy`.
- Produces: `ResolvedScope.webSocket: WebSocketPolicy`.
- Produces: `ResolvedDocument.contractVersion: 1`.

- [ ] **Step 1: Write failing Pkl and resolver tests**

Add an accepted `webSocket = "allow"` config and an invalid enum case to
`src/config/pkl_integration_test.ts`. Add to
`src/network/authz/resolve_test.ts`:

```ts
test("WebSocket はスコープごとに既定 deny で解決する", () => {
  const document = documentWithScopes({
    closed: { targets: ["closed.example"] },
    open: { targets: ["open.example"], webSocket: "allow" },
  });

  expect(document.contractVersion).toBe(1);
  expect(document.scopes.map(({ name, webSocket }) => [name, webSocket])).toEqual([
    ["closed", "deny"],
    ["open", "allow"],
  ]);
});
```

Change existing assertions that call the resolved contract `v3` or expect
`3` to expect the final version `1`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test src/config/pkl_integration_test.ts src/network/authz/resolve_test.ts src/docker/mitmproxy/nas_addon_test.ts
```

Expected: Pkl has no field, resolved scopes have no policy, and TypeScript and
Python still emit or require contract version 3.

- [ ] **Step 3: Implement Pkl and TypeScript contract fields**

Add to `Scope` in `src/config/Schema.pkl`:

```pkl
/// HTTP handshake の認可後に WebSocket への Upgrade を許すか。
/// message ごとの review は行わず、mask/forbid は補助的に行う。
webSocket: "allow"|"deny" = "deny"
```

Add these TypeScript shapes:

```ts
export type WebSocketPolicy = "allow" | "deny";

export interface ScopeConfig {
  readonly webSocket?: WebSocketPolicy;
}

export interface ResolvedScope {
  readonly webSocket: WebSocketPolicy;
}
```

These are members added to the existing interfaces; do not replace their
other members.

In `resolveScope`, emit `webSocket: scope.config.webSocket ?? "deny"`. Change
the resolved document declaration and constructor to `contractVersion: 1`.

- [ ] **Step 4: Implement the Python version-1 validator**

Set `AUTHZ_CONTRACT_VERSION = 1`, add `"webSocket"` to `_SCOPE_KEYS`, and
validate the optional field:

```py
websocket_policy = value.get("webSocket", "deny")
if websocket_policy not in ("allow", "deny"):
    return False
```

In `AuthzDocumentContractTest`, accept omission, `allow`, and `deny`; reject
`review`, booleans, numbers, and unknown strings. Update hand-built fixtures
to contract version 1.

- [ ] **Step 5: Regenerate the authoritative fixture**

Run:

```bash
bun run scripts/gen_authz_fixture.ts
```

Expected: `anthropic-v1.json` has `"contractVersion": 1` and each resolved
scope has `"webSocket": "deny"`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun test src/config/pkl_integration_test.ts src/network/authz/resolve_test.ts src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/nas_addon_integration_test.ts --test-name-pattern 'contract|fixture|WebSocket'
```

Expected: all selected tests pass and no assertion expects contract 2 or 3.

- [ ] **Step 7: Commit**

```bash
git add src/config/Schema.pkl src/network/authz/config.ts src/network/authz/resolve.ts src/config/pkl_integration_test.ts src/network/authz/resolve_test.ts src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_integration_test.ts src/network/fixtures/authz/anthropic-v1.json
git commit -m "feat(network): define scope WebSocket policy"
```

---

### Task 2: Gate the Handshake in Both Authorizers

**Files:**
- Modify: `src/network/authz/resolve.ts`
- Modify: `src/network/authz/resolve_test.ts`
- Modify: `src/network/protocol.ts`
- Modify: `src/network/protocol_test.ts`
- Modify: `src/network/broker.ts`
- Modify: `src/network/broker_integration_test.ts`
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Modify: `src/docker/mitmproxy/decide_parity.py`
- Modify: `src/docker/mitmproxy/decide_parity_test.ts`
- Modify: `src/docker/mitmproxy/message_parity.py`
- Modify: `src/docker/mitmproxy/message_parity_test.ts`

**Interfaces:**
- Produces: `type RequestTransport = "http" | "websocket"`.
- Produces: required wire field `AuthorizeRequest.transport`.
- Produces: optional internal `DecisionRequest.transport`; omission is HTTP.
- Produces: decision reason `"websocket-denied"`.
- Consumes: `ResolvedScope.webSocket` from Task 1.

- [ ] **Step 1: Write failing host decision tests**

Add cases proving the gate runs before rules and fallbacks:

```ts
test("WebSocket deny は allow rule と review fallback より先に閉じる", () => {
  const document = documentWithScopes(
    {
      api: {
        targets: ["api.example.com"],
        fallback: "review",
        rules: { all: { match: { paths: ["/**"] }, onMatch: "allow" } },
      },
    },
    "review",
  );
  expect(decide(document, at("api.example.com"), {
    method: "GET",
    path: "/ws",
    transport: "websocket",
  })).toMatchObject({
    action: "deny",
    ruleId: "api.$fallback",
    reason: "websocket-denied",
  });
});
```

Also prove explicit scope allow reaches an ordinary `review` rule, no matching
scope denies despite network fallback `review`, and omitted transport keeps
ordinary HTTP behavior.

- [ ] **Step 2: Write failing wire and broker tests**

Add `transport: "http"` to valid authorize messages. Reject this matrix:

```ts
for (const transport of [undefined, "ws", "WebSocket", true, null]) {
  const message = { ...validAuthorize } as Record<string, unknown>;
  if (transport === undefined) delete message.transport;
  else message.transport = transport;
  expect(validateAuthorizeRequest(message, SESSION_ID, document)).not.toBeNull();
}
```

In `broker_integration_test.ts`, prove a WebSocket request to a default-deny
scope returns `websocket-denied` immediately with no pending entry. Prove an
allow-scope `review` rule creates exactly one handshake pending group.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
bun test src/network/authz/resolve_test.ts src/network/protocol_test.ts src/network/broker_integration_test.ts --test-name-pattern 'WebSocket|transport|websocket'
```

Expected: resolver reaches normal rules, the validator rejects the new valid
producer field, and broker does not enforce the protocol gate.

- [ ] **Step 4: Implement the TypeScript gate and wire validation**

Add:

```ts
export type RequestTransport = "http" | "websocket";

export interface AuthorizeRequest {
  transport: RequestTransport;
}
```

Add the member to the existing version-1 interface; do not duplicate or
remove its current fields.

Add `transport` to `AUTHORIZE_FIELDS`, require one of the two values, and pass
it through `toAuthzRequest`. In `decide`, select the scope first and return a
deny before candidate collection when transport is WebSocket and either no
scope matches or the matched scope does not say `allow`.

The no-scope result uses `$fallback` plus document defaults. The scope result
uses `<scope>.$fallback` plus scope secrets/limits/audit. Both use no inject,
no expectations, no concrete rule, and reason `websocket-denied`.

- [ ] **Step 5: Implement Python parity and Upgrade classification**

Add:

```py
def _request_transport(request) -> str:
    upgrade = request.headers.get("upgrade", "")
    tokens = {
        token.strip().lower()
        for token in upgrade.split(",")
        if token.strip()
    }
    return "websocket" if "websocket" in tokens else "http"
```

Extend `_authorize_message` with transport and `_decide` with the same
pre-rule gate. `NasAddon.request` passes the classifier result to both the
local decision and broker message.

Add transport to every `decide_parity` case and cover default deny, explicit
allow, and ordinary HTTP. Make `message_parity.py` produce `transport: "http"`
and assert the broker accepts it.

- [ ] **Step 6: Run the complete parity bundle and verify GREEN**

```bash
bun test src/network/authz/resolve_test.ts src/network/protocol_test.ts src/network/broker_integration_test.ts src/docker/mitmproxy/decide_parity_test.ts src/docker/mitmproxy/message_parity_test.ts src/docker/mitmproxy/nas_addon_test.ts
```

Expected: all pass; default-denied WebSocket never enters pending and every
host/addon case agrees.

- [ ] **Step 7: Commit**

```bash
git add src/network/authz/resolve.ts src/network/authz/resolve_test.ts src/network/protocol.ts src/network/protocol_test.ts src/network/broker.ts src/network/broker_integration_test.ts src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/decide_parity.py src/docker/mitmproxy/decide_parity_test.ts src/docker/mitmproxy/message_parity.py src/docker/mitmproxy/message_parity_test.ts
git commit -m "feat(network): gate WebSocket handshakes by scope"
```

---

### Task 3: Mask Authorized WebSocket Messages and Close Invalid State

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`

**Interfaces:**
- Produces: addon-private `_websocket_states: dict[str, dict]`, keyed by
  `HTTPFlow.id`.
- Produces hooks: `response`, `websocket_start`, `websocket_message`, and
  `websocket_end`.
- Consumes: `_mask_bytes`, `_load_registry`, broker mask/forbid values, and
  local decision limits.

- [ ] **Step 1: Add fake messages and failing lifecycle tests**

Add minimal fakes:

```py
class FakeWebSocketMessage:
    def __init__(self, content: bytes, from_client: bool = True):
        self.content = content
        self.from_client = from_client
        self.dropped = False

    def drop(self):
        self.dropped = True


class FakeWebSocketData:
    def __init__(self, message):
        self.messages = [message]
```

Give `FakeFlow` a stable `id` and optional `websocket`. Add separate tests
for each behavior:

- authorized client `b"token=SECRET123"` becomes `b"token=****"`;
- server message stays unchanged;
- forbid match drops and kills;
- `maxBodyBytes + 1` drops and kills;
- removed session drops and kills;
- missing state at `websocket_start` kills;
- non-101 response, `websocket_end`, and disconnect remove state;
- an injected `_mask_bytes` exception drops and kills without logging content.

- [ ] **Step 2: Run the Python wrapper and verify RED**

```bash
bun test src/docker/mitmproxy/nas_addon_test.ts
```

Expected: failures identify the missing state and hook methods.

- [ ] **Step 3: Retain private state after a fully allowed handshake request**

Initialize:

```py
self._websocket_states: dict[str, dict] = {}
```

Add `limits` to every Python `_decide` result so concrete rules and both
fallbacks expose the same effective `maxBodyBytes` as TypeScript. After HTTP
inspection, masking, injection, and proxy-auth removal all succeed, store:

```py
self._websocket_states[flow.id] = {
    "clientId": flow.client_conn.id,
    "sessionId": session_id,
    "ruleId": rule_id,
    "maxBodyBytes": local["limits"]["maxBodyBytes"],
    "maskPatterns": tuple(patterns),
    "forbidPatterns": tuple(
        self._forbid_patterns_for(forbid_values) if forbid_values else []
    ),
}
```

Store this only for transport `websocket`. Do not write it to
`flow.metadata`.

- [ ] **Step 4: Implement fail-closed lifecycle and message hooks**

Use a helper that drops the current message when present, removes state,
kills the flow, and prints only safe labels:

```py
def _close_websocket(self, flow, reason: str) -> None:
    websocket = getattr(flow, "websocket", None)
    if websocket and websocket.messages:
        websocket.messages[-1].drop()
    state = self._websocket_states.pop(flow.id, None)
    print(
        "[nas-addon] WEBSOCKET-CLOSED: "
        f"session={_safe_session_label((state or {}).get('sessionId', ''))} "
        f"rule={_safe_rule_label((state or {}).get('ruleId'))} "
        f"reason={reason}",
        file=sys.stderr,
    )
    flow.kill()
```

`reason` comes only from source literals: `missing-state`, `stale-session`,
`forbidden-secret`, `resource-limit`, and `processing-failed`.

Implement:

```py
def response(self, flow: http.HTTPFlow) -> None:
    if getattr(flow, "websocket", None) is None:
        self._websocket_states.pop(flow.id, None)

def websocket_start(self, flow: http.HTTPFlow) -> None:
    if flow.id not in self._websocket_states:
        self._close_websocket(flow, "missing-state")

def websocket_message(self, flow: http.HTTPFlow) -> None:
    state = self._websocket_states.get(flow.id)
    if state is None:
        self._close_websocket(flow, "missing-state")
        return
    message = flow.websocket.messages[-1]
    if not message.from_client:
        return
    try:
        if _load_registry(state["sessionId"]) is None:
            self._close_websocket(flow, "stale-session")
            return
        if len(message.content) > state["maxBodyBytes"]:
            self._close_websocket(flow, "resource-limit")
            return
        if any(p in message.content for p in state["forbidPatterns"]):
            self._close_websocket(flow, "forbidden-secret")
            return
        message.content = _mask_bytes(message.content, state["maskPatterns"])
    except Exception:
        self._close_websocket(flow, "processing-failed")

def websocket_end(self, flow: http.HTTPFlow) -> None:
    self._websocket_states.pop(flow.id, None)
```

Extend `client_disconnected` to remove states whose `clientId` matches before
existing session/cache cleanup.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
bun test src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/message_parity_test.ts
```

Expected: all pass and captured stderr contains neither test secret nor
message content.

- [ ] **Step 6: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): mask authorized WebSocket messages"
```

---

### Task 4: Disable and Backstop Raw TCP

**Files:**
- Modify: `src/stages/proxy/proxy_service.ts`
- Modify: `src/stages/proxy/proxy_service_test.ts`
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Modify: `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Interfaces:**
- Produces: production options `rawtcp=false` and `websocket=true`.
- Produces: `tcp_start(flow)` that always kills.

- [ ] **Step 1: Write failing command and hook tests**

Change the exact expected command in `proxy_service_test.ts` to include:

```ts
"--set",
"rawtcp=false",
"--set",
"websocket=true",
```

Add:

```py
def test_tcp_start_always_kills(self):
    addon = nas_addon.NasAddon()
    flow = FakeFlow(FakeRequest())
    addon.tcp_start(flow)
    self.assertTrue(flow.killed)
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
bun test src/stages/proxy/proxy_service_test.ts src/docker/mitmproxy/nas_addon_test.ts --test-name-pattern 'command|TCP|tcp'
```

Expected: production command lacks the options and addon lacks `tcp_start`.

- [ ] **Step 3: Implement production options and the addon backstop**

Add both options immediately after `connection_strategy=lazy`. Add:

```py
def tcp_start(self, flow) -> None:
    flow.kill()
```

Do not add authentication, inspection, or a configuration branch. Update
every mitmdump command in `nas_addon_integration_test.ts` with the same two
explicit options so fixtures exercise production protocol selection.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
bun test src/stages/proxy/proxy_service_test.ts src/docker/mitmproxy/nas_addon_test.ts
```

Expected: all pass and the exact production command pins both options.

- [ ] **Step 5: Commit**

```bash
git add src/stages/proxy/proxy_service.ts src/stages/proxy/proxy_service_test.ts src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_integration_test.ts
git commit -m "fix(network): close raw CONNECT tunnels"
```

---

### Task 5: Prove the Boundary with Real mitmproxy

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Interfaces:**
- Produces: generalized `setupAddonFixture(prefix, document, secretValues)`.
- Produces: `openWebSocketThroughProxy(...)` and
  `openConnectTunnel(...)` test helpers.
- Consumes: transport gate, message hooks, and mitmdump options from Tasks
  2–4.

- [ ] **Step 1: Generalize the fixture and preserve cleanup coverage**

Change the existing setup helper to accept its installed contract and secret
values:

```ts
async function setupAddonFixture(
  dirPrefix: string,
  document: ResolvedDocument = RESOLVED_DOCUMENT,
  secretValues: Readonly<Record<string, readonly string[]>> = {
    workspace: ["SECRET123"],
  },
  options: AddonFixtureSetupOptions = {},
): Promise<AddonFixture>
```

Inside the existing setup body, replace both `RESOLVED_DOCUMENT` uses with
`document` and replace the fixed `secretValues` object passed to
`SessionBroker` with the parameter. Rename local helper types and calls
without moving production code. Keep the existing injected post-broker
setup-failure test green.

- [ ] **Step 2: Add deterministic WebSocket target/client helpers**

Add a Python target script that reads an HTTP Upgrade, computes
`Sec-WebSocket-Accept`, decodes masked client frames, logs decoded payloads,
and echoes unmasked server frames. It loops over connections so readiness
probes cannot consume the server.

Add a bounded client interface:

```ts
interface ProxyWebSocket {
  socket: net.Socket;
  responseHeaders: string;
  sendText(text: string): void;
  readText(): Promise<string>;
  close(): void;
}

async function openWebSocketThroughProxy(
  proxyPort: number,
  targetUrl: string,
  credentials: string,
): Promise<ProxyWebSocket>
```

The helper sends an absolute-form `GET` with `Host`, `Proxy-Authorization`,
`Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Version: 13`, and
a fixed test key. Buffer until `\r\n\r\n`; return on `101` or resolve a closed
result on any other status. Use this complete small-message encoder:

```ts
function encodeClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error("test frame exceeds 125 bytes");
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  Buffer.from(mask).copy(frame, 2);
  for (let i = 0; i < payload.length; i++) {
    frame[6 + i] = payload[i]! ^ mask[i % 4]!;
  }
  return frame;
}
```

`readText` requires FIN+text, an unmasked server frame, and payload length at
most 125; any other opcode, mask bit, extended length, timeout, or early close
rejects the promise.

Every read has a five-second timeout. Every test destroys client sockets and
Docker resources in `finally`.

- [ ] **Step 3: Add default-deny and one-review tests**

Build documents through the real resolver:

```ts
const deniedWebSocketDocument = documentWithScopes({
  chatgpt: {
    targets: ["chatgpt.test:8091"],
    rules: {
      ws: { match: { methods: ["GET"], paths: ["/ws"] }, onMatch: "allow" },
    },
  },
});

const reviewedWebSocketDocument = documentWithScopes({
  chatgpt: {
    targets: ["chatgpt.test:8091"],
    webSocket: "allow",
    fallback: "deny",
    rules: {
      ws: { match: { methods: ["GET"], paths: ["/ws"] }, onMatch: "review" },
    },
  },
});
```

Add tests named:

- `websocket: default-denied scope returns 403 before upstream handshake`
- `websocket: one handshake approval releases multiple messages without another pending item`

The second test begins the handshake, waits for one pending item, approves it,
checks `101`, exchanges two messages, then verifies `broker.listPending()` is
empty.

- [ ] **Step 4: Run the new tests and verify RED for the original bypass**

```bash
bun test src/docker/mitmproxy/nas_addon_integration_test.ts --test-name-pattern 'websocket:'
```

Expected against the original implementation: default-denied handshake
reaches upstream and post-101 messages pass without retained authorization.
Expected after Tasks 2/3: both tests pass.

- [ ] **Step 5: Add real mask, forbid, budget, and stale-session cases**

Resolve this policy:

```ts
const protectedWebSocketDocument = resolvedDocument({
  secrets: {
    masking: { from: "env:MASKING" },
    blocking: { from: "env:BLOCKING" },
  },
  mask: { proxy: true, apply: ["masking"] },
  network: {
    scopes: {
      chatgpt: {
        targets: ["chatgpt.test:8091"],
        webSocket: "allow",
        secrets: { masking: "mask", blocking: "forbid" },
        rules: {
          ws: {
            match: { methods: ["GET"], paths: ["/ws"] },
            onMatch: "allow",
            limits: { maxBodyBytes: 64 },
          },
        },
      },
    },
  },
});
```

Install `{ masking: ["MASKME123"], blocking: ["BLOCKME123"] }`. Prove:

- `hello MASKME123` is logged and echoed only as `hello ****`;
- `BLOCKME123` is dropped and never appears upstream; later messages stay
  blocked;
- a 65-byte message is dropped and never appears upstream; later messages
  stay blocked;
- deleting `sessionRegistryPath(...)` after `101` drops the next message and
  keeps later messages from reaching upstream.

- [ ] **Step 6: Add the raw CONNECT regression**

`openConnectTunnel` sends:

```text
CONNECT raw.test:8092 HTTP/1.1\r\n
Host: raw.test:8092\r\n
Proxy-Authorization: Basic <credentials>\r\n
\r\n
```

After the lazy proxy returns `200`, send `SSH-2.0-nas-raw-probe\r\n`. A fake
raw target logs all bytes. Add:

```ts
test("raw CONNECT: authenticated non-HTTP bytes never reach upstream", async () => {
  const tunnel = await openConnectTunnel(proxyPort, "raw.test:8092", credentials);
  tunnel.write("SSH-2.0-nas-raw-probe\r\n");
  await waitForSocketClose(tunnel, 5_000);
  expect(await dockerLogs(targetName)).not.toContain("nas-raw-probe");
}, 60_000);
```

The surrounding test creates the random RFC 2544 network, target, proxy, and
fixture before these assertions and stops/removes each one in `finally`, using
the same cleanup calls as the existing integration cases.

- [ ] **Step 7: Run real protocol tests and verify GREEN**

```bash
bun test src/docker/mitmproxy/nas_addon_integration_test.ts --test-name-pattern 'websocket:|raw CONNECT:'
```

Expected: all pass; upstream and addon logs contain no unmasked test secret.

- [ ] **Step 8: Commit**

```bash
git add src/docker/mitmproxy/nas_addon_integration_test.ts
git commit -m "test(network): close WebSocket and raw TCP bypasses"
```

---

### Task 6: Document, Verify the Real Config, and Run Final Gates

**Files:**
- Modify: `docs/migration/network-scopes.md`
- Modify: `src/config/repo_pkl_test.ts`

**Interfaces:**
- Consumes: checked-in `.nas/config.pkl` scope `openai`, including
  `chatgpt.openai.com:443` and `webSocket = "allow"`.
- Produces: public guidance and real-config regression coverage.

- [ ] **Step 1: Add the repository-config RED assertion**

Extend the OpenAI test:

```ts
const openai = resolved.document!.scopes.find((scope) => scope.name === "openai");
expect(openai?.webSocket).toBe("allow");

expect(decide(
  resolved.document!,
  { host: "chatgpt.openai.com", port: 443 },
  {
    method: "GET",
    path: "/ws-handshake-probe",
    transport: "websocket",
  },
)).toMatchObject({
  action: "review",
  ruleId: "openai.$fallback",
  reason: "scope-fallback",
});
```

Correct stale expected IDs from `openai-responses.*` to the checked-in scope
name `openai.*` in the same test.

- [ ] **Step 2: Run the real-config test**

```bash
bun test src/config/repo_pkl_test.ts --test-name-pattern 'OpenAI Responses'
```

Expected after Tasks 1/2: the config loads, the scope opts in, and the actual
ChatGPT handshake reaches one review fallback.

- [ ] **Step 3: Add public guidance**

Add `## WebSocket and Raw TCP` to `docs/migration/network-scopes.md` with:

```pkl
["chatgpt"] {
  targets { "chatgpt.openai.com:443" }
  webSocket = "allow"
  fallback = "review"
}
```

State that WebSocket defaults deny, the HTTP handshake is authorized once,
frames do not prompt, message masking is supplementary, structural guarantees
require ordinary HTTP JSON `expect`, and raw TCP is always denied.

- [ ] **Step 4: Run focused semantic suites**

```bash
bun test src/config/pkl_integration_test.ts src/config/repo_pkl_test.ts src/network/authz/resolve_test.ts src/network/protocol_test.ts src/network/broker_integration_test.ts src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/decide_parity_test.ts src/docker/mitmproxy/message_parity_test.ts src/stages/proxy/proxy_service_test.ts src/docker/mitmproxy/nas_addon_integration_test.ts
```

Expected: zero failures; Docker skips occur only through existing guards.

- [ ] **Step 5: Run project post-change checks**

```bash
bun run fmt
bun run lint
bun run check
git diff --check
bun test
```

Expected: formatting introduces no semantic change, every static check exits
0, and the full suite has zero failures.

- [ ] **Step 6: Perform the real Codex WebSocket smoke test**

```bash
nix run .#default -- codex -p 'Reply exactly websocket-ok'
```

Approve the single pending `chatgpt.openai.com:443` handshake in the nas UI.
Expected: Codex replies `websocket-ok`, the socket does not create one pending
item per message, and proxy logs contain no raw prompt or secret. If OAuth
fails, report it separately and do not weaken network policy.

Afterward, remove only the known shared proxy if it remains:

```bash
docker stop --timeout 0 nas-proxy-shared
docker rm nas-proxy-shared
```

- [ ] **Step 7: Commit docs and real-config coverage**

```bash
git add docs/migration/network-scopes.md src/config/repo_pkl_test.ts
git commit -m "docs(network): explain WebSocket scope boundaries"
```

- [ ] **Step 8: Audit final scope**

```bash
git status --short
git log --oneline --decorate -8
```

Expected: no uncommitted source/test/doc changes, no temporary Docker
resources, and exactly six task commits above the design and plan commits.
