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

## Result and remaining validation

The automated contract was not executed because the Dev Containers CLI and
fixture image are absent. This is a capability skip, not evidence that the
contract passes or fails. No CLI was installed and no host command was run.

VS Code customizations are declared in the generated fixture so that the same
case can be inspected on a capable machine. Their application remains
unverified. A successful `devcontainer up` does not prove that VS Code applied
`dbaeumer.vscode-eslint` or the `remote.autoForwardPorts` setting to a service
that already existed before attach. That requires opening the fixture with VS
Code Dev Containers and checking the remote extension and setting state.

Until those checks run on a machine with the required tools and fixture, the
automatic startup and attach path remains experimentally unconfirmed. This
capability gap does not block implementation work that is independent of the
attach contract.

An open [VS Code Remote issue](https://github.com/microsoft/vscode-remote-release/issues/11413)
reports that setting `remoteEnv.SSH_AUTH_SOCK` to an empty value does not remove
an SSH agent socket forwarded by the Dev Containers extension. This is a
reported limitation, not behavior verified in this environment. The target VS
Code and extension versions must be tested; no `forwardSSHAgent` setting is
assumed to exist.
