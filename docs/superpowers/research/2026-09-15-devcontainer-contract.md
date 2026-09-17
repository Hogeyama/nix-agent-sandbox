# Dev Containers startup and attach contract

Date: 2026-09-15

## Contract under test

The proposed nas integration depends on the Dev Containers client running
`initializeCommand` before it selects and attaches to a Compose service. The
command starts that service itself. A second `devcontainer up` must reuse the
same container, and `devcontainer exec` must enter it as the configured
non-root user.

`tests/devcontainer_contract_e2e_test.ts` creates an isolated Compose project
and generated devcontainer configuration under a temporary workspace. Its
initializer starts the service and records the resulting container ID. The
test then compares that marker, the Compose service container, and both CLI
attach results. The fixture image must contain this account before startup:

```text
user: nas-test
uid: 1000
home: /home/nas-test
```

The image name defaults to `nas-devcontainer-contract:latest` and can be
selected with `NAS_DEVCONTAINER_CONTRACT_IMAGE`. The test only uses an image
already present in the local Docker daemon; it does not pull or build one.

## Capability record

Commands were run inside the nas sandbox in the assigned worktree.

| Capability | Probe | Result |
| --- | --- | --- |
| Docker CLI | `command -v docker`; `docker --version` | `/usr/bin/docker`; `Docker version 29.1.3, build 29.1.3-0ubuntu4.1` |
| Docker daemon | `docker image ls` | Available; no local images listed |
| Compose v2 | `docker compose version` | `Docker Compose version 2.40.3+ds1-0ubuntu1` |
| Dev Containers CLI | `command -v devcontainer`; `devcontainer --version` | Not found |
| VS Code CLI | `command -v code`; `code --version` | Not found |
| Contract fixture image | `docker image ls` | Not present |

## NAS result

The automated contract was not executed in the sandbox because the Dev
Containers CLI and fixture image are absent there. This is a capability skip,
not evidence that the contract passes or fails.

The automated test probes prerequisites in dependency order. When the Dev
Containers CLI is unavailable, it records Docker, Compose, and the fixture
image as `not probed` rather than unavailable and does not contact the Docker
daemon. The capability table above records separate manual observations made
during this research; those observations are not synthesized into the test's
runtime predicates.

VS Code customizations are declared in the generated fixture so that the same
case can be inspected on a capable machine. Their application remains
unverified. A successful `devcontainer up` does not prove that VS Code applied
`dbaeumer.vscode-eslint` or the `remote.autoForwardPorts` setting to a service
that already existed before attach. That requires opening the fixture with VS
Code Dev Containers and checking the remote extension and setting state.

## Measured result (2026-09-17)

`tests/devcontainer_contract_e2e_test.ts` was executed on the host and
**passed**: 9 assertions in 12.1 seconds.

| Environment | Version |
| --- | --- |
| Dev Containers CLI | 0.89.0 |
| Docker | 29.6.2 |
| Docker Compose | 5.1.4 |

The fixture image was `nas-devcontainer-contract:latest` with the account
`nas-test`, uid 1000, home `/home/nas-test`.

Four behaviors are now settled:

| Measured | Result |
| --- | --- |
| `initializeCommand` ordering | It runs before attach |
| Attach to an existing Compose service | The client attaches and does not recreate the service |
| A second `devcontainer up` | Reuses the same container; the call is idempotent |
| Identity under `updateRemoteUserUID: false` | Enters as uid 1000 with `HOME=/home/nas-test` |

These four are what the nas lifecycle may rely on. Everything else about the
Dev Containers client remains unverified here.

## Still unmeasured

Neither of the following was exercised by the 2026-09-17 run. Do not record
them as verified.

1. `userEnvProbe: "loginInteractiveShell"`. The environment restoration path
   (`devcontainer-env.sh` plus `/etc/profile.d/nas.sh`) depends entirely on
   VS Code starting a login interactive bash. The fixture does not set this
   option, so the dependency is assumed, not measured.
2. `claudeCode.claudeProcessWrapper`. `devcontainer-claude.sh` assumes the real
   binary arrives as `argv[1]` (`binary=$1`). How the Claude Code extension
   actually invokes the wrapper requires a real VS Code installation with the
   extension, which this run did not use.

## Host follow-up

The host VS Code installation is 1.119.0, and the isolated test profile
contains Dev Containers 0.469.0 and Claude Code 2.1.272. The Compose service
fixture carries the standard identity labels `devcontainer.local_folder` and
`devcontainer.config_file`.

Before those labels were present, both `devcontainer up` calls succeeded but
`devcontainer exec` failed with `Dev container not found`. Inspection of the
bundled CLI showed that its lookup path (`dg()`) requires those labels to find
the existing service. Adding the two labels is what makes the run above pass.

The pass confirms the automated startup, reuse, and CLI exec contract on the
host. It does not confirm that VS Code applied the declared remote extension and
setting customizations to an already running service. No GUI attach has been
performed. SSH and GPG forwarding also remain unverified; source inspection
found no `forwardSSHAgent` flag, and the extension can create forwarding based
on the host environment.

An open [VS Code Remote issue](https://github.com/microsoft/vscode-remote-release/issues/11413)
reports that setting `remoteEnv.SSH_AUTH_SOCK` to an empty value does not remove
an SSH agent socket forwarded by the Dev Containers extension. This is a
reported limitation, not behavior verified in this environment. The target VS
Code and extension versions must be tested; no `forwardSSHAgent` setting is
assumed to exist.
