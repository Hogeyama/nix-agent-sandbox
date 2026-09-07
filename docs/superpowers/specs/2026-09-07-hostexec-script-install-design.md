# Hostexec Script Installation Design

## Goal

Allow any nas profile with hostexec enabled to opt into a session-scoped
`./scripts/hostexec` command without copying that script into the repository.
The command delegates the argv following it to the host through the existing
hostexec approval path.

## Configuration

Add `installScript: Boolean = false` to `HostExecConfig` and the matching
`installScript: boolean` TypeScript field. The option lives under `hostexec`
because it is an entry point into that capability and is meaningless without
the broker.

```pkl
hostexec = new HostExecConfig {
  installScript = true
  prompt { enable = true }
}
```

When enabled, nas supplies an internal rule equivalent to:

```text
id: __nas_hostexec_script
argv0: ./scripts/hostexec
cwd: workspace-or-session-tmp
inheritEnv: unsafe-inherit-all
approval: prompt
fallback: container
```

The ID is reserved for nas. User rules remain ordered before internal rules,
so an explicit user rule for the same path continues to take precedence.

## Runtime layout and lifecycle

HostExecStage writes the embedded shell script below the session's private
hostexec runtime directory. It mounts that file read-only at
`<container workDir>/scripts/hostexec`. The workspace itself is never changed.
The runtime file is owned by the existing hostexec setup lifecycle and is
removed with the per-session wrapper root.

Before preparing the runtime file, the setup service checks the corresponding
host workspace path. If a file or directory already occupies
`scripts/hostexec`, startup fails with an actionable error instead of hiding
repository content with a nested bind mount. The check is performed against
the host-side workspace path represented by `workspace.workDir`.

The mounted script is executable and contains no credentials. Its fallback
behavior matches the repository's existing `scripts/hostexec`: if interception
does not occur, it warns that the command is running in the container and then
executes the requested command there.

## Broker execution

The mounted script is intercepted before its shell body runs. For the reserved
internal rule only, the broker treats the request arguments as the real command:
it requires at least one argument, then starts `args[0]` with `args.slice(1)`.
Approval fingerprints and audit records continue to describe the wrapper plus
its complete original arguments, so approval for one payload does not authorize
another payload. The command still uses the rule's normalized cwd and inherited
environment.

An empty invocation is rejected with usage status 64. User-authored rules can
never opt into argument shifting merely by choosing similar fields; only the
reserved internal rule installed by nas has this behavior.

## Security and failure behavior

- The control socket remains host-only; the feature uses the existing exec
  socket and approval machinery.
- No secret value is written or mounted. Environment inheritance is the same
  explicit unsafe behavior documented by the existing repository script rule.
- The generated script and its mount are read-only from the container.
- Existing workspace content is never overwritten or shadowed.
- Missing build artifacts retain the current HostExecStage errors.
- A script setup failure aborts startup and cleans partial session files.

## Testing

- Pkl loading tests cover the default `false` value and explicit `true`.
- Planner tests cover the internal rule, mount, intercept path, and disabled
  behavior.
- Setup-service unit tests cover executable creation, collision rejection, and
  cleanup after partial failure.
- Broker tests cover argv shifting, empty invocation, unchanged capability
  identity, and unchanged behavior for ordinary rules.
- An integration test executes an installed script through the gateway when
  the required hostexec artifacts are available.

## Non-goals

- Installing a global `hostexec` command on the host or container PATH.
- Editing or generating repository files.
- Automatically enabling hostexec or changing existing user rule approvals.
- Adding nas-operation instructions to the agent skill; that is the separate
  first scratchpad item.

## なぜこのアプローチを選んだか

A session runtime file plus a read-only nested mount preserves the requested
`./scripts/hostexec` interface without leaving generated files in user repos.
Making the broker shift argv for one reserved rule avoids assuming that a
container mount target is also executable at the same path on the host,
especially when worktree mount roots differ.

Persistently copying the script into each repository was rejected because it
creates untracked files and needs an overwrite/update policy. A bare `hostexec`
wrapper was rejected because it changes the requested interface and conflicts
with the existing bare-command wrapper mechanism, whose host side expects an
executable of the same name on PATH. A general configurable argv-rewrite field
was rejected because it expands the host execution policy surface for no current
need; the reserved internal rule keeps the special behavior narrow.
