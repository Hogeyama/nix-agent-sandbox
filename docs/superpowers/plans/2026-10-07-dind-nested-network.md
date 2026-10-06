# DinD nested network implementation plan

> For agentic workers: use subagent-driven-development. The user approved automatic integration into the existing nas Bash wrapper and requires help in the generated nas-sandbox skill. Keep changes scoped and leave Git operations to the controller.

**Goal:** Run Testcontainers from a network-isolated Bash invocation without excluding the runner from the sandbox.

**Architecture:** A Unix-only gateway in the nas/DinD network namespace exposes the session Docker API and verifies Docker-published TCP targets. A per-namespace Bash supervisor mirrors those ports and routes Docker API calls through a local Unix endpoint. Existing Bash interception starts it automatically and preserves sumi supervision.

**Tech Stack:** Bun, node:http/node:net, Linux network namespaces, existing shell entrypoint and TypeScript planners, Bun tests, real Docker/bwrap integration.

## Global constraints

- Read `AGENTS.md`, `skills/security-constraints/SKILL.md`, `skills/effect-separation/SKILL.md`, `skills/test-policy/SKILL.md`, and `skills/post-change-checks/SKILL.md`.
- Follow `docs/superpowers/specs/2026-10-07-dind-nested-network-design.md`.
- Keep API operations and TCP forwarding confined to this session's DinD. Never forward arbitrary outer localhost ports, arbitrary addresses, host Docker, or agent credentials.
- No excludedCommands, network sharing, extra capabilities, or user-managed prefix needed.
- Ordinary namespaces and disabled DinD preserve existing behavior. Masking and bridge activation are independent.
- Preserve Bash argv0/arguments, exit status, signals, inherited stdio, sumi masking, hook bypasses, and no duplicate relay within one namespace.
- Initial supported data transport: TCP on IPv4 loopback. Error clearly on unsupported mapping or conflicting listener instead of connecting to a different service.
- Every bridge-owned listener, connection and temporary socket has cleanup on failure as well as success. Non-TTY tool commands use an owned process group and clean up remaining group members. Interactive TTY commands preserve Bash job control and ordinary background-job lifetimes; ending the outer Bash closes its relay but does not promise to terminate jobs Bash leaves running. Explicit signals still reach the supervised shell and its live descendants.
- Root handles the full sequential sandbox/host checks and final commits; workers run focused tests and report exact outcomes.

## Task 1: Gateway and nested Bash supervisor

**Files:** new `src/docker/embed/dind-bridge.mjs` plus focused sibling modules if needed; new `src/docker/dind_bridge_test.ts` and `src/docker/dind_bridge_integration_test.ts`.

**Interfaces:**

```sh
/usr/local/bin/bun /usr/local/lib/nas/dind-bridge.mjs serve \
  --socket /run/nas-dind-bridge/bridge.sock \
  --docker-host tcp://127.0.0.1:2375
/usr/local/bin/bun /usr/local/lib/nas/dind-bridge.mjs run \
  --socket /run/nas-dind-bridge/bridge.sock \
  --base-netns 'net:[1234]' --argv0 /bin/bash -- \
  /tmp/nas-bash-override/bash.real -c 'bun test'
```

`serve` prints `ready` only after the Unix endpoint listens. `run` supervises the command without interpreting its argument vector, uses namespace identity for nesting, installs local API/port forwarding before releasing relevant Docker responses, and returns the command status. Give the controller any required module names and runtime environment markers before integration.

- [x] Use Unix sockets and a fake Docker HTTP API for fast tests. Prove a declared published target works and an unrelated loopback service cannot be selected. Include body/stream preservation, Docker hijacked connections, dynamic ports, immediate connect after API response, stop/removal, refusal on missing gateway, nested namespace markers, bind conflicts, and cleanup.
- [x] Implement bounded framing and backpressure; use the existing port relay's half-close handling as a behavioral reference. Bound memory while streaming request bodies, and bound protocol lines.
- [x] Base mapping validation on live Docker state, not user-provided host/IP. Consider stale mapping and port reuse explicitly; do not treat a port number supplied by the inner client as authorization.
- [x] Add a real Docker/bwrap integration test with independent capability predicates and unique resource names. Demonstrate the direct TCP failure and successful bridge path, including a real request through the mapped port.
- [x] Run `bun test src/docker/dind_bridge_test.ts`; run integration on the authorized host as needed, and write evidence to `/tmp/dind-bridge-runtime-report.md`.

## Task 2: Automatic installation and packaging

**Files:** `src/docker/embed/entrypoint.sh`, `src/docker/embed/Dockerfile`, `src/docker/client.ts`, `src/stages/docker_build/stage.ts`, `src/stages/dind/stage.ts`, relevant colocated tests and launch integration fixtures.

**Interfaces:** Task 1 CLI above. Dind planner adds `NAS_DIND_BRIDGE=1` when the built-in DinD needs the bridge. Entrypoint owns a non-secret runtime directory and records its network namespace; generated Bash wrapper embeds fixed paths and namespace, rather than depending on inherited environment for activation.

- [x] Include every new embedded module in both embedded-asset inventories and the Dockerfile, so image identity changes with implementation.
- [x] Start `serve` as the agent user before agent execution, wait for readiness, and fail startup if enabled bridge cannot initialize. Container teardown closes the outer gateway.
- [x] Install Bash interception when either masking or DinD bridge is enabled. Preserve existing mask-only/disabled cases and fixed hook exceptions. Invoke `run` for a changed namespace; let the helper validate a live inherited bridge before reusing it without another resident supervisor.
- [x] Keep the supervisor inside the existing sumi output supervision when masking is active, while ensuring a namespace change still creates a relay even when SUMI_SUPERVISED is inherited.
- [x] Test mask on/off, DinD on/off, same/different namespace and nested invocation. Run focused entrypoint/planner tests and relevant launch integration tests.

## Task 3: Help, end-to-end verification, and review

**Files:** `src/stages/guide/{facts,content}.ts` and tests; `docs-site/src/content/docs/configuration/{bwrap,development}.md`; `CHANGELOG.md`; spec/plan progress.

- [x] Guide explains automatic support, Unix socket requirements, separate docker.networkScopes, unsupported UDP/reverse connections, how to distinguish Docker API denial from missing port relay, and that disabling the Bash sandbox is not the fix.
- [x] Update the stale Docker limitation in bwrap.md. Apply reader-decision-writing and docs-site/AGENTS.md; publish user-facing behavior rather than internal protocol details.
- [x] Exercise actual Node Testcontainers through bwrap and the installed Bash wrapper, including resource reaper and TCP service. Record prerequisites/skips honestly.
- [x] Review task and whole diff independently. Resolve correctness/security findings and rerun only affected tests after fixes.
- [x] Run fmt, lint, check, docs build, then component-covering suites sequentially in the restricted environment and on the host. Shared image/entrypoint changes warrant the complete aggregate. Preserve logs and report both environments and skips.
- [x] Commit completed changes in coherent units with git-commit, then verify worktree status.
