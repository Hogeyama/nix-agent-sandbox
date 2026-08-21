# Local Proxy CONNECT Teardown Design

## Problem

The container-local proxy forwards HTTPS `CONNECT` requests to mitmproxy. Its
upstream socket currently uses one error path for both the HTTP handshake and
the established byte tunnel. Bun 1.4 surfaces a peer reset behind unread data
as `ECONNRESET`, matching Node. Normal tunnel teardown can therefore print
`CONNECT upstream error` even though the downstream client has already
finished.

The same error path also writes an HTTP `502` response after a tunnel has been
established. Once the proxy has returned `200 Connection Established`, the
connection contains the client's TLS records, so injecting a plaintext HTTP
status line would corrupt that stream.

## Scope

Change only the local proxy's handling of upstream errors for HTTPS `CONNECT`
tunnels. HTTP forwarding, CONNECT authentication, forward-port relaying, Bun
version selection, and mitmproxy behavior remain unchanged.

## Behavior

The local proxy records whether the upstream CONNECT handshake has returned a
successful status.

- Before the tunnel is established, an upstream socket error remains a setup
  failure. The proxy logs `CONNECT upstream error`, returns `502 Bad Gateway`
  to the downstream client, and closes the connection.
- After the tunnel is established, an upstream socket error is ordinary tunnel
  termination from the local proxy's perspective. The proxy writes no log and
  no protocol bytes; it destroys the downstream socket and lets the client
  report any operation-level failure.
- A non-200 CONNECT response keeps the existing `Connection Failed` response
  path.

This intentionally makes every post-establishment upstream error silent, not
only `ECONNRESET`. The client already observes the tunnel closing, while the
local proxy cannot safely translate a byte-stream failure into an HTTP status
after the handshake.

## Testing

Add a regression test with a mock upstream proxy that accepts CONNECT and then
resets after the downstream client finishes. It must observe no local-proxy
stderr and no bytes after the successful CONNECT response.

Run the regression under Bun 1.4 from the built `nas-sandbox` image for the
red/green check because Bun 1.3 may surface the same TCP teardown as a clean
close. Existing tests continue to prove that an upstream failure before the
CONNECT handshake returns `502`.

## Why — なぜこのアプローチを選んだか

The CONNECT handshake is the protocol boundary that determines what the proxy
can safely send. Tracking that boundary directly makes error handling correct
for every socket error and avoids depending on runtime-specific event ordering
or on whether a particular reset is considered benign. It also keeps the user
terminal quiet: after establishment, the requesting program is the component
that can describe any actual operation failure with useful context.

## Why Not — なぜ他の案を選ばなかったか

- **Suppress only teardown after the downstream client ends** — This retains a
  second local-proxy error beside the client's own error for active failures,
  without adding useful target or operation context.
- **Suppress only `ECONNRESET`** — Other upstream errors are equally impossible
  to translate into HTTP after the CONNECT handshake, and error-code-specific
  handling would tie behavior to runtime details.
- **Pin or downgrade Bun as the fix** — That hides the newly surfaced event but
  leaves the phase-confused error handler and possible plaintext corruption in
  place. Runtime pinning is a separate reproducibility concern.
- **Keep writing `502` after establishment** — An HTTP response is valid only
  during the CONNECT handshake; afterward it becomes invalid plaintext inside
  the TLS stream.
