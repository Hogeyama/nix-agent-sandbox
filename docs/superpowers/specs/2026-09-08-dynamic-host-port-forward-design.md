# Dynamic Host Port Forward

**Status:** Draft

**Date:** 2026-09-08

## Purpose

`nas network bind` opens a container port on the host's loopback while a
session is running. The opposite direction — a host service such as a database
or a mock API reachable from inside the container at `localhost:<port>` —
exists only as `network.proxy.forwardPorts`, a profile setting that is fixed
when the session launches (`docs/adr/2026042802-forward-port-uds-relay.md`).
Adding a port means editing the profile, re-trusting it, and restarting the
session.

This design lets the user add and remove such a forward on a running session,
from the CLI and from the UI, the way `bind` already works for the other
direction.

## Scope

Covered: a container-side TCP listener on `127.0.0.1:<container-port>` started
on demand by the relay that `bind` already ships, a host-side dial to
`127.0.0.1:<host-port>` per accepted connection, `nas network forward` /
`unforward` / list, and the matching nas UI panel.

Excluded:

- any change to `network.proxy.forwardPorts`. The profile keeps its launch-time
  forwards and its own transport (per-port sockets under `/run/nas-fp`,
  served by `local-proxy.mjs`). Folding the two into one mechanism is a
  possible follow-up, not part of this work;
- a forward that outlives the session or is remembered for the next one;
- listening on anything other than `127.0.0.1` inside the container. This
  matches `local-proxy.mjs`, which serves the profile's forwards on
  `127.0.0.1` only;
- exposure of anything other than the host's own loopback.

## User-facing behavior

```
nas network forward <session-id>:<container-port> [<host-port>]
nas network forward <session-id>          # pick from what the host is listening on
nas network forward                       # no arguments: list open forwards
nas network unforward [<session-id>:<container-port>]
```

The `<session-id>:<port>` key names a port *inside that session's container*,
exactly as it does for `bind` and `unbind`. `<host-port>` defaults to the same
number, so `nas network forward <sid>:5432` makes the host's `127.0.0.1:5432`
reachable at `localhost:5432` inside the container.

`forward` succeeds only once the listener inside the container is up. A
container that is not running, or a relay that cannot be started, is an error,
not a forward that will appear later: a forward whose container port is not
listening would be indistinguishable from no forward at all. This differs from
`bind`, which creates its host listener regardless and reports a probe, because
there the host listener is the useful half and it exists either way.

On success the command prints the mapping and whether the host side answered a
single dial at that moment. A host service that is not running yet is reported
(`no-answer`) but the forward is kept — starting the database after the forward
is a normal order of events.

Repeating a `forward` for a `<session-id>:<container-port>` that is already
forwarded returns the existing mapping. An explicit `<host-port>` that differs
from the open one fails and asks for `unforward` first, mirroring `bind`.

`unforward` closes the container listener and every connection it carried. With
no argument it offers an fzf picker over the open forwards, or prints them and
asks for an argument when fzf is not installed. Unlike `unbind`, a bare host
port is not accepted as a key: several sessions may forward the same host port,
so the number alone names nothing.

`forward <session-id>` with no port scans the host's own `/proc/net/tcp{,6}`
for listeners bound to loopback or to all addresses, drops the kernel's
ephemeral range and ports already forwarded to that session, and offers the
rest in fzf. This reuses the reading of `/proc/net/tcp` that
`port-relay.mjs` already performs inside the container, ported to TypeScript
for the host.

The list output is one line per forward — session id, container port, host
port, age — and `--format json` emits the same fields as an array.

## Design

### Reuse the bind relay; add a direction, not a transport

`bind` already installs everything a dynamic forward needs: a host-owned Unix
socket bind-mounted read-only into the container (`/run/nas-ports/relay.sock`),
a relay process inside the container that holds a control connection to it,
and a supervisor that starts the relay on demand and restarts it when it dies
(`docs/superpowers/specs/2026-09-04-container-port-bind-design.md`). The only
thing missing is a listener on the container side and a dial on the host side:

```
agent process
  → 127.0.0.1:<container-port>          listener held by port-relay.mjs
  → /run/nas-ports/relay.sock           the socket bind already mounts
  → host relay gateway                  checks the port is a registered forward
  → 127.0.0.1:<host-port>               host loopback
```

No new mount, no new socket, no new process. A session started after `bind`
shipped supports forwards as soon as its host process runs this code; a
session started before it has no `relay.sock` and reports itself unreachable,
the same message `bind` prints for such sessions.

The profile's `forwardPorts` mechanism is deliberately left alone. It works
without the relay being started, from the first instant of the container's
life, over a mount that exists only for ports the profile declared. Replacing
it would move launch-time forwards onto a relay that is started lazily by
`docker exec`, for no gain in this work.

### Relay wire protocol additions

The control connection keeps its line format: newline-terminated ASCII, at
most 128 bytes, 16-hex-digit single-use ids. The new lines are:

| Direction | Line | Meaning |
|---|---|---|
| host → relay | `forward <id> <port>` | listen on `127.0.0.1:<port>` inside the container |
| host → relay | `unforward <id> <port>` | close that listener and its connections |
| relay → host | `ok <id>` / `fail <id> <reason>` | the existing answers, now also for these two |
| relay → host (new connection) | `client <port>` | a connection accepted on `<port>`; the rest of this connection is its bytes |

**Order on the relay side.** On accept, the relay pauses the client socket,
opens a new connection to `relay.sock`, writes `client <port>\n`, then pipes.
Pausing matters because many protocols speak client-first — a PostgreSQL
startup packet arrives immediately — and nothing may be read from the client
before the host has a place to put it.

**On the host side**, the gateway reads the first line with the same
`readFirstLine` that handles `stream <id>`, looks the port up in its table of
open forwards, and destroys the connection if the port is not there. Otherwise
it dials `127.0.0.1:<host-port>` with `allowHalfOpen`, and on connect pipes the
two with `pipeSockets`, which carries the same half-close and 30-second grace
rules the other direction uses. A failed dial destroys the client connection;
inside the container this surfaces as the connection being reset, which is
what a refused host port looks like through the profile's forwards too.

**Why the host-side table is the boundary.** Any process in the container can
connect to `relay.sock` and write `client 5432`. That is the same position the
profile's forwards put it in — any process can connect to `/run/nas-fp/5432.sock`
— and in both cases the host relays only to ports the user chose. There, the
choice is which sockets are mounted; here, it is which ports are in the table.
Nothing the container writes can add an entry: the table changes only through
the control socket, which is mounted nowhere. This keeps N1 in
`.claude/skills/security-constraints/SKILL.md`.

**Relay restart.** The relay's in-container listeners die with it. The gateway
keeps the set of open forwards and, whenever a new control connection is
adopted, re-sends `forward <id> <port>` for each — the same replay it already
does for the `watch` flag. A relay that died while forwards were open also
prompts the gateway to ask the supervisor for a new one after a short delay,
instead of waiting for the next `bind` request to do so. The supervisor's
existing rate limit (one exec per two seconds) bounds what an agent gains by
killing the relay in a loop, and the gateway skips the re-ensure once it is
closing, so session teardown does not exec into a stopping container.

### Control socket protocol additions

```
→ {"type":"forward","containerPort":5432,"hostPort":5432}
← {"ok":true,"containerPort":5432,"hostPort":5432,"hostProbe":"ok"}

→ {"type":"unforward","containerPort":5432}
← {"ok":true}
```

`hostProbe` is `ok` or `no-answer`: one dial of `127.0.0.1:<host-port>` from
the host process, capped at one second.

New error kinds: `container-port-taken` (the relay could not listen — the port
is in use inside the container, or below 1024 for a non-root relay — or the
port is one nas itself binds in the namespace: the local proxy, the DinD
daemon, a profile forward) and `relay-unavailable` (the container is not
running or the relay could not be started; the message says which).
`binding-conflict` covers a differing explicit host port, as it does for
`bind`. The domain layer gets `ContainerPortTakenError` (409) and
`RelayUnavailableError` (503).

### Registry

`sessions/<sid>.json` gains a `forwards` array of
`{containerPort, hostPort, createdAt}` beside `bindings`. Readers treat a
missing `forwards` as empty, so an entry written by an older session process
still parses. The broker persists both arrays together on every mutation.

The UI's `port-bindings` SSE event already ships whole session entries, so
forwards reach the frontend with no new event; `sse_diff.ts` includes forwards
in the change key so that adding or removing one emits.

### Placement

| Piece | Location |
|---|---|
| `forward`/`unforward`/`client` handling, listener table, replay, re-ensure | `src/network/port_bind_relay.ts` |
| in-container listeners | `src/docker/embed/port-relay.mjs` |
| `forward`/`unforward` control requests, reserved-port check, host probe | `src/network/port_bind_broker.ts` |
| protocol types, `PortForward`, error kinds | `src/network/port_bind_protocol.ts` |
| host listener scan for the picker | `src/network/host_listeners.ts` (new) |
| L2 service methods `forward`, `unforward`, errors | `src/domain/port_bind/service.ts`, `types.ts` |
| CLI dispatch, parser, help | `src/cli/network.ts`, `src/cli/port_bind_args.ts`, `src/cli/usage.ts` |
| UI endpoints and panel | `src/ui/routes/api.ts`, `src/ui/data.ts`, `src/ui/routes/sse_diff.ts`, `src/ui/frontend/src/{api/client.ts,stores/types.ts,components/ports/}` |
| error → status | `src/ui/routes/with_error_handling.ts` |

Everything sits in the files `bind` already owns; the relay script is mounted
from the runtime directory, so a running nas picks up the new relay on its
next session without an image rebuild.

### UI

A second panel, **Ports · out**, next to **Ports · in**: the open forwards for
the selected session, each with an Unforward button, and a form taking a host
port (container port defaults to the same number). It uses `POST
/api/network/forward` and `POST /api/network/unforward`, validated like the
bind endpoints. The host listener scan is CLI-only for now; the panel has no
suggestions list.

## Security

The container gains nothing it did not have with the profile's forwards: it
can reach exactly the host loopback ports the user named, and cannot add one.
What changes is who can name them and when. A profile forward requires editing
a trusted file; a dynamic forward is one command or one click on a running
session. The documentation therefore carries the same warning host-services.md
already gives — no HTTP rule or approval applies to forwarded traffic, an
unauthenticated database is fully the agent's — and adds the one case that
becomes easy to do by accident: forwarding the nas UI's own port hands the
agent the approval API. The picker does not filter it out, because the CLI
cannot know which port the UI is on; the documentation names it instead.

The host process now dials arbitrary loopback ports on behalf of the container,
but only ports the user chose, and only for the session that chose them. It
does not resolve names, so the SSRF concerns of the proxy path do not apply.

## Testing

Per `.claude/skills/test-policy/SKILL.md`, unit tests with no Docker:

- relay gateway, driving the real `port-relay.mjs` under `Bun.spawn` against a
  tmpdir socket: `forward` opens a listener and a client connection reaches a
  host-side echo server with client-first bytes intact; `unforward` closes the
  listener and cuts an open connection; a `client` line for an unregistered
  port is closed; a listener that fails (port in use) answers `fail`; forwards
  are replayed to a reconnecting relay;
- broker: `forward` persists both arrays, is idempotent, refuses a differing
  host port with `binding-conflict`, refuses reserved ports, reports a relay
  that is unavailable, and `unforward` of an unknown port is `no-such-binding`;
  control socket request-shape validation for the new types;
- host listener scan against fixture `/proc/net/tcp` files: loopback and any
  are offered, remote and ephemeral are not;
- CLI argument parsing for `forward`/`unforward`;
- domain service response validation, error mapping, and the fake;
- `sse_diff` emits on forward changes.

Iterate with `bun run test:unit`; run `bun run test` once at the end.

## Rejected alternatives

- **Mount a per-session directory for forward sockets and create
  `<port>.sock` files in it at runtime.** Keeps the profile forwards' per-port
  socket boundary, but adds a second mount, a second transport beside the
  relay, and still needs a control channel to make something inside the
  container listen on the new port. The host-side table gives the same
  boundary with what is already mounted.
- **`docker exec` a `socat` per forward.** Bypasses the relay, but is a
  process per port with no supervision, no teardown on unforward short of
  finding and killing it, and no path into the UI.
- **Move the profile's `forwardPorts` onto the relay too.** One mechanism
  instead of two, but launch-time forwards would depend on a relay that
  `docker exec` starts after the container is up, and every existing forward
  would change transport for a feature about something else.
- **Create the forward even when the container is not running, and apply it
  later.** Nothing inside the container would be listening, so the state would
  promise something it cannot show. `bind` can afford this because its host
  listener is real from the first moment.
- **Accept a bare host port as an `unforward` key.** Legal for `unbind`
  because one host listener belongs to one session; here two sessions can
  forward host 5432 at once.
