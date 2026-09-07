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
}
```

When enabled, the container gets this command through the hostexec wrapper
directory already prepended to `PATH`:

```console
hostexec wl-copy 'hello from the sandbox'
```

The option installs the command and appends an internal prompt rule for its
exact installed path. No user rules are required. The command runs from the
workspace or session temporary directory and inherits the host environment.
Existing user rules retain precedence, including explicit denial. The example
copies text to a Wayland host's clipboard and requires wl-copy on that host.
The internal argument matcher excludes an
empty argv, `--` alone, and invocations whose first argument is `-h` or
`--help`, allowing those requests to fall back immediately to local usage.
The default remains disabled and existing profiles retain their behavior.

## Source and runtime layout

The single canonical shell source moves from `scripts/hostexec` to
`src/hostexec/hostexec`. TypeScript imports that file as text so `bun build
--compile` embeds it; there is no second string-literal copy. Remove the old
`scripts/hostexec` path entirely, without a compatibility symlink. Update
repository development references to the canonical source path. Installed
sessions invoke `hostexec` from PATH.

At session setup, HostExecSetupService writes the embedded bytes as executable
`<host wrapperRoot>/bin/hostexec`. The existing wrapper-directory mount exposes
that file read-only at `/opt/nas/hostexec/bin/hostexec`. That directory is
already first on the container command `PATH`, so no workspace mount and no
additional PATH mutation are needed.

The installed script has a setup-service handle registered with the session
scope. Closing the scope removes the file, including when broker startup fails.
A failed write also removes partial output before returning an error.

## Interception and fallback

Ordinary bare-name hostexec rules create a symlink named after the command that
points to `nas-hostexec-client`. The installed `hostexec` entry is different:
it is the real shell script, so the planner must not replace it with that
symlink.

The planner adds `/opt/nas/hostexec/bin/hostexec` to
`NAS_HOSTEXEC_INTERCEPT_PATHS`. The existing LD_PRELOAD interceptor therefore
captures the shell's `execve` of the PATH-resolved script before its body runs.
PATH-search entry points resolve the first executable before checking the
intercept list. Spawn calls use the standalone client as a relay so the real
spawn implementation applies file actions, attributes, and the child environment.
An explicitly configured bare rule matching `hostexec` continues to match the
absolute request path by basename.

If no rule matches, the interceptor permits the original exec. The mounted
script then warns that execution is in the container
and execs its payload there. Thus the same canonical script remains the source
of help, argument parsing, and fallback behavior. Policy denial and approval
denial retain their existing error behavior; `fallback` does not change that.

## Broker execution

After a request for the installed command matches a user or internal rule
and is approved, the broker removes one optional leading `--`, then runs the
first remaining argument with the rest instead of trying to execute a host
binary named `hostexec`. The resolved cwd and inherited env come from the
matched rule.

HostExecStage passes the exact container path of the installed command to the
broker only when `installScript` is enabled. Payload execution is selected by
an exact normalized match between the request argv0 and that nas-managed path,
not by rule ID or basename. A user-controlled executable elsewhere named
`hostexec` therefore remains an ordinary hostexec target. The selected rule is
still required: the installation's default rule requests approval, not automatic
host execution.

Approval fingerprints, pending requests, and audit records retain the original
wrapper invocation and its full arguments. Approval for
`hostexec wl-copy hello` therefore does not authorize a different payload.

With the internal default rule, an empty invocation, `--` alone, and help flags do
not need host approval. They do not match, so the interceptor follows the
existing container fallback path and lets the wrapper print usage. With a
broader rule, normal authorization applies before returning local usage;
denial must not be converted into fallback.

## Integrity model

The container script is generated under a host-private directory and mounted
read-only. It is used only for local help and container fallback; the broker
does not execute that file on the host. Approved host execution directly uses
the payload argv, eliminating a mutable intermediate executable from the host
path.

The installed container path is included in interceptor configuration but not
in the broker's host-file integrity baseline: it has no corresponding host path
and the internal rule targets only that container path. Existing relative and absolute user
rules remain integrity-checked exactly as before.

## Security and failure behavior

- The control socket remains host-only; the feature uses only the existing exec
  socket and approval flow.
- No secret value or host-only broker directory is mounted.
- The runtime wrapper directory is mounted read-only in the container.
- Nothing appears in or shadows the workspace.
- Installation adds a prompt rule, never an unconditional allow rule.
- Payload execution requires both authorization and the exact
  nas-managed installed-command path.
- Command, cwd, environment, approval, audit, masking, cancellation, and exit
  reporting continue through the existing gateway path.
- Missing intercept artifacts retain the current actionable startup error.

## Testing

- Pkl loading covers the default `false` and explicit `true` values.
- Planner tests cover the embedded executable plan, absence of a client symlink
  named `hostexec`, the absolute interceptor path, default prompt policy without
  user rules, explicit-denial precedence, and
  disabled behavior.
- Setup-service tests cover executable creation and partial-failure cleanup.
- Broker tests cover payload argv selection with and without `--`, exact-path
  selection, disabled behavior, unchanged approval/audit identity, and ordinary
  rules elsewhere named `hostexec`. Match tests cover the default local
  fallback for usage and help invocations.
- Integration coverage runs an installed command through the gateway and
  verifies host success, rule-unmatched container fallback, and denial.

## Non-goals

- Adding any generated or mounted path to a repository.
- Installing a persistent global executable on the host.
- Bypassing approval or overriding existing user restrictions.
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
the only required case is the nas-managed installed path. Requiring a separate
rule was rejected because this opt-in command is intended to be usable with one
setting. A default prompt preserves the user's decision at execution time;
retaining the host environment lets host tools work without per-tool rules.
