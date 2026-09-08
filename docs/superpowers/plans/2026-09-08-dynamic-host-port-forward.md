# Dynamic Host Port Forward — Implementation Plan

Spec: `docs/superpowers/specs/2026-09-08-dynamic-host-port-forward-design.md`

Each task is a self-contained step with its tests; run `bun run test:unit`
after each, `bun run check` and `bun run test` once at the end.

## Task 1 — Protocol types

`src/network/port_bind_protocol.ts`

- Add `PortForward { containerPort; hostPort; createdAt }`.
- Add `HostProbeResult = "ok" | "no-answer"`.
- `PortBindSessionEntry` gains `forwards?: PortForward[]` (optional on read;
  writers always set it). Add `sessionForwards(entry)` helper returning
  `entry.forwards ?? []`.
- `ControlRequest` gains `{type:"forward"; containerPort; hostPort}` and
  `{type:"unforward"; containerPort}`.
- `ControlErrorKind` gains `container-port-taken` and `relay-unavailable`.
- `ControlResponse` gains `{ok:true; containerPort; hostPort; hostProbe}`.

## Task 2 — Relay script

`src/docker/embed/port-relay.mjs`

- Accept `forward <id> <port>` and `unforward <id> <port>` in `handle`.
- `forward`: if a listener for the port exists, answer `ok`. Otherwise
  `createServer({allowHalfOpen:true})`, listen on `127.0.0.1:<port>`; on
  listen error answer `fail <id> <code>`; on success answer `ok <id>` and
  record `{server, connections}`.
- Accept handler: `client.pause()`, connect to `socketPath`, write
  `client <port>\n`, `pipePair`, `client.resume()`. A failed UDS connect
  destroys the client.
- `unforward`: close the server, destroy its connections, answer `ok <id>`;
  unknown port also answers `ok` (idempotent).

## Task 3 — Relay gateway

`src/network/port_bind_relay.ts`

- `Pending.kind` gains `"forward" | "unforward"`; `ok` resolves them.
- Split `request()` into `ensure + send()`; `send()` is what replay uses.
- Keep `forwards: Map<containerPort, hostPort>`.
- `RelayGateway` gains `forward(containerPort, hostPort): Promise<void>`
  (ensures relay, sends `forward`, records on `ok`; throws
  `RelayNotReadyError` or the `fail` reason), `unforward(containerPort)`
  (removes from table first, then tells the relay if connected; a relay that
  is not connected has no listener to close), and `forwards()`.
- Server accept: handle `client <port>` — look up the table, destroy if
  absent, otherwise dial `127.0.0.1:<hostPort>` with `allowHalfOpen`, on
  connect `pipeSockets` and `resume()`, on error destroy.
- `adoptControl`: after the watch replay, `send("forward", port)` for each
  table entry; log failures.
- `drop` (relay lost): if the table is non-empty and not closed, schedule
  `opts.ensureRelay()` after `RE_ENSURE_DELAY_MS` (1 s); clear that timer in
  `close()`.

Tests in `port_bind_relay_test.ts`, extending `fakeRelay` to answer
`forward`/`unforward` with `ok` and to simulate a client connection, plus one
test driving the real `port-relay.mjs` with `Bun.spawn` (check how
`stage_test.ts` / relay integration tests already spawn it; if none do in
unit scope, drive it here with a tmpdir socket): listener opens, client-first
bytes arrive, unforward cuts, unknown `client` port is closed, replay on
reconnect.

## Task 4 — Broker

`src/network/port_bind_broker.ts`

- `persist` signature becomes `(state: {bindings; forwards}) => Promise<void>`.
- `parseControlRequest` accepts the two new shapes.
- `forward(req)`: reserved port → `container-port-taken`; existing entry with
  same host port → return it (re-probe); differing → `binding-conflict`;
  else `gateway.forward()`; map `RelayNotReadyError` → `relay-unavailable`,
  other errors → `container-port-taken` with the relay's reason; persist;
  on persist failure `gateway.unforward()` and rethrow. Host probe: dial
  `127.0.0.1:hostPort`, 1 s timeout.
- `unforward(containerPort)`: `no-such-binding` if absent; persist remaining;
  `gateway.unforward()`.
- `listForwards()`.
- `handleControl` dispatches the new types.
- `close()` leaves forwards to the relay (the container is going away).

Update `port_bind_service.ts` persist to write both arrays.

## Task 5 — Domain service

`src/domain/port_bind/types.ts`: `ContainerPortTakenError`,
`RelayUnavailableError`, `PortForwardKey = {sessionId; containerPort}`.

`src/domain/port_bind/service.ts`: `forward(paths, sessionId, containerPort,
hostPort)` → `{containerPort; hostPort; hostProbe}` with response validation;
`unforward(paths, key)`; `brokerError` maps the new kinds; `sendRequest`
rethrows the new error classes; fake and client gain both methods.

## Task 6 — Host listener scan

`src/network/host_listeners.ts` (new): `readHostListeners(procDir = "/proc")`
→ `ObservedListener[]` in LISTEN state with scope `any` or `loopback`
(port `127.x` or `0.0.0.0`, `::`, `::1`, `::ffff:127.x`), excluding the
ephemeral range. Same parsing as `port-relay.mjs`. Test with fixture files
written to a tmpdir.

## Task 7 — CLI

`src/cli/port_bind_args.ts`: `parseForwardArgs` (`<sid>:<cport> [hport]`),
`parseForwardSessionOnly`, `parseUnforwardArgs` (`<sid>:<cport>` or none).

`src/cli/network.ts`: `forward` / `unforward` subcommands mirroring `bind` /
`unbind`; the picker for `forward <sid>` uses `readHostListeners` minus ports
already forwarded to that session.

`src/cli/usage.ts`: help lines and examples.

## Task 8 — UI

- `with_error_handling.ts`: `ContainerPortTakenError` → 409,
  `RelayUnavailableError` → 503.
- `src/ui/data.ts`: `forwardPort`, `unforwardPort`.
- `src/ui/routes/api.ts`: `POST /network/forward`, `POST /network/unforward`.
- `src/ui/routes/sse_diff.ts`: include forwards in the change key; test.
- Frontend: `PortForwardLike`, `PortBindSessionLike.forwards?`;
  `api/client.ts` `forwardPort` / `unforwardPort`;
  `components/ports/PortForwardsPanel.tsx` ("Ports · out"); mount it in
  `PendingPane.tsx` under the bindings panel.

## Task 9 — Docs

- `docs-site/.../configuration/host-services.md`: a section on adding a
  forward to a running session, with the nas UI port warning.
- `docs-site/.../work/preview.md`: point at the new panel name if the page
  lists panels.
- `README.md` boundary table: a row for `nas network forward`.

## Task 10 — Verify

`bun run check`, `bun run test:unit`, `bun run build-ui`, `bun run test`.
