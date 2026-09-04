# Container Port Bind

**Status:** Draft

**Date:** 2026-09-04

## Purpose

An agent working inside the sandbox often starts an HTTP server — a dev server,
a preview build, a scratch API. The server listens on `127.0.0.1:<port>` inside
the container's network namespace, which is not the host's loopback, so nothing
on the host can reach it. Today the only workaround is to make the agent bind
`0.0.0.0` and reconfigure the session, which is the posture
`docs/adr/2026042802-forward-port-uds-relay.md` deliberately refused for the
opposite direction.

This design lets the user open such a port from the host on demand, for a
running session, without restarting it and without widening any bind address.

## Scope

Covered: a host-side TCP listener on `127.0.0.1`, a Unix-domain-socket path into
the agent container, a relay process started inside the container on first use,
`nas network bind` / `unbind` / list, and the matching nas UI endpoints.

Excluded:

- exposure beyond `127.0.0.1` (a phone on the LAN reaching the dev server);
- discovering which ports are listening inside the container — the user supplies
  the number;
- declaring ports in the profile so they open at launch;
- any change to `forwardPorts`, which covers the opposite direction.

## User-facing behavior

```
nas network bind <session-id>:<container-port> [<host-port>]
nas network unbind [<session-id>:<container-port> | <host-port>]
nas network bind                  # no positional arguments: list open bindings
```

`bind` prints the URL it opened and exits. The listener belongs to the session's
own host-side `nas` process, so closing the terminal leaves it open and ending
the session closes it.

Host port selection:

- `<host-port>` omitted: try the container port number first. If that fails for
  any reason — taken, or below 1024 where a non-root `nas` cannot bind — walk
  upward from `max(container-port + 1, 1024)` for at most 64 candidates, then
  fail. Report the port actually opened.
- `<host-port>` given and free: use it.
- `<host-port>` given and unavailable: fail. An explicitly requested number is
  not silently substituted.

Re-binding a `<session-id>:<container-port>` that is already bound returns the
existing host port instead of failing, so running the command twice is
harmless. The exception is an explicit `<host-port>` that differs from the open
one: that fails and asks the user to `unbind` first, because it is a request the
command cannot satisfy while the old listener stands.

`unbind` accepts either key. With no argument it offers an fzf picker over the
open bindings, matching how `nas network review` behaves; without fzf on PATH it
prints the list and asks for an argument.

At bind time the host asks the relay to probe the container port once. The
result is one of `ok`, `no-answer`, `container-not-running`, or
`relay-unreachable`, and the binding is created in every case — binding before
starting the dev server is a normal thing to want. The output states which.

A session started before this feature existed is a different matter: it has no
entry in the ports runtime root, so `bind` cannot reach it at all. That prints a
message naming the session as unreachable and asking for a restart, rather than
a probe result.

The list output is one line per binding — session id, container port, host port,
age — and `--format json` emits the same fields as an array, following
`hasFormatJson` in `src/cli/helpers.ts`.

## Verified behavior

The design depends on two properties of bind-mounted sockets that were measured
on the development host (Docker 29.6.1, Debian kernel 6.1) rather than assumed.

| Property | Result |
|---|---|
| Connecting to a host UDS through a **read-only** bind mount, from a non-root uid, socket mode 0666 | Succeeds |
| Replacing the mounted socket file from inside the container, as the agent's uid | `EACCES` |
| Replacing it as container root (`rm`, then `ln -s`) | `EBUSY` |

The first result is not obvious: `connect(2)` on a Unix socket requires write
permission on the inode, and a read-only superblock normally refuses
`MAY_WRITE`. The kernel's `sb_permission()` applies that refusal only to
regular files, directories and symlinks, so sockets, FIFOs and device nodes stay
connectable on a read-only mount. The second and third hold because a bind
mount's mount point cannot be unlinked while it is mounted, whatever the
credentials.

Together they mean the container can use the socket and cannot substitute it.

## Design

### The host owns the socket; the container connects outward

`forwardPorts` puts the host on the listening side and has the container dial in
(`src/network/forward_port_relay.ts`). This design keeps that direction even
though the traffic now flows the other way.

```
host browser
  → 127.0.0.1:<host-port>                      held by the session's nas process
  → <ports runtime>/brokers/<sid>/relay.sock   host listener, mounted read-only
  → relay process inside the agent container
  → 127.0.0.1:<container-port>                 inside the container's netns
```

The alternative — the container creating the socket, the host connecting — reads
simpler but hands the container a writable directory on the host, and a socket
file it can unlink and replace with a symlink to another host socket. The host
relay would then pipe into whatever that symlink names, and the bytes it pipes
come from a page the agent itself authored. No permission dance closes that:
`NAS_UID` is the host user's own uid (`src/stages/mount/stage.ts:199`,
`src/docker/embed/entrypoint.sh:227`), so the container process owns the
directory as much as the host process does and can restore any mode the host
sets. Owning the socket on the host removes the whole class instead of
mitigating it.

### Relay wire protocol

One control connection plus one connection per stream, all initiated by the
relay, all speaking newline-terminated ASCII lines. A line is capped at 128
bytes; anything longer, or any unparsable line, closes that connection.

The relay's first connection sends `control`. A second `control` connection is
refused while one is live — the relay is a singleton per session.

| Direction | Line | Meaning |
|---|---|---|
| host → relay | `open <id> <port>` | dial `127.0.0.1:<port>`, then come back as a stream |
| host → relay | `probe <id> <port>` | dial, close immediately, answer only |
| relay → host | `ok <id>` | the probe's dial succeeded |
| relay → host | `fail <id> <reason>` | the dial failed |
| relay → host | `log <text>` | diagnostic, host-side debug log only |
| relay → host (new connection) | `stream <id>` | this connection carries the paired traffic |

`<id>` is 16 random hex characters, single-use, and only ids currently
outstanding are accepted.

**Order on the relay side.** For `open`, the relay dials the dev server *first*
and leaves that TCP socket paused. Only on a successful dial does it open a new
UDS connection, write `stream <id>\n`, and start piping. A failed dial produces
`fail <id> <reason>` on the control connection and no stream connection at all.
This ordering is what makes `fail` possible, and it keeps the relay from
buffering server bytes it cannot yet forward.

**Framing on the host side.** The host must still split the first line and
unshift the remainder. The relay writes `stream <id>\n` and immediately pipes,
so a server that speaks first — or simply a scheduling accident — delivers the
line and the first payload bytes in one read. This is the same
buffer-and-unshift obligation `src/docker/embed/local-proxy.mjs:155` carries,
now on the host side.

**Pairing.** The host holds the browser's socket without reading from it until
the paired `stream <id>` arrives. Node stops reading once the internal buffer
fills and the TCP window closes; nothing is lost, and the browser has no timeout
on an established connection. The waiting socket gets an `error` listener at
accept time — an unhandled `error` would take down the process, the invariant
`src/network/forward_port_relay.ts:109` already protects. If the browser
disconnects while waiting, the id is retired; a `stream` connection arriving for
a retired id is closed as unknown, which tells the relay to drop its dev-server
socket.

The pairing timeout is 10 seconds, measured from when the `open` line is written
to the control connection — not from accept, so a relay that has to be started
first is not charged for its startup.

**Accepted denial of service.** Any process in the container can connect to the
socket and sit there, and enough such connections would exhaust the file
descriptors of the session's `nas` process, which also holds the hostexec and
network approval brokers. No limit is imposed. The agent can already deny itself
this feature by serving nothing, the cost falls on its own session, and a
connection cap would buy nothing that matters here. Confidentiality is a
separate question, answered by the id rules above.

**What an in-container attacker gains.** It can claim a `stream` id and receive
traffic destined for a port in its own container, which it could serve directly
anyway; guessing an id is the only lever and 64 bits of single-use randomness
closes it. It can win the race to be the `control` connection, in which case the
real relay is refused and exits — a denial of service against a feature the same
process could deny by simply not serving anything. `fail` and `log` text is
attacker-chosen, so non-printable characters are stripped before any of it
reaches a terminal, the UI, or a log.

### Teardown

Both the host listener and each stream socket are created with
`allowHalfOpen: true`, without which Node re-introduces the automatic end that
`src/network/forward_port_relay.ts:66` relies on. Half-close propagates with
`end()`. `destroy()` is reserved for three cases: an error, both directions
having finished, and a 30-second grace timer that starts when one direction ends
and the other has not. `destroy()` discards the write queue, and this path has
two hops rather than one, so destroying on a peer's close would truncate a large
response still draining toward the browser. Long-lived connections such as an
HMR WebSocket keep both directions open and are unaffected.

When the control connection closes, the relay is gone: outstanding streams die
with it.

### Relay lifecycle

The relay is started by `docker exec -d -u <NAS_UID>` on first use — the first
bind's probe, or the first browser connection — not at session launch. Session
launch adds two mounts and nothing else: no process, no port, no startup cost.
Readiness is the arrival of the `control` connection, not the exit of
`docker exec`, which returns immediately under `-d`.

Starting it at bind time alone would leave a hole: the control socket comes up
before the container does, so a bind issued during launch would find no
container to exec into. Deferring to first use closes that and matches the
requirement to bind before the server exists.

The exec runs `/usr/local/bin/bun /usr/local/lib/nas/port-relay.mjs` by absolute
path — `docker exec` does not go through the entrypoint, so `PATH` is the
image's — with the socket path in `NAS_PORT_RELAY_SOCKET`. When `host.uid` is
null (`src/stages/mount/stage.ts:198`) the agent runs as root and the relay is
exec'd without `-u`, matching it.

Restart rules, stated as a state machine because the agent can kill the relay:

- Only two things count as a failure: `docker exec` itself erroring, and no
  `control` connection arriving within 5 seconds of a successful exec. A relay
  that connected and later died did not fail; the next request re-execs it.
  Under `-d` the CLI exits as soon as Docker accepts the exec, so a missing
  script or a `bun` that dies on startup is indistinguishable from any other
  silence: it arrives as the second case, not as its own state.
- Consecutive failures are rate-limited to one exec attempt per 2 seconds, and
  after 3 the supervisor stops trying for 60 seconds, then tries again. Giving
  up is never permanent: a session that starts a browser connection before its
  container is up must not be poisoned for the rest of its life.
- A successful `control` connection resets the counter.
- `docker exec` failing because the container is not running is reported as
  `container-not-running` and does not count — it is an expected state, not a
  fault, and stderr says so plainly enough to recognize.
- Concurrent demand shares one in-flight exec rather than starting several.

`src/docker/client.ts:462` has no detached form of `docker exec`, so
`DockerService.exec` (`src/services/docker.ts:135`) gains a detached variant
along with its Fake.

### Control socket protocol

The CLI and the UI reach the session over `brokers/<sid>/sock` — the path
`brokerSocketPath` already produces — with one request and one response per
connection, as JSON lines read through
`readJsonLine(maxBytes)` (`src/lib/unix_socket.ts:34`), following
`src/network/broker.ts`.

```
→ {"type":"bind","containerPort":3000,"hostPort":null}
← {"ok":true,"hostPort":3000,"probe":"no-answer"}

→ {"type":"unbind","containerPort":3000}
→ {"type":"unbind","hostPort":3000}
← {"ok":true}

← {"ok":false,"error":"host-port-taken","message":"..."}
```

Error kinds are `host-port-taken`, `binding-conflict` (an explicit host port
that differs from the open one), `no-such-binding`, `invalid-request`, and
`internal` for anything the broker did not anticipate. Each becomes an `Error`
subclass in `src/domain/port_bind/types.ts`, alongside the
`SessionUnreachableError` the client itself raises when a session has no
registry entry or its control socket refuses. `mapErrorToResponse`
(`src/ui/routes/with_error_handling.ts`) turns the first two into 409,
`no-such-binding` into 404, `invalid-request` into 400, `internal` into 500 and
`SessionUnreachableError` into 503 — the pattern `references/domain-service.md`
documents for typed errors crossing the plain-async boundary.

`hostPort` accepts `null` to walk the candidates and `0` to ask the kernel for
any free port. The second exists so tests and the UI can open a binding without
picking a number that might already be in use.

Listing does not use this socket. It reads the registry, so it works while the
session process is busy and needs no round trip.

### Runtime layout

A runtime root of its own, built on `BaseRuntimePaths` from
`src/lib/runtime_registry.ts` so that `gcRuntime`, `atomicWriteJson` and the
`--runtime-dir` convention carry over unchanged:

```
<runtimeDir("ports")>/
├── sessions/<sid>.json          pid, control socket path, open bindings
├── brokers/<sid>/sock           host-only control socket; mounted nowhere
├── brokers/<sid>/relay.sock     mounted read-only into the agent container
└── relay/port-relay.mjs         relay script, mounted read-only
```

`sessions/<sid>.json` extends `BaseSessionEntry`, whose `brokerSocket` field
holds the control socket path — `gcRuntime` uses that path's existence in its
liveness test (`src/lib/runtime_registry.ts:212`) — plus a `bindings` array of
`{containerPort, hostPort, createdAt}`. The session process is the only writer;
the CLI and the UI only read it.

Only `relay.sock` and `port-relay.mjs` are mounted, as individual files, never
their parent directory. `src/stages/proxy/proxy_service.ts:134` mounts the whole
network runtime directory into the mitmproxy container read-write; the same
shape here would hand the container the control socket and every other session's
state.

Two invariants follow from mounting files rather than directories. A file bind
mount pins an inode, so the host listener is created once per session and never
re-created — unlinking and re-listening would leave the container connecting to
a dead inode. And `port-relay.mjs` is refreshed by atomic rename, never written
in place, the way `copyAddonScript` handles the mitmproxy addon
(`src/stages/proxy/network_runtime_service.ts:91`).

### The relay script is mounted, not baked into the image

`src/docker/embed/Dockerfile:27` copies `local-proxy.mjs` into the image.
Shipping the relay the same way would require `nas rebuild` before the feature
works and would leave every already-built image unable to bind. Writing the
script into the runtime directory and mounting it read-only keeps the executed
bytes under host control and needs no rebuild. The image supplies `bun`, which
the script runs under.

Because `docker exec -d` discards stdout and stderr, and the container runs with
`--log-driver=none` (`src/stages/launch/stage.ts:90`), the relay is otherwise a
black box; the `log` control line is its only channel, and it lands in the
host's debug log.

### Placement

| Piece | Location | Tier |
|---|---|---|
| Control server, host listeners, registry writes | `src/network/port_bind_broker.ts` | Effect-free, like `src/network/broker.ts` |
| Socket and stream plumbing | `src/network/port_bind_relay.ts` | Effect-free |
| Relay restart state machine | `src/network/port_bind_supervisor.ts` | Effect-free |
| Registry reads and writes | `src/network/port_bind_registry.ts` | primitive over `runtime_registry.ts` |
| Session-scoped lifecycle | `src/stages/port_bind/port_bind_service.ts` | L3-a |
| Mount planning | `src/stages/port_bind/stage.ts`, pure | — |
| CLI + UI shared service | `src/domain/port_bind/service.ts` | L2 |
| Container-side relay | `src/docker/embed/port-relay.mjs` | — |

The stage is separate from the proxy stage on responsibility grounds: viewing a
port has nothing to do with the network proxy, and folding it in would make an
always-on control socket a side effect of proxy setup. (An earlier draft claimed
the proxy stage short-circuits when the proxy is disabled. It does not —
`planProxy` has no such path.)

It goes between `createDindStage` and `createLaunchStage` in `src/cli.ts:466`,
with the shape `src/stages/hostexec/stage.ts:526` uses: `needs: ["container"]`,
returning a `container` patch. The launch stage expands `plan.mounts` into
`-v src:dst:ro` and runs `docker run` inside its own `run()`
(`src/stages/launch/stage.ts:93`), so a stage that creates the socket and the
script before returning its mount patch guarantees both files exist at
`docker run` time — otherwise Docker would create directories in their place.
The proxy stage does the same thing for forward-port sockets
(`src/stages/proxy/stage.ts:451`). This does not belong in the mount stage,
which handles host-environment mounts.

`run()` calls the pure planner and the service and nothing else; directory
creation, socket creation and `docker exec` live in the service, with the relay
process spawn behind an injected seam of the shape
`src/network/forward_port_relay.ts:232` uses. Listeners and the control socket
are held with `Effect.acquireRelease` so they close with the session, in the
manner of `src/stages/proxy/session_broker_service.ts`. The new service joins
`StageServices` in `src/pipeline/types.ts` and the `Layer.mergeAll` in
`src/cli.ts`.

The L2 service follows `.claude/skills/effect-separation/references/domain-service.md`:
Tag `"nas/PortBindService"`, error channel `Error`, pure types in `types.ts`,
`makePortBindClient()` constructed inside `runNetworkCommand()` for the CLI and
at module level for the UI. Neither the CLI nor a UI route touches `node:fs` or
a socket directly.

### Resolving `unbind <host-port>`

A host port names no session by itself, so the L2 service runs `gcRuntime` over
the ports root, scans `sessions/*.json`, and finds the entry whose `bindings`
contain that host port. Running the GC first is what keeps a session killed with
SIGKILL from claiming a port a live session has since taken; `getSessions` in
`src/ui/data.ts:301` sweeps before reading for the same reason.

If two live entries claim one host port the service reports the ambiguity rather
than guessing — it means a registry write was lost, not a legitimate state. If
the entry exists but its control socket refuses a connection, the message says
so and points at `nas network gc`.

### UI

`POST /api/network/bind` and `POST /api/network/unbind` in
`src/ui/routes/api.ts`, calling `src/ui/data.ts` wrappers over the same L2
client, exactly as `approveNetwork` does today. Both validate the session id
with `isSafeId` and the ports as 1–65535 before calling.

Showing the open bindings is not a one-line change. `UiDataContext`
(`src/ui/data.ts:149`) gains `portsPaths`; `SessionsData` (`:288`) gains a
bindings field; `src/ui/routes/sse.ts:66` polls it alongside the five existing
snapshots and `sse_diff.ts` learns to diff it; the frontend's store types
(`src/ui/frontend/src/stores/types.ts`) and `createSseDispatch.ts` carry it
through to a panel with bind and unbind controls.

### Cleanup

The registry entry carries the pid and the control socket path, which is what
`gcRuntime` needs to drop a session killed with SIGKILL. Nothing survives a
crash except files in the ports runtime root: the container itself is `--rm`, so
the relay dies with it. `nas network gc` sweeps the root.

## Security

The container gains one new thing: a socket that lets it reach the host process
that is already relaying its own ports. It cannot create, replace or remove that
socket (measured above), cannot enumerate other sessions through it, and cannot
ask it to open a host listener — binds are host-initiated only, over a control
socket that is mounted nowhere. This preserves N1 in
`.claude/skills/security-constraints/SKILL.md`: the container still talks to the
host only through an explicitly mounted Unix socket, and C2's separation of a
host-only control channel from a container-facing data channel is mirrored here.
A hostile in-container process can exhaust the file descriptors of the process
that also serves hostexec and network approvals. That denial of service is
accepted: it costs the attacker its own session and yields it nothing.

The genuine new exposure is the browser. Opening a binding means loading a page
the agent wrote, in the user's browser, on `127.0.0.1`. That page can then issue
requests to other services on the user's loopback — other dev servers, other
bindings, nas UI. nas UI is guarded by the Origin/Host check in
`src/ui/security.ts`, applied in `src/ui/server.ts:290`; arbitrary local
services are not. `docs/todo/security.md:53` accepts host processes under the
same uid as inside the trust boundary, but the browser is a different path into
them, so the README table of what each setting widens gains a row for bindings.

## Files affected

| File | Change |
|---|---|
| `src/network/port_bind_broker.ts` | new: control server, listener registry, registry writes |
| `src/network/port_bind_supervisor.ts` | new: relay restart state machine |
| `src/network/port_bind_relay.ts` | new: UDS listener, pairing, framing, teardown |
| `src/network/port_bind_registry.ts` | new: typed reads and writes over `runtime_registry.ts` |
| `src/stages/port_bind/stage.ts` | new: pure planner, mount patch |
| `src/stages/port_bind/port_bind_service.ts` | new: L3-a lifecycle with `acquireRelease` |
| `src/stages/port_bind.ts` | new: barrel |
| `src/domain/port_bind/service.ts`, `types.ts` | new: L2 service, typed errors, plain-async client |
| `src/domain/port_bind.ts` | new: barrel |
| `src/docker/embed/port-relay.mjs` | new: container-side relay |
| `src/services/docker.ts`, `src/docker/client.ts` | detached `docker exec` plus Fake; unlike `exec` it returns `{code, stderr}` rather than throwing, because the caller classifies the failure |
| `flake.nix` | copy `port-relay.mjs` into the packaged asset directory |
| `src/pipeline/types.ts`, `src/cli.ts` | stage registration, layer, insertion at `:466` |
| `src/cli/network.ts`, `src/cli/port_bind_args.ts`, `src/cli/usage.ts` | `bind` / `unbind` dispatch, parser and help |
| `src/fzf_review.ts` | single-select picker for `unbind` |
| `src/ui/data.ts`, `src/ui/routes/api.ts`, `src/ui/routes/sse.ts`, `src/ui/routes/sse_diff.ts` | endpoints, context, snapshot |
| `src/ui/routes/with_error_handling.ts` | new error kinds |
| `src/ui/frontend/src/stores/types.ts`, `createSseDispatch.ts`, panel component | bindings display and controls |
| `README.md` | boundary table row for bindings |

## Testing

Per `.claude/skills/test-policy/SKILL.md`:

- `*_test.ts`, no Docker: port-key parsing; host port candidate selection
  including the sub-1024 case and the 64-candidate bound; registry read/write;
  the control socket's request/response shapes and error kinds; the relay wire
  protocol end to end over a tmpdir socket, driving the real
  `port-relay.mjs` with `Bun.spawn` against a loopback server, covering the
  split-read unshift, a failed dial, and id retirement on browser disconnect;
  every branch of the
  restart state machine through the spawn seam — exec error, no control
  connection, later death, counter reset, the 60-second cool-off, and shared
  in-flight exec.
- `*integration_test.ts`, Docker, `skipIf` on availability, cleanup in
  `finally`: the relay under `docker exec` in a real container, and one
  end-to-end pass from a host TCP connection to a server listening on
  `127.0.0.1` inside the container.

Iterate with `bun run test:unit`; run `bun run test` once at the end.

## Rejected alternatives

- **Reserve ports with `docker run -p 127.0.0.1:H:C` at launch.** Docker
  publishes to the container's eth0 address, so a server bound to `127.0.0.1`
  inside the container — vite's and next's default — is unreachable. The port
  set is fixed at launch, and under
  `docs/superpowers/specs/2026-09-04-dind-netns-sharing-design.md` a container
  joining another's namespace cannot publish at all.
- **`docker exec -i` per TCP connection.** No container-side changes and it
  works on sessions started before the feature exists, but a dev server opens
  many parallel connections and holds a WebSocket open; a process per connection
  is the wrong shape for that traffic.
- **Let the container create the socket, and freeze the directory afterwards.**
  The container process shares the host user's uid, so it owns the directory and
  can undo any mode the host sets. `chmod(2)` checks ownership, not the
  directory's mode.
- **Carry bind requests on the network approval broker socket.** That socket
  sits inside the runtime directory mounted read-write into the mitmproxy
  container, which would let that container open host listeners.
- **Reuse the hostexec runtime root**, which already separates a host-only
  control channel from a mounted leaf. The shape is right and is copied here,
  but port binding is not a hostexec concern.
- **Invent a fresh directory shape (`control/`, `registry/`, `relay/`).** The
  layout in `src/lib/runtime_registry.ts` already answers the same questions and
  brings GC and the `--runtime-dir` convention with it.
- **Report a failed dial to the browser as an HTTP 502.** The host pipes bytes
  and does not know the protocol. A failed `open` closes the browser socket, and
  `fail` earns its place by feeding the bind-time probe and the log, not by
  producing a nicer browser error.
- **Serve the binding list from the control socket.** The registry file is
  already the record, and reading it keeps listing working while the session
  process is occupied.
