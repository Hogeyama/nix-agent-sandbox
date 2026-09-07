# Hostexec Command Installation Design

## Goal

Allow any nas profile with hostexec enabled to opt into a session-scoped
`hostexec <command> [args...]` command. The command must not create, mount, or
otherwise expose a path inside the workspace, so enabling it never changes
`git status`.

## Configuration and command surface

Add `installScript: Boolean = false` to `HostExecConfig` and the matching
`installScript: boolean` TypeScript field. It belongs to `hostexec` because it
is an entry point into that capability and is meaningless without its broker.

```pkl
hostexec = new HostExecConfig {
  installScript = true
  prompt { enable = true }
}
```

When enabled, the container gets this command through the hostexec wrapper
directory already prepended to `PATH`:

```console
hostexec bun run test
hostexec -- bun run test
```

The option supplies an internal rule with prompt approval,
`workspace-or-session-tmp` cwd, `unsafe-inherit-all`, and container fallback.
The default remains disabled and no existing user rule changes.

The rule's argument matcher deliberately excludes an empty argv, `--` alone,
and invocations whose first argument is `-h` or `--help`. Those requests fall
back immediately to the container script, which prints usage without creating
an approval request.

## Source and runtime layout

The single canonical shell source moves from `scripts/hostexec` to
`src/hostexec/hostexec`. TypeScript imports that file as text so `bun build
--compile` embeds it; there is no second string-literal copy.

At session setup, HostExecSetupService writes the embedded bytes as executable
`<host wrapperRoot>/bin/hostexec`. The existing wrapper-directory mount exposes
that file read-only at `/opt/nas/hostexec/bin/hostexec`. That directory is
already first on the container command `PATH`, so no workspace mount and no
additional PATH mutation are needed.

The wrapper root is private host runtime state and is removed by the existing
hostexec session cleanup. A failed write cleans up partial output through the
same setup-service error path.

## Interception and fallback

Ordinary bare-name hostexec rules create a symlink named after the command that
points to `nas-hostexec-client`. The installed `hostexec` entry is different:
it is the real shell script, so the planner must not replace it with that
symlink.

The planner adds `/opt/nas/hostexec/bin/hostexec` to
`NAS_HOSTEXEC_INTERCEPT_PATHS`. The existing LD_PRELOAD interceptor therefore
captures the shell's `execve` of the PATH-resolved script before its body runs.
The internal rule itself matches the bare name `hostexec`, which continues to
match the absolute request path by basename.

If the request is denied with container fallback, the interceptor permits the
original exec. The mounted script then warns that execution is in the container
and execs its payload there. Thus the same canonical script remains the source
of help, argument parsing, and fallback behavior.

## Broker execution

After a request matches the internal installed-command rule and is approved,
the broker removes one optional leading `--`, then runs the first remaining
argument with the rest instead of trying to execute a host binary named
`hostexec`. The resolved cwd and inherited env still come from that rule.

The internal behavior is not selected by rule ID. HostExecStage creates the
rule object and passes that exact object separately to the broker together with
the config containing it. The broker uses object identity to select payload
execution. A user rule with the same ID or match string therefore remains an
ordinary rule and cannot acquire argv rewriting. User rules stay before the
internal rule, preserving current first-match precedence.

Approval fingerprints, pending requests, and audit records retain the original
wrapper invocation and its full arguments. Approval for
`hostexec bun run test` therefore does not authorize a different payload.

An empty invocation, `--` alone, and help flags do not need host approval. They
do not match the internal rule, so the interceptor follows the existing
container fallback path and lets the wrapper print usage. No synthetic gateway
exit path is needed.

## Integrity model

The container script is generated under a host-private directory and mounted
read-only. It is used only for local help and container fallback; the broker
does not execute that file on the host. Approved host execution directly uses
the payload argv, eliminating a mutable intermediate executable from the host
path.

The installed container path is included in interceptor configuration but not
in the broker's host-file integrity baseline: it has no corresponding host path
and the matching rule is a bare-name rule. Existing relative and absolute user
rules remain integrity-checked exactly as before.

## Security and failure behavior

- The control socket remains host-only; the feature uses only the existing exec
  socket and approval flow.
- No secret value or host-only broker directory is mounted.
- The runtime wrapper directory is mounted read-only in the container.
- Nothing appears in or shadows the workspace.
- Only the stage-created rule object can activate payload execution.
- Command, cwd, environment, approval, audit, masking, cancellation, and exit
  reporting continue through the existing gateway path.
- Missing intercept artifacts retain the current actionable startup error.

## Testing

- Pkl loading covers the default `false` and explicit `true` values.
- Planner tests cover the embedded executable plan, absence of a client symlink
  named `hostexec`, the absolute interceptor path, internal-rule ordering, and
  disabled behavior.
- Setup-service tests cover executable creation and partial-failure cleanup.
- Broker tests cover payload argv selection with and without `--`, inability of
  a same-ID user rule to trigger rewriting, unchanged approval/audit identity,
  and unchanged ordinary rules. Match tests cover local fallback for usage and
  help invocations.
- An artifact-capability-guarded integration test runs an installed command
  through the gateway and verifies both host success and denied container
  fallback.

## Non-goals

- Adding any generated or mounted path to a repository.
- Installing a persistent global executable on the host.
- Automatically enabling hostexec or weakening existing approval policy.
- General user-configurable command rewriting.
- Adding nas-operation instructions to the agent skill; that remains the
  separate first scratchpad item.

## なぜこのアプローチを選んだか

The existing `/opt/nas/hostexec/bin` directory is already session-scoped,
read-only in the container, and first on PATH. Reusing it gives the command a
normal CLI surface without contaminating the repository. Keeping the shell file
under `src/hostexec` also puts the shipped hostexec asset beside the subsystem
that owns it and allows the compiler to embed one canonical source.

A workspace path was rejected because a nested bind mount is still visible to
Git and changes `git status`, even if it never writes the host checkout. A
persistent repository copy was rejected for the same reason plus update and
collision policy. Executing the runtime shell script on the host was rejected
because it introduces an extra mutable executable and requires translating the
container path back to a host path. General argv rewriting was rejected because
the only required case is the nas-owned escape hatch; passing the exact internal
rule object keeps that exception unforgeable from Pkl configuration.
