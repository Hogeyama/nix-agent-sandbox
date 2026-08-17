# Environment-Independent Bash Mask Filter Design

Date: 2026-08-17
Status: Approved

## Context

When `mask.filter` is enabled, the container entrypoint preserves the image's
real Bash and replaces `/bin/bash` with a generated wrapper. The wrapper starts
`nas-mask-filter --supervise`, which owns the command's stdout and stderr pipes,
masks configured values, drains both streams, and returns the command's exit
status.

The wrapper currently finds the filter binary and the session broker through
two environment variables on every invocation:

```text
NAS_MASK_FILTER
NAS_MASK_SOCKET
```

Codex retains both variables in its PID 1 process and in
`codex-code-mode-host`, but unified shell execution reconstructs a child
environment without the `NAS_*` variables. The Bash wrapper therefore exits
with the reserved fail-closed status 121 before the requested command starts.
Even `pwd` fails with empty stdout and stderr.

The runtime guard was originally intentional: an `env -i` Bash must not fall
back to the real shell when the wrapper has no way to find its mask broker.
Removing the guard or falling back to `bash.real` would restore availability by
allowing unmasked output. This design instead removes the wrapper's runtime
dependency on inherited broker-location variables.

## Goal

Once entrypoint has successfully installed the Bash wrapper for an enabled
mask filter, later `/bin/bash` invocations must continue to use the same
validated filter binary and session socket even if their environment no longer
contains `NAS_MASK_FILTER` or `NAS_MASK_SOCKET`.

The change must preserve these properties:

- command stdout and stderr pass through `nas-mask-filter --supervise`;
- an unavailable broker never causes the requested command to run unfiltered;
- nested Bash processes use one supervisor layer;
- entrypoint shell re-entry retains its existing TTY-preserving bypass; and
- disabling `mask.filter` leaves the system Bash untouched.

## Scope

Included:

- the generated `/bin/bash` and `PATH`-override wrappers;
- Codex shell children whose environment omits the two broker-location
  variables;
- safe serialization of the validated paths into the wrapper;
- regression coverage for stripped environments, unavailable sockets, and
  nested Bash; and
- updating `docs/todo/codex.md` to record the availability fix.

Excluded:

- forcing Codex to select `/bin/bash` rather than `/bin/sh` or another shell;
- wrapping every shell or arbitrary executable in the container;
- Codex Hook policy or changes to Codex's unified exec implementation;
- `LD_PRELOAD` or syscall interception; and
- OpenAI request-body masking. Codex egress masking belongs to the configurable
  request-policy work and remains the provider-specific confidentiality
  boundary before model traffic leaves NAS.

The stdout filter still reduces exposure in local terminal output and other
local output consumers. This change does not claim that a Bash wrapper is an
enforcement boundary against an agent that deliberately selects an unwrapped
shell.

## Design

### Capture the paths at wrapper installation

Entrypoint already installs the wrapper only when both `NAS_MASK_FILTER` and
`NAS_MASK_SOCKET` are non-empty. At that point MaskFilterStage has resolved the
filter asset, mounted it read-only, started the session broker, waited for the
socket, and added both paths to the container plan.

Wrapper generation will serialize those two values into assignments near the
top of the generated script. Entrypoint is Bash, so it can use Bash
`printf '%q'` to produce values that round-trip as one shell word even if a
future runtime path contains whitespace or shell metacharacters. The generated
wrapper is interpreted by the preserved `bash.real`, so the quoting format has
the same parser at generation and execution time.

The embedded assignments use wrapper-private names rather than the public
environment-variable names. They overwrite any same-named inherited value and
are marked read-only before control reaches the runtime branches. A later child
cannot redirect the wrapper to a different filter binary or socket by changing
`NAS_MASK_FILTER` or `NAS_MASK_SOCKET`.

The binary and socket paths are not secrets. The binary is a read-only
container mount, and the socket path is already visible in the container's
environment and mount table. Secret values and the host-side secret frame are
not written into the wrapper.

### Preserve wrapper branch ordering

The generated wrapper keeps its current early branches:

1. When it is interpreting `/entrypoint.sh`, it execs `bash.real` directly so
   shell re-entry keeps its TTY.
2. When `NAS_MASK_SUPERVISED` is present, it execs `bash.real` directly because
   the outer supervisor already owns the inherited output pipes.
3. Otherwise, it starts the supervisor using the embedded filter and socket
   paths, then runs `bash.real` with the original arguments and caller-facing
   `argv[0]`.

The third branch no longer reads `NAS_MASK_FILTER` or `NAS_MASK_SOCKET` from
the invocation environment. The public variables remain in the container plan
for entrypoint setup and diagnostics; only the generated wrapper stops relying
on their later propagation.

### Failure behavior

The session socket is fixed for the container lifetime. If it disappears or
the broker no longer accepts connections, `nas-mask-filter --supervise` keeps
its existing fail-closed behavior: the requested Bash child does not run,
unverified command output is not forwarded, and the wrapper returns status
121.

Wrapper installation remains guarded by entrypoint's `set -e`. Failure to
resolve or preserve Bash, serialize the paths, write the temporary wrapper,
set its mode, or atomically replace the Bash targets aborts agent startup.

There is no fallback to `bash.real` for an ordinary unsupervised invocation.
The only real-Bash branches are the existing entrypoint and already-supervised
cases, where filtering is either intentionally outside the wrapper or already
owned by the outer supervisor.

## Testing

### Wrapper and supervisor integration

Update the wrapper fixture in
`src/stages/maskfs/mask_filter_integration_test.ts` so it accepts installation
time filter and socket paths and emits the same embedded assignments as
entrypoint.

Add or revise coverage to prove:

1. Start the broker, generate the wrapper with both paths, then spawn it with an
   otherwise empty environment. The command succeeds and its secret-bearing
   output is masked.
2. Generate the wrapper with a socket path whose broker is unavailable, then
   spawn it without the public environment variables. The command body is not
   observed, stdout and stderr contain no command output, and the status is
   121.
3. Nest the generated wrapper under its own supervisor and confirm the
   existing `NAS_MASK_SUPERVISED` marker still limits supervision to one layer.

### Container entrypoint integration

Extend `src/stages/launch/integration_test.ts` with the complete runtime path:

1. Launch a container with `NAS_MASK_FILTER` and `NAS_MASK_SOCKET`, causing
   entrypoint to install the wrappers.
2. Have the agent command run `/bin/bash` from an environment that omits both
   public variables.
3. Assert the command exits successfully, its output is present, and the
   configured secret appears only as the same-length mask.

Existing filter-disabled, unreachable-broker, nested-wrapper, shell re-entry,
and Nix-launch tests remain regression coverage for unchanged behavior.

## Files

- Modify `src/docker/embed/entrypoint.sh` to serialize the validated paths into
  the generated wrapper and use those private fixed values at runtime.
- Modify `src/stages/maskfs/mask_filter_integration_test.ts` for stripped-env,
  unavailable-socket, and nesting coverage against the generated shape.
- Modify `src/stages/launch/integration_test.ts` for the container-level Codex
  regression.
- Modify `docs/todo/codex.md` to mark item 4 fixed and describe the final
  behavior without expanding the claim to other shells.

No stage, service, configuration schema, Zig filter protocol, Hook, or Codex
binary changes are required.

## Why — Why this approach

The failure occurs after NAS has already validated and mounted the filter
resources: an external runtime discards the variables that merely point to
them. Capturing those non-secret, session-stable paths at installation fixes
the dependency at its source and remains correct under Codex environment
reconstruction, `env -i`, or another runner with the same sanitization.

The change stays inside the NAS-owned entrypoint and preserves the existing
supervisor, socket protocol, nested-shell behavior, and fail-closed exit code.
It therefore has a smaller compatibility and security surface than adding a
second configuration artifact or teaching NAS about Codex's internal process
tree.

## Why Not — Why the alternatives were rejected

- **Teach Codex to preserve the variables** — NAS cannot guarantee the
  behavior of an external Codex release, and another environment sanitizer
  would recreate the same failure.
- **Read a root-owned runtime config file** — this adds a mutable artifact,
  permissions, parsing, and missing-file behavior without providing anything
  the generated wrapper cannot safely contain itself.
- **Fall back to `bash.real` when variables are missing** — this converts an
  availability failure into unmasked command output and violates the existing
  fail-closed contract.
- **Use a Hook to deny or rewrite alternate shells** — current Hooks are useful
  guardrails but not a complete enforcement boundary, and this availability
  bug does not require changing tool policy.
- **Use `LD_PRELOAD`** — the mounted Codex and code-mode host binaries are
  statically linked, child processes may be static or issue syscalls directly,
  and the preload environment is itself removable.
- **Wrap every shell** — this changes container-wide shell semantics and still
  cannot cover an arbitrary interpreter selected by a tool. Provider egress
  masking is the appropriate independent layer for model-bound traffic.
