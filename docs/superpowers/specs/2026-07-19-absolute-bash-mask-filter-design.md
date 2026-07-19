# Absolute Bash Mask Filter Design

Date: 2026-07-19
Status: Proposed

## Context

The stdout/stderr mask filter currently installs a wrapper at
`/tmp/nas-bash-override/bash` and prepends that directory to `PATH`. This works
when an agent starts Bash by bare name, but Codex starts command tools through
`/bin/bash`. An absolute executable path bypasses `PATH`, so secret-bearing
command output reaches the agent unchanged.

This design extends the Bash-wrapper approach from
`2026-07-17-stdout-secret-mask-filter-design.md`. It does not change the Zig
filter, secret frame, MaskFilterStage, or configuration schema.

## Goal

When `mask.filter` is enabled, commands started through
`/bin/bash -c`, `/bin/bash -lc`, or `/bin/bash script` must inherit stdout and
stderr pipes backed by `nas-mask-filter`, even when the caller does not search
`PATH`.

The invoked shell must continue to observe the caller-facing executable name as
`$0`, and the agent process itself must retain a TTY.

## Scope

Included:

- Bash invoked through the absolute `/bin/bash` path.
- Bare `bash` invocations already covered through `PATH`.
- Normal and Nix-enabled agent startup paths.
- Re-entry through `/entrypoint.sh --shell` after the system Bash has been
  replaced.

Excluded:

- `/bin/sh`, zsh, fish, and other shells.
- Executables launched directly without Bash.
- `LD_PRELOAD` interception.
- Changes to mask-filter matching or hostexec filtering.

## Design

### Runtime paths

The existing Bash override directory remains the ownership boundary:

- `/tmp/nas-bash-override/bash`: generated filter wrapper and `PATH` target.
- `/tmp/nas-bash-override/bash.real`: original image-provided Bash executable.

No new files are placed directly under `/opt/nas`. `/opt/nas/mask-filter` stays
reserved for the bind-mounted `nas-mask-filter` asset supplied by
MaskFilterStage.

### Resolving the system Bash

The embedded image is based on Ubuntu 24.04, where `/bin` may be usrmerged.
Entrypoint resolves the executable once with `readlink -f /bin/bash` and replaces
that resolved file. It must not independently replace `/bin/bash` and
`/usr/bin/bash`, because they may name the same file through the `/bin` symlink.

Before replacement, entrypoint copies the resolved executable to
`bash.real`. The copy happens only when `bash.real` is absent, preventing a
second entrypoint invocation from backing up the wrapper over the original.

The wrapper is written to a temporary file in `/tmp/nas-bash-override`, marked
executable, then renamed over the resolved system Bash. Renaming avoids a
partially written `/bin/bash` if setup is interrupted.

### Wrapper behavior

The wrapper interpreter and final exec both use `bash.real`, so replacing the
system Bash cannot recurse.

For ordinary agent child shells, the wrapper:

1. redirects stdout through `nas-mask-filter`;
2. redirects stderr through a separate `nas-mask-filter` process;
3. execs `bash.real` with the original arguments and caller-facing `argv[0]`.

Preserving `argv[0]` keeps `$0` equal to `/bin/bash` for an absolute invocation.

When the wrapper is interpreting `/entrypoint.sh`, it execs `bash.real` without
installing filter pipes. This is required for `nas container shell` re-entry:
filtering entrypoint itself would make the eventual interactive shell inherit
pipe-backed stdout/stderr and lose TTY behavior.

### Agent startup

The existing one-shot `__NAS_MASK_FILTER_SKIP` environment variable is removed.
It is inherited by directly executed agents and can unintentionally exempt the
first child Bash rather than only the agent-launch shell.

Entrypoint-owned Bash processes used to source Nix environment state and launch
the agent call `bash.real` explicitly. These processes do not receive filter
redirections, so the agent retains its terminal. After the agent starts, its
absolute `/bin/bash` children enter the installed wrapper normally.

When filtering is disabled, entrypoint retains the existing behavior: the
override directory contains a symlink to the image-provided `/bin/bash`, and the
system Bash is not modified.

## Failure Behavior

Mask-filter setup is fail-closed. If resolving, copying, writing, chmodding, or
renaming Bash fails while `mask.filter` is enabled, `set -e` terminates
entrypoint rather than starting an agent whose command output is unfiltered.

The wrapper keeps the existing runtime fallback: when the mounted filter or
secret-frame environment is unavailable, it execs `bash.real` without adding
redirections. Mount availability is already validated by the container launch
path; this fallback avoids making an existing container unusable during manual
diagnostics.

## Testing

Extend `src/stages/launch/integration_test.ts` with real-container coverage:

1. Enable the filter with a mounted test secrets frame and mask-filter binary.
2. Launch an unfiltered parent executable that invokes
   `/bin/bash -c 'printf ...'`.
3. Assert the secret is absent and same-length asterisks are present.
4. Assert `/bin/bash -c 'printf %s "$0"'` reports `/bin/bash`.
5. Assert filter-disabled container startup leaves `/bin/bash` as the original
   executable behavior and existing launch tests still pass.

The integration test is Docker-dependent and follows the repository's
`*_integration_test.ts` policy. No stage or service unit tests change because
the ContainerPlan contract is unchanged; this behavior belongs to the embedded
entrypoint runtime.

## Files

- Modify `src/docker/embed/entrypoint.sh` for original-Bash preservation,
  system-Bash replacement, wrapper generation, and explicit real-Bash agent
  startup.
- Modify `src/stages/launch/integration_test.ts` for absolute `/bin/bash`
  filtering coverage.
- No changes to `src/stages/maskfs/`, pipeline stages, configuration, or the Zig
  filter.
