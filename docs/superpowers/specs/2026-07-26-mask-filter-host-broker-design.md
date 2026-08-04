# Mask Filter Host Broker Design

Date: 2026-07-26
Status: Proposed

## Context

`mask.filter` masks secrets in command stdout/stderr so they never enter the
agent's context. Today MaskFilterStage writes the resolved secret frame to a
host file and **bind-mounts it into the container** at `/run/nas/mask-secrets`,
passing its path through `NAS_MASK_SECRETS_FILE`. The container-side
`nas-mask-filter` reads that file and masks locally.

The mount violates two invariants recorded in the `security-constraints` skill:

- **C1 — Do not mount secrets into the container.** The frame must live in a
  host-only directory; only masked output and read-only binary tools belong in
  the container.
- **S1 — Secrets are resolved host-side only.** Resolved values must not be
  handed to the container as files or environment variables.

The frame is mode `0600`, but it is owned by the agent's own UID, so the
protection is vacuous against the threat model. `cat /run/nas/mask-secrets`
hands the agent a consolidated index of every secret in the session.

Note what C1 does *not* forbid: a frame file in a host-only directory is
explicitly the prescribed arrangement. The defect is the mount and the
in-container environment variable, not the file's existence.

The other two mask surfaces already comply. MaskFsService spawns a host-side
daemon and passes the frame on stdin. The mitmproxy surface receives
`maskValues` from the host-side session broker and runs in a separate container.
`mask.filter` is the sole outlier.

A recent change makes the fix tractable: `nas-mask-filter` now runs in supervise
mode as the parent of the shell, owning the output pipes end to end, and
`MaskStream` was extracted as a reusable streaming state machine. Both are
reused here.

## Goal

When `mask.filter` is enabled:

1. No **durable, agent-readable** copy of the secret set exists inside the
   container — no mounted file, no environment variable, no argv.
2. Command stdout/stderr are masked **before** the agent's harness reads them.
3. hostexec's host-side masking (C3) keeps working.

### What this does not achieve

Stating this precisely, because an earlier draft of this spec overclaimed and
the claim is not defensible.

Plaintext necessarily transits the container: it is in the child process's own
memory, in the kernel pipe buffer, and in the supervisor's read buffer before it
is relayed to the host. More importantly, the supervisor holds the *original*
fd 1, and `/proc` is readable at the agent's own UID, so a process that is
deliberately exfiltrating can bypass masking entirely:

```sh
cat secret_file > /proc/$(supervisor_pid)/fd/1   # straight into the harness
cat secret_file > /dev/tty                       # straight to the operator
```

Both work today and are unchanged by this design. `mask.filter` is a
**leak-reduction control against secrets incidentally appearing in command
output**, not a containment boundary against deliberate exfiltration. An agent
that wants to leak a secret it can already read will succeed; the control exists
so that a secret the agent did *not* set out to leak does not silently land in
the transcript. This design removes the largest such accident — handing over the
whole secret index in a readable file — and does not claim more.

## Scope

Included:

- `nas-mask-filter`: new host-side `--serve` mode; supervise mode reworked into
  a relay.
- MaskFilterService / MaskFilterStage: daemon lifecycle, mounts, environment.
- The generated Bash wrapper in `entrypoint.sh`.
- Frame lifetime (S2), which is currently owned by the hostexec broker and
  therefore leaks when hostexec is disabled.

Excluded:

- `mask.maskfs` and `mask.proxy`. Both already satisfy C1/S1.
- The masking algorithm (`src/zig/mask.zig`, `MaskStream`). Reused as is.
- Configuration schema. `MaskConfig` is unchanged.
- **hostexec's own masking path is preserved unchanged**, which constrains the
  design — see below.

### Constraint: hostexec depends on the frame file and the filter mode

`src/hostexec/broker.ts:741` spawns `nas-mask-filter` in its standalone
stdin→stdout filter mode to mask host-executed command output (C3):

```ts
const filter = Bun.spawn([this.maskFilter.binaryPath], {
  stdin: stream, stdout: "pipe", stderr: "ignore",
  env: { NAS_MASK_SECRETS_FILE: this.maskFilter.secretsFramePath },
});
```

and `src/stages/hostexec/stage.ts:373` hardcodes the path MaskFilterStage writes
(`${runtimeDir}/${sessionId}/mask-secrets`).

Therefore this design **keeps** the host-side frame file, `readSecretsFromFile`,
and the standalone filter mode. Deleting them — as an earlier draft proposed —
would break C3 entirely: every hostexec command would spawn a filter that exits
non-zero on `openFile`, and `broker.ts:774` would turn that into a command
failure.

Only the **mount** and the **in-container environment variable** are removed.
That alone satisfies C1 and S1.

## Design

### Topology

```
host                                        container
────────────────────────────────────        ──────────────────────────
${runtimeDir}/${sessionId}/mask-secrets      (not mounted)
  │  (0600 in a 0700 dir, host-only)
  ├─ read by nas-mask-filter --serve
  └─ read by hostexec broker's filter (C3, unchanged)

MaskFilterStage
  └─ nas-mask-filter --serve <sock>          bash wrapper
       (acquireRelease, session-scoped)        └─ exec nas-mask-filter --supervise
            │                                       └─ fork/exec bash.real
            │            UDS                            │ stdout/stderr pipes
            └───────────────────────────────────────────┘
                 raw bytes  →
                 ←  masked bytes
```

### Container-visible surface

| | Current | After |
| --- | --- | --- |
| mounts | secret frame (ro), binary (ro) | **socket dir (ro)**, binary (ro) |
| env | `NAS_MASK_SECRETS_FILE`, `NAS_MASK_FILTER` | **`NAS_MASK_SOCKET`**, `NAS_MASK_FILTER` |

`MASK_SECRETS_CONTAINER_PATH` is removed and nothing replaces it: following
hostexec (`src/stages/hostexec/stage.ts:330`), the socket's directory is mounted
at **the same absolute path** inside the container, so no container-path constant
is needed. `NAS_MASK_SOCKET` carries the path.

The socket must live in a directory **of its own**, a sibling of the session
directory — `${runtimeDir}/${sessionId}-sock/mask.sock` against a frame at
`${runtimeDir}/${sessionId}/mask-secrets`. Putting the socket in the session
directory and mounting that directory hands the frame straight back to the
container, which is the defect this design exists to remove.

**Mount the containing directory, not the socket file**, mirroring hostexec
(`src/stages/hostexec/stage.ts:330`). `compileLaunchOpts` emits `-v src:dst`, and
Docker *creates a directory* when the source path does not exist — so mounting
the socket file directly makes container startup order load-bearing, and a race
would silently produce a directory at the socket path and fail every shell with
a confusing error.

**Mount it read-only.** `connect(2)` succeeds through a read-only bind mount —
measured, see "Socket substitution" under Accepted limitations — so `:ro` costs
the protocol nothing while making the socket structurally unreplaceable. The
daemon creates and unlinks the socket host-side, where the mount's read-only
flag does not apply.

The host socket path must stay within `sun_path`'s 108-byte limit; the stage
asserts this rather than letting a long `XDG_RUNTIME_DIR` produce an obscure
`bind` failure.

### Frame lifetime (S2)

The frame is written `0600` inside a `0700` session directory and removed when
the session scope closes. Today the only cleanup is `broker.ts:213`, which runs
**only if hostexec is enabled** — so with `mask.filter` on and `hostexec` off the
frame currently survives the session. MaskFilterStage takes ownership of removal
via `acquireRelease`; the broker's existing cleanup becomes redundant but
harmless.

### Nested supervision

The supervisor exports `NAS_MASK_SUPERVISED=1`; the wrapper skips supervision
when it is already set.

Without this, the connection count is not "a few shells" but **O(live bash
processes)**, because every `bash` in the container is the wrapper — including
`./configure`, every `make` recipe line, recursive make, and npm/cargo build
scripts. `make -j16` on a real project sustains dozens of live shells, and
nesting depth is unbounded. Each nested layer would also relay every byte across
the container↔host boundary again and add another `maxSecretLen - 1` bytes of
withholding delay.

Suppressing nested layers is safe because it costs no coverage: all descendants
inherit the outermost supervisor's pipes, so their output is already masked.
Output that escapes the outermost supervisor (a redirect to a file, a write to
`/dev/tty`) escapes every inner layer identically — inner wrappers never had
that coverage to lose.

### Protocol

One connection per stream: the supervisor opens two, one for the child's stdout
and one for its stderr. The server holds a separate `MaskStream` per connection
because overlap state is stream-specific.

Raw bytes in both directions, no framing. Masking preserves length, but the
server withholds the trailing `maxSecretLen - 1` bytes of each chunk so a secret
straddling a chunk boundary is still matched. **The reply is therefore delayed
and not byte-synchronous with the request**; the client must never assume
"wrote N, read N".

- EOF is signalled by `shutdown(SHUT_WR)`. The server flushes its retained
  overlap and closes.
- The client reads until the server closes.

**Deadlock avoidance is a hard requirement.** A client that writes without
concurrently reading fills the socket buffer and stalls both sides. The
supervisor's existing `poll(2)` loop is extended to cover socket readability and
writability alongside the child pipes.

### Resource bounds

The socket is reachable at the agent's UID, and the server runs on the **host**,
outside the container's cgroup. Without explicit bounds an agent can consume
host memory, host fds, and host CPU that the container's limits do not govern.
This is a resource-boundary escape even though it is not a confidentiality one,
and — because the design is fail-closed — exhausting the server takes down every
shell in the session, so it is an availability regression relative to today,
where a filter failure affects one command.

The server must therefore:

- Use **non-blocking** sockets throughout; never block the shared poll loop on a
  single peer.
- Cap the per-connection output queue. On exceeding the cap, **stop polling that
  connection for read**. Backpressure then propagates through the socket buffer
  to the supervisor and through the child's pipe to the writer, which is the
  correct and bounded behaviour.
- Cap total concurrent connections, and handle the cap and `EMFILE` by
  accept-and-close or by ceasing to poll the listener. Naively re-polling a
  readable listener that returns `EMFILE` is a permanent 100% CPU spin that
  serves nobody.
- Raise `RLIMIT_NOFILE` at startup.
- Allocate `MaskStream` lazily or from a pool. `MaskStream.init` currently
  reserves ~192 KiB per stream (`combined` + `scratch` + `mask_buf`), so
  allocating on accept makes one `connect()` worth 192 KiB of host memory.

Masking CPU also moves from the container's cgroup to the host, and `maskAll` is
`O(buf_len × n_secrets)`. Per-connection throughput limiting is the mitigation
if this proves abusable.

### Failure handling

Fail-closed: no code path may emit unmasked bytes.

| Failure point | Behaviour |
| --- | --- |
| Session startup: serve not ready | Stage fails, session aborts (matches MaskFsStage) |
| Initial connect, before fork | Small bounded retry, then exit without starting the child |
| Mid-stream disconnect | Fatal, no retry: discard output, exit `121` |
| Partial or failed socket write | Queue and re-arm `POLLOUT`; a real error is fatal |

Mid-stream disconnect is deliberately not retried. A UDS does not lose or
reorder data in flight, so a mid-stream failure means the peer process died —
there is nothing to reconnect to. A fresh connection also starts with empty
overlap state, so resuming could miss a secret straddling the seam.

The "partial write" row is not a detail. The existing `FdWriter` in
`supervise.zig:87` deliberately swallows write errors and treats a short write
as done — correct for the child's output fd, catastrophic for the socket: silently
dropping bytes `[i, i+k)` splits a secret so that neither fragment matches, and
**both fragments are then emitted verbatim**. The relay must use a distinct
writer that queues short writes and treats real errors as fatal.

Diagnostics go to the real stderr as **constant strings only**, since that path
does not pass through masking. Exit `121` is reserved for "output suppressed", so
a caller cannot mistake a lost-output run for success even when the child exited
`0`.

Accepted blast radius: if the serve process dies, every subsequent command in
the container fails. Availability is traded for non-disclosure, consistent with
`resolveMaskSecrets` and the addon's `MASK-BLOCKED` behaviour.

### fd hygiene

Both socket fds are created `SOCK_CLOEXEC` **and** added to the child's explicit
close list before `execve`.

If a socket fd leaks into the child, the agent gets an injection oracle rather
than a mere information leak: writing a byte into the middle of the stdout
connection makes the server see `hunXter2`, which matches nothing and is
returned verbatim to the agent's own stdout. Knowing the injected byte, the agent
recovers the secret directly — no brute force.

### Serve-mode output invariant

Serve mode must never write stream-derived bytes to its own stdout or stderr.
`ProcessService.spawn` points both at a log file, so any "failed masking chunk:
`<bytes>`" diagnostic would write plaintext to a persistent host file. The log
is created `0600` in the `0700` session directory and removed on scope release.

The invariant is also what makes the log quotable. When the readiness wait times
out without a socket, `MaskFilterService` appends the tail of that log to the
error the operator sees, so a broker that exits before binding (unreadable
secrets file, corrupt frame, address already in use) names its own cause instead
of leaving behind a bare "timed out waiting for file". Since everything serve
mode writes to the log is a constant diagnostic string, the spliced text cannot
carry stream-derived plaintext. Relaxing the output invariant would break that
splice as well as the confidentiality requirement, which stands on its own.

### Drain semantics

The supervisor's existing child-exit drain is unchanged: after the child exits,
remaining pipe data is drained with a short idle timeout so a background process
holding the pipe cannot hang the caller. Once the child pipes are done, the
supervisor half-closes each socket and reads the masked remainder to EOF, so the
server's retained overlap is never dropped.

### The wrapper's bypass branch

The wrapper's runtime fallback is removed: translating "the secret file is
readable" into "the socket exists" would preserve a **fail-open** path where a
dead serve process silently yields unmasked shells.

The wrapper's *first* branch is a separate, deliberate exemption:

```sh
if [ "${1:-}" = "/entrypoint.sh" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
```

It exists so entrypoint re-entry (`/entrypoint.sh --shell`) keeps a TTY, and
entrypoint's shell mode execs `$NAS_REAL_BASH` unmasked by design
(`entrypoint.sh:392,397`). So "a wrapper that runs at all must mask" is **false**,
and this spec does not rely on it. The exemption is recorded as accepted: the
operator's own interactive shell is out of scope for `mask.filter`, and an
existing Docker test asserts that TTY behaviour.

Because the branch keys off an agent-supplied argument, it is also reachable
from inside the container. Narrowing it to genuine entrypoint re-entry — by
gating on a root-owned sentinel created before privilege drop — is recommended
but is **not** in scope here; it is an independent hardening item, and the
`/proc` bypass above means it is not the weakest link.

## Accepted limitations

- **Oracle cost, not oracle existence.** The socket grants the same
  confirm-a-guess oracle the agent already has via `echo <guess>`, but far more
  cheaply: a 64 KiB write can batch thousands of candidates with no process spawn
  per probe. With `MIN_SECRET_BYTES = 4` (`src/lib/mask_secrets.ts:10`), a
  four-byte secret is recoverable in well under an hour. Raising the minimum
  length for filter-masked values is recommended. The withholding amount is
  match-state-independent, so there is **no prefix-match oracle** — the protocol
  shape does not enable byte-at-a-time extraction.
- **`maxSecretLen` is directly readable** by feeding one byte at a time and
  counting the delay before output returns.
- **A secret split across stdout and stderr is never masked** — two connections,
  two `MaskStream`s. Pre-existing and inherent.
- **The idle-timeout drain can cut mid-secret**: a background process that
  writes half a secret, idles past the timeout, then writes the rest gets the
  first half flushed unmasked. Pre-existing.
- **`mem.eql` early-exits**, so aggregate server time is weakly correlated with
  prefix match length. Vectorised comparison coarsens this well below
  byte granularity; noted rather than mitigated.
- **Orphaned serve process.** If nas is `SIGKILL`ed the daemon survives holding
  resolved secrets in memory, and the session dir leaks. MaskFs has the same gap;
  a stale-session sweep is worth adding but is not required here.
- **Socket substitution — resolved, no longer a limitation.** An earlier draft
  mounted the socket's directory read-write, which let the agent delete
  `mask.sock` and bind its own listener at that path; a listener that echoes its
  input disables masking entirely while `--supervise` still reports success. The
  draft left open whether a read-only bind mount was usable as the structural
  fix, since it would be worthless if `connect(2)` did not survive it.

  Measured on this host (Docker bind mount of a directory holding a live socket,
  client `connect(2)` + `write(2)` from inside the container):

  | socket dir mount | `connect(2)` | `rm mask.sock` | create a file |
  | --- | --- | --- | --- |
  | read-write | succeeds | **succeeds** | **succeeds** |
  | read-only | **succeeds** | `EROFS` | `EROFS` |

  `connect(2)` needs write permission on the socket *inode*, which the mount's
  read-only flag does not revoke; only namespace mutation is blocked. So `:ro`
  keeps the protocol working and removes substitution outright. The design mounts
  read-only for that reason.

  The socket still lives in a directory of its own — that requirement comes from
  C1 (the frame must not be reachable), not from substitution, and is unchanged.

## Testing

Per `test-policy`: unit tests are `*_test.ts`, Docker-dependent tests are
`*_integration_test.ts`, both co-located with their source.

Serve and supervise both run on the host, so the core is testable without Docker.

- **Zig unit tests** — `MaskStream` unchanged; serve argument parsing;
  per-connection state isolation.
- **`mask_filter_service_test.ts`** — the C1/S1 regression guard: produced mounts
  contain no secret frame and produced env contains no `NAS_MASK_SECRETS_FILE`.
  Must also assert the frame **is** still written host-side, so a future change
  cannot silently break hostexec's C3 path while the guard still passes.
- **`mask_filter_integration_test.ts`** (real UDS, no Docker) — masking of stdout
  and stderr; a secret straddling a chunk boundary; exit-code and signal
  propagation; **a stalled reader** (client stops draining) exercising the output
  cap and backpressure rather than unbounded growth; behaviour at the connection
  cap; concurrent supervised shells not blocking each other; fail-closed when the
  server is stopped mid-run; and `ls -l /proc/self/fd` inside the supervised
  child containing no `socket:` entry. (Asserting "only 0/1/2" is not achievable
  — `ls` holds its own directory fd — so the invariant is asserted directly.)

  **Socket test clients must use `Bun.connect` with `socket.shutdown()`.** Under
  Bun 1.3.9, `node:net`'s `sock.end()` performs a full close, not a half-close:
  measured, the server's post-EOF write fails with `EPIPE` and the client
  receives nothing, whereas `Bun.connect` + `shutdown()` receives the flushed
  tail. Since the protocol's entire flush path hangs off half-close, a test built
  on `node:net` reports a correct server as broken.
- **hostexec regression** — an existing hostexec masking test must still pass,
  proving C3 survives.
- **`launch/integration_test.ts`** (Docker) — wrapper wiring for the command,
  login, and script forms; nested `bash -c bash -c` producing exactly one
  supervision layer; and the inverted fallback test — with the socket absent the
  shell fails closed instead of emitting unmasked output.

Known cost: the Python mask-filter fixture in `launch/integration_test.ts` is a
~30-line stdin→stdout filter and must grow a `--serve` socket server and a
`--supervise` relay client. It is kept rather than replaced by the real Zig
binary because it lets the Docker tests run without a Zig build prerequisite,
which is the property it exists for.

## Why

Masking must happen before the agent reads the bytes, and the agent reads them
inside the container, which rules out masking at the host boundary after the
fact. The only way to satisfy that ordering while keeping the secret index out of
the container is to move the bytes to the host, mask them there, and move them
back — a host-side broker over a Unix socket.

The approach lands `mask.filter` on a shape the project already relies on twice:
maskfs runs a host-side Zig daemon, and hostexec exposes a least-privileged Unix
socket to the container while keeping the privileged endpoint host-side.

Reusing `nas-mask-filter` for the server keeps the masking algorithm at one
implementation. The repository already carries three (`mask.zig`,
`mask_patterns.ts`, `nas_addon.py`) with an explicit "keep both implementations
in sync" comment; a fourth would be a durable maintenance cost.

Keeping the host-side frame file — rather than switching to stdin delivery — is
what makes the change compatible with hostexec's C3 masking, and C1 prescribes
exactly that arrangement anyway.

## Why Not

- **Privilege separation (setuid `nas-mask-filter`, frame `root:root 0600`)** —
  Keeps the frame in the container and satisfies C1's intent but not its rule. It
  is blocked twice by the current layout: the binary is bind-mounted `nosuid`, so
  the setuid bit is silently ignored, and the frame's tmpfs is `uid=1000`, so
  entrypoint would have to materialise a root-owned copy and unmount the
  agent-visible one before dropping privileges. It adds a setuid-root binary that
  parses attacker-controlled bytes and requires hardcoding the frame path,
  because a setuid binary reading an env-specified file turns the masking oracle
  into an arbitrary-file-read oracle. More risk, weaker guarantee.

- **Hashed frame (length + rolling hash)** — Cheapest, removes the plaintext
  index, but the frame stays in the container and stays readable, so low-entropy
  values remain brute-forceable offline; the filter must hash every window
  position at line rate, so a slow KDF is unavailable. Does not satisfy C1. Its
  usual objection — that hashes create a confirmation oracle — is not a
  differentiator, since the filter already is one.

- **Stdin frame delivery instead of a host file** — Strictly stronger in
  isolation and was the earlier draft, but it breaks hostexec's C3 masking, which
  reads the frame file directly. Migrating hostexec onto the same socket is
  possible but expands the change to `MaskFilterConfig`, `broker.ts:213/741`,
  `hostexec/stage.ts:373`, and their tests, for no C1 benefit — C1 already
  sanctions a host-only file.

- **Extending the hostexec broker instead of a dedicated socket** —
  `mask.filter` can be enabled independently of `hostexec` (`hostexec` is
  optional in the profile), so this would make hostexec a de facto prerequisite
  or require untangling the dependency.

- **Passing pipe fds with `SCM_RIGHTS`** — Removes the extra copy and would let
  the host run the masking loop directly on the child's pipes. Rejected because
  it splits lifetime control across the process boundary: drain completion, the
  background-process idle timeout, and exit-code propagation would move host-side
  while the child stays container-side. The byte relay keeps all of that in the
  supervisor. UDS bandwidth is not a practical constraint.
