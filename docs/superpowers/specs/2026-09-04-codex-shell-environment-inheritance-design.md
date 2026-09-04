# Codex Shell Environment Inheritance Design

Date: 2026-09-04
Status: Approved

## Context

NAS launches Codex inside an isolated container and adds runtime environment
variables for services such as the hostexec broker. Codex may nevertheless
construct shell-command environments from its own
`shell_environment_policy`. When that policy uses `inherit = "core"`, the
Codex process and `codex-code-mode-host` retain the NAS variables while shell
commands lose values such as `NAS_HOSTEXEC_SOCKET`. A hostexec wrapper then
fails closed because it cannot reach its broker.

The container is the intended trust boundary. Environment variables admitted
to that container are meant to be available to commands running inside it;
NAS does not need a second, narrower environment boundary around Codex shell
commands.

## Goal

Codex sessions launched by NAS must pass the complete container environment to
their shell commands so hostexec wrappers and future NAS integrations keep the
runtime configuration they were given.

## Design

When the Codex binary is available, its configured command will include this
invocation-local override:

```text
codex -c shell_environment_policy.inherit=all
```

The override applies only to the Codex process inside the NAS container. NAS
will not edit the mounted `~/.codex/config.toml`, enumerate individual broker
variables, or change Claude and Copilot commands. Existing later command
patches, including the Codex observability override, remain composable because
each setting is represented as its own `-c key=value` pair.

If the Codex binary is unavailable, the existing diagnostic fallback command
is unchanged.

## Testing

Unit coverage for the pure Codex configurator will verify that:

- a detected Codex binary receives the `inherit=all` override;
- the fallback command does not receive Codex-only options;
- existing Docker arguments and environment variables remain unchanged; and
- the observability command patch composes with the inheritance override.

The repository unit suite and full final suite will guard the surrounding
pipeline behavior.

## Why this approach

`inherit=all` matches NAS's architecture: isolation and environment admission
happen at the container boundary. It also preserves new NAS runtime variables
without requiring a provider-specific allowlist to be updated whenever another
container service is added.

The setting is passed on the command line so NAS behavior does not depend on a
user's host-level Codex configuration and does not persist after the container
exits.

## Why not the alternatives

- Adding each `NAS_HOSTEXEC_*` value under
  `shell_environment_policy.set` would couple Codex configuration to the
  current hostexec implementation and could silently omit future variables.
- Embedding broker values in every wrapper would duplicate the approach for
  each integration and would not restore unrelated container environment
  variables.
- Editing the mounted user configuration would persist a session-specific NAS
  policy outside the container lifecycle.
