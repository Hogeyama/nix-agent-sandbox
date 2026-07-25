# Mask Filter Host Broker Design

Date: 2026-07-26
Status: Proposed

## Context

`mask.filter` masks secrets in command stdout/stderr so they never enter the
agent's context. Today MaskFilterStage writes the resolved secret frame to a
host file and bind-mounts it into the container at `/run/nas/mask-secrets`,
passing its path through `NAS_MASK_SECRETS_FILE`. The container-side
`nas-mask-filter` reads that file and masks locally.

This violates two invariants recorded in the `security-constraints` skill:

- **C1 — Do not mount secrets into the container.** The secret frame file must
  live in a host-only directory; only masked output and read-only binary tools
  belong in the container.
- **S1 — Secrets are resolved host-side only.** Resolved values must not be
  handed to the container as files or environment variables.

The frame is mode `0600`, but it is owned by the agent's own UID, so the
protection is vacuous against the threat model. `cat /run/nas/mask-secrets`
hands the agent a consolidated index of every secret in the session.

The other two mask surfaces already comply. MaskFsService spawns a host-side
daemon and passes the frame on **stdin**, never writing it to disk. The
mitmproxy surface receives `maskValues` from the host-side session broker and
runs in a separate container. `mask.filter` is the sole outlier.

Two recent changes make the fix tractable. `nas-mask-filter` now runs in
supervise mode as the parent of the shell, owning the output pipes end to end
(`2026-07-26` supervise change), and `MaskStream` was extracted as a reusable
streaming state machine. Both are reused here unchanged in substance.

## Goal

When `mask.filter` is enabled, no byte of any resolved secret exists anywhere
inside the container — not on a mounted filesystem, not in an environment
variable, not in the memory of any container-side process — while command
stdout/stderr continue to be masked **before** the agent reads them.

## Scope

Included:

- `nas-mask-filter`: new host-side `--serve` mode; supervise mode reworked into
  a relay.
- MaskFilterService / MaskFilterStage: daemon lifecycle, mounts, environment.
- The generated Bash wrapper in `entrypoint.sh`.
- Removal of the now-unreachable secret-file and standalone-filter code paths.

Excluded:

- `mask.maskfs` and `mask.proxy`. Both already satisfy C1/S1 and are untouched.
- hostexec output masking (C3). Unchanged.
- The masking algorithm itself (`src/zig/mask.zig`, `MaskStream`). Reused as is.
- Configuration schema. `MaskConfig` is unchanged.

## Design

### Topology

```
host                                        container
────────────────────────────────────        ──────────────────────────
MaskFilterStage
  └─ nas-mask-filter --serve <sock>         bash wrapper
       stdin ← secret frame                   └─ exec nas-mask-filter --supervise
       (acquireRelease, session-scoped)            └─ fork/exec bash.real
            │                                          │ stdout/stderr pipes
            │            UDS                           │
            └──────────────────────────────────────────┘
                 raw bytes  →
                 ←  masked bytes
```

### Secret delivery

The serve process reads the secret frame from **stdin at startup**, mirroring
`MaskFsService.startMaskFs`. The frame is never written to disk on either side.

This is strictly stronger than C1 requires. C1 asks for a host-only file; there
is no file at all, which also makes S2 (delete the frame at session end) vacuous
— there is nothing to delete.

`MaskFilterService.prepareMaskFilter` loses its `fs.writeFile` call and its
`secretsFramePath` input entirely.

### Container-visible surface

| | Current | After |
| --- | --- | --- |
| mounts | secret frame (ro), binary (ro) | **socket (rw)**, binary (ro) |
| env | `NAS_MASK_SECRETS_FILE`, `NAS_MASK_FILTER` | **`NAS_MASK_SOCKET`**, `NAS_MASK_FILTER` |

`MASK_SECRETS_CONTAINER_PATH` is replaced by `MASK_SOCKET_CONTAINER_PATH`
(`/run/nas/mask.sock`). On the host the socket lives at
`${runtimeDir}/sessions/${sessionId}/mask.sock`, following the MaskFs
session-directory layout.

The Bash wrapper keeps its current shape but **loses its runtime fallback**:

```sh
exec "$NAS_MASK_FILTER" --supervise --argv0 "$0" --socket "$NAS_MASK_SOCKET" -- \
  /tmp/nas-bash-override/bash.real "$@"
```

Today the wrapper checks that the secret file is readable and, if it is not,
execs Bash unmasked. Translating that check to "the socket exists" would keep a
**fail-open** path: if the serve process died, every shell would silently start
producing unmasked output — the exact disclosure this design exists to prevent.

The guard is therefore removed rather than translated. entrypoint installs the
wrapper only when masking is configured, so by construction a wrapper that runs
at all is a wrapper that must mask. If the socket is gone the supervisor fails
closed (below) instead of degrading to plaintext.

This is a deliberate behaviour change. The existing Docker test
"absolute /bin/bash preserves output when the secrets frame is missing" asserts
the old fail-open fallback and must be inverted to assert fail-closed.

### Protocol

One connection per stream: the supervisor opens two connections, one for the
child's stdout and one for its stderr. The server holds a separate `MaskStream`
per connection because overlap state is stream-specific.

The wire format is raw bytes in both directions — no framing. Masking preserves
length, but the server withholds the trailing `maxSecretLen - 1` bytes of each
chunk so a secret straddling a chunk boundary is still matched. **The reply is
therefore delayed and not byte-synchronous with the request**; the client must
never assume "wrote N, read N".

- EOF is signalled by `shutdown(SHUT_WR)`. The server then flushes its retained
  overlap and closes.
- The client reads until the server closes, writing whatever it receives to its
  own stdout/stderr.

**Deadlock avoidance is a hard requirement.** A client that writes without
concurrently reading will fill the socket buffer and stall both sides. The
supervisor's existing `poll(2)` loop is extended to cover socket readability and
writability alongside the child pipes.

The protocol is deliberately limited to "bytes in, masked bytes out". It exposes
no way to enumerate, count, or read secrets. The socket is mounted into the
container and is therefore reachable by the agent's UID; this is accepted,
because the only capability it grants is the masking oracle the agent already
has by running `echo <guess>` through its own shell. This mirrors the C2
two-socket split: only the least-privileged endpoint is exposed to the
container.

### Concurrency requirement

The serve process **must multiplex all connections in a single poll/epoll
loop**. Handling one connection to completion before accepting the next is
forbidden.

An agent routinely runs several shells at once, each holding two connections for
its entire lifetime — and a shell may stay open for minutes. Sequential handling
would let one long-lived shell block every other shell in the container. Combined
with fail-closed behaviour, that surfaces as the whole container silently
hanging, which is the worst available failure mode.

### Failure handling

Fail-closed throughout: no code path may emit unmasked bytes.

| Failure point | Behaviour |
| --- | --- |
| Session startup: serve fails to become ready | Stage fails, session aborts (matches MaskFsStage) |
| Initial connect, before fork | Small bounded retry, then exit without starting the child |
| Mid-stream disconnect | Fatal immediately, no retry: discard output, exit non-zero |

Mid-stream disconnect is deliberately not retried. A UDS does not lose or
reorder data in flight, so a mid-stream failure means the peer process died —
there is nothing to reconnect to. Worse, a fresh connection starts with empty
overlap state, so resuming could miss a secret straddling the seam. Failing is
both the safe and the honest outcome.

For the same reason the initial-connect retry is kept deliberately small. The
only genuinely transient case is a startup race, and that is addressed
structurally by waiting for readiness at session start (below) rather than by
elaborate reconnection logic.

Diagnostics are emitted to the real stderr as **constant strings only**, since
that path does not pass through masking and must be incapable of carrying a
secret. When output has been suppressed the supervisor exits `121`, a dedicated
code distinct from any the child can produce through normal exit-status
propagation, so a caller cannot mistake a lost-output run for a successful one
even if the child itself exited `0`.

Accepted blast radius: if the serve process dies, every subsequent command in
the container fails. Availability is traded for non-disclosure, consistent with
`resolveMaskSecrets` and the addon's `MASK-BLOCKED` behaviour.

### Readiness

MaskFilterStage waits for the serve process to be listening before the container
starts, mirroring `MaskFsService`'s mount-ready polling. This removes the startup
race structurally instead of papering over it with client retries.

### Drain semantics

The supervisor's existing child-exit drain applies unchanged: after the child
exits, remaining pipe data is drained with a short idle timeout so a background
process holding the pipe cannot hang the caller. Once the child pipes are done,
the supervisor half-closes each socket and reads the masked remainder to EOF
before exiting, so the server's retained overlap is never dropped.

### Removed surfaces

Because the frame arrives on stdin and the wrapper no longer names a file:

- `readSecretsFromFile` and all `NAS_MASK_SECRETS_FILE` handling.
- The standalone stdin→stdout filter mode, now unreachable from any caller.

Removing both eliminates the "read a secret file named by an environment
variable" code path entirely.

## Testing

Per `test-policy`: unit tests are `*_test.ts`, Docker-dependent tests are
`*_integration_test.ts`, both co-located with their source.

The central win is that **serve and supervise both run on the host**, so the
core of this design is testable without Docker.

- **Zig unit tests** — `MaskStream` unchanged. New coverage for serve argument
  parsing and per-connection state isolation.
- **`mask_filter_service_test.ts`** — asserts the produced mounts contain no
  secret frame and the produced env contains no `NAS_MASK_SECRETS_FILE`. This is
  the C1/S1 regression guard: a future reintroduction fails the suite.
- **`mask_filter_integration_test.ts`** (real UDS, no Docker) — masking of
  stdout and stderr, a secret straddling a chunk boundary, exit-code and signal
  propagation, output larger than the socket buffer (deadlock guard), several
  concurrent supervised shells not blocking each other (concurrency guard), and
  fail-closed behaviour when the server is stopped mid-run.
- **`launch/integration_test.ts`** (Docker) — wrapper wiring for the command,
  login, and script invocation forms, plus the inverted fallback test: with the
  socket absent, the shell must fail closed rather than emit unmasked output.

Known cost: the Python mask-filter fixture in `launch/integration_test.ts`
currently implements a stdin→stdout filter in about 30 lines. It must grow a
`--serve` socket server and a `--supervise` relay client. The rejected
alternative was to run the real Zig binary in the Docker tests; the fixture is
kept because it lets those tests run without a Zig build prerequisite, which is
the property it exists for.

## Why

Masking must happen before the agent reads the bytes, and the agent reads them
inside the container. That rules out masking at the host boundary after the
fact. The only way to satisfy that ordering *and* keep secrets out of the
container is to move the bytes to the host, mask them there, and move them back
— which is exactly what a host-side broker over a Unix socket does.

The approach also lands the codebase on one consistent pattern. maskfs already
runs a host-side Zig daemon fed by stdin; hostexec already exposes a
least-privileged Unix socket to the container while keeping the privileged
endpoint host-side. This design makes `mask.filter` the third instance of a
shape the project already relies on, rather than a fourth bespoke mechanism.

Reusing `nas-mask-filter` for the server side keeps the masking algorithm at one
implementation. The repository already carries three (`mask.zig`,
`mask_patterns.ts`, `nas_addon.py`) with an explicit "keep both implementations
in sync" comment; adding a fourth would be a durable maintenance cost.

Finally, the change deletes more attack surface than it adds: the secret file,
its environment variable, and the code that reads a path-specified secret file
all disappear.

## Why Not

- **Privilege separation (setuid `nas-mask-filter`, frame `root:root 0600`)** —
  Keeps the frame inside the container and satisfies C1's intent but not its
  stated rule. It is also blocked by the current layout in two places: the
  binary is bind-mounted `nosuid`, so the setuid bit would be silently ignored,
  and the frame's tmpfs is `uid=1000`, so entrypoint would have to materialise a
  root-owned copy and unmount the agent-visible one before dropping privileges.
  It introduces a setuid-root binary that parses attacker-controlled bytes, and
  it requires hardcoding the frame path, because a setuid binary that reads an
  env-specified file turns the masking oracle into an arbitrary-file-read
  oracle. More risk, weaker guarantee.

- **Hashed frame (length + rolling hash, no plaintext)** — Cheapest option and
  it removes the plaintext index, but the frame stays in the container and stays
  readable, so low-entropy values remain brute-forceable offline. The streaming
  filter must hash every window position at line rate, so a slow KDF is not
  available to mitigate this. It does not satisfy C1 either. Its usual objection
  — that hashes create a confirmation oracle — is not actually a differentiator,
  since the filter already is a perfect oracle for anything the agent can echo.

- **Extending the hostexec broker instead of a dedicated socket** — `mask.filter`
  can be enabled independently of `hostexec` (`hostexec` is optional in the
  profile), so this would either make hostexec a de facto prerequisite or
  require untangling the dependency. A dedicated session-scoped socket is
  cheaper and keeps the two features independent.

- **Passing pipe fds to the host with `SCM_RIGHTS`** — Removes the extra copy and
  would let the host run the existing masking loop directly on the child's
  pipes. Rejected because it splits lifetime control across the process
  boundary: drain completion, the background-process idle timeout, and exit-code
  propagation would move host-side while the child remains container-side. The
  byte-relay keeps all of that in the supervisor, which is a far smaller delta
  from the current implementation. UDS bandwidth is not a practical constraint
  here.
