# Network SSRF Hardening Design

## Goal

Close the two P0 network authorization gaps recorded as H5 and H6 in
`docs/todo/security.md`:

- reject missing special-purpose IP ranges consistently in the TypeScript
  broker and Python mitmproxy addon; and
- prevent DNS rebinding and DNS time-of-check/time-of-use changes by resolving,
  validating, and pinning the upstream address immediately before mitmproxy
  opens the connection.

The security outcome is that an allowed hostname cannot make the shared proxy
connect to a denied host, container, or link-local address, even if its DNS
answer changes after authorization.

## Scope

This change covers the network authorization predicate, mitmproxy upstream
connection handling, unit tests, and a Docker-backed integration test. It also
updates the H5/H6 status in `docs/todo/security.md` after verification passes.

The following work remains separate:

- removal of the gcloud, AWS, and GPG passthrough settings;
- general container capability hardening;
- authentication-directory mount hardening;
- firewall or routing-policy changes; and
- a configurable user override for denied IP ranges.

Denied destinations are a security invariant and will not be made
user-configurable in this change.

## Security Policy

The TypeScript broker and Python addon will deny the following destinations:

| Address family | Denied ranges | Reason |
| --- | --- | --- |
| IPv4 | `0.0.0.0/8` | Current-network and unspecified forms |
| IPv4 | `10.0.0.0/8` | Private network |
| IPv4 | `100.64.0.0/10` | Carrier-grade NAT/shared address space |
| IPv4 | `127.0.0.0/8` | Loopback |
| IPv4 | `169.254.0.0/16` | Link-local, including metadata endpoints |
| IPv4 | `172.16.0.0/12` | Private network |
| IPv4 | `192.168.0.0/16` | Private network |
| IPv6 | `::/128` | Unspecified address |
| IPv6 | `::1/128` | Loopback |
| IPv6 | `fc00::/7` | Unique-local address |
| IPv6 | `fe80::/10` | Link-local address |

An IPv4-mapped IPv6 address is decoded and evaluated using the IPv4 policy.
For example, `::ffff:127.0.0.1` is denied and `::ffff:8.8.8.8` is not denied by
this predicate.

Hostnames remain subject to the existing broker review and approval rules.
The addon adds an independent resolved-address check at the actual connection
boundary.

## Architecture

### TypeScript broker predicate

`denyReasonForTarget` remains the broker's early rejection point. Its IP
helpers will be replaced or extended so they parse IPv6 structurally instead
of inspecting only the first hextet. The implementation must correctly handle
compressed IPv6 and IPv4-mapped IPv6 forms without relying on Bun's current
`node:net.BlockList` implementation.

The broker continues to return `blocked-private-ip` for all denied numeric
addresses. Keeping the existing reason avoids a protocol and UI migration.

### Python connection-boundary predicate

`nas_addon.py` will define the same explicit policy using Python's
`ipaddress` module. The addon predicate is authoritative for the socket that
mitmproxy is about to open. It handles both direct IP targets and addresses
returned by DNS.

The policy tables remain local to each runtime because the broker and addon run
in different languages and processes. A shared table-driven test corpus will
cover every range boundary and representative IPv4-mapped forms so policy
drift is visible in both test suites.

### DNS resolution and pinning

`NasAddon.server_connect` will run immediately before mitmproxy opens an
upstream connection. For a hostname it will:

1. retain the original hostname and port;
2. resolve it with asynchronous `getaddrinfo` for TCP addresses;
3. normalize and deduplicate returned IPv4 and IPv6 addresses while preserving
   resolver order;
4. remove every address denied by the Python predicate;
5. fail the connection if resolution failed, timed out, returned no usable
   addresses, or left no allowed addresses;
6. preserve the original hostname as the upstream TLS SNI; and
7. replace `data.server.address` with the first allowed IP and original port.

Using an IP in `data.server.address` prevents mitmproxy from performing a
second DNS lookup. The HTTP request host and Host header are not changed, so
virtual hosting and broker credential matching continue to use the approved
hostname.

If a DNS answer contains both denied and allowed addresses, denied candidates
are discarded and the connection is pinned to the first allowed candidate.
This remains safe because mitmproxy never receives a hostname to resolve again,
while avoiding unnecessary outages for legitimate multi-address hosts.

Direct IP targets skip DNS but pass through the same Python predicate. A denied
direct target fails closed even if a broker regression allowed it.

No DNS cache is introduced. Each new upstream connection gets a fresh checked
answer, while connection reuse naturally retains the already pinned peer.

## Error Handling

Resolution has a finite timeout. DNS exceptions, timeout, malformed answers,
and empty results set `data.server.error` with a non-secret diagnostic message,
which instructs mitmproxy to abort connection establishment. Denied targets are
logged with the logical hostname and range classification, but raw credentials
and request bodies are never logged.

The connection check is fail-closed. There is no fallback from a pinned IP to
the original hostname because that would restore the DNS rebinding window.
There is also no fallback to a denied candidate when the selected allowed IP
is unavailable.

The existing broker authorization remains required. Successful DNS validation
does not imply that a target is approved.

## Data Flow

```text
container request
  -> mitmproxy request hook
  -> broker hostname/IP authorization
  -> allow decision
  -> mitmproxy server_connect hook
  -> resolve hostname once
  -> discard denied IP candidates
  -> pin first allowed IP and preserve hostname/SNI
  -> open upstream TCP connection
```

At no point is a new host TCP listener exposed to the container. Host service
access remains limited to the existing explicitly mounted Unix sockets, in
accordance with security constraint N1.

## Testing

### TypeScript unit tests

Extend the protocol tests with table-driven cases for:

- the first and last denied address in every IPv4 range;
- an address immediately outside each non-edge range;
- `::`, `::1`, ULA, and IPv6 link-local boundaries;
- compressed and expanded IPv6 spellings;
- denied and public IPv4-mapped IPv6 addresses; and
- representative public IPv4 and IPv6 addresses.

### Python unit tests

Extend the existing Bun wrapper around Python `unittest` to cover:

- the same shared policy cases as TypeScript;
- DNS result normalization and deduplication;
- mixed denied and allowed DNS results;
- all-denied results;
- resolver failure and timeout;
- direct denied IP targets;
- address pinning; and
- preservation of the original port and SNI.

The addon test will inject a fake asynchronous resolver so unit tests do not
depend on external DNS.

### Docker integration test

When Docker is available, run mitmproxy 11 with the real addon and a controlled
hostname mapped to a host-gateway/private address. Supply a minimal session
registry and fake broker that returns `allow`, then issue a proxied request.
The test passes only if the addon rejects the resolved private address before
the host listener receives a connection.

The integration test uses a random container name, random temporary directory,
and `finally` cleanup. It must not create, modify, or remove the production
`nas-proxy-shared` container.

## Verification

Run the focused TypeScript, Python, and Docker-backed tests first. Then run the
repository's formatting, linting, strict type check, and full unit test suite.
The Docker integration test may skip only when the test's normal Docker
availability guard reports that Docker is unavailable.

H5 and H6 are marked complete in `docs/todo/security.md` only after these
checks pass.
