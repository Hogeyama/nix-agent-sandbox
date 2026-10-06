# DinD proxy isolation implementation plan

> For agentic workers: use subagent-driven-development. Preserve concurrent bwrap changes. Git metadata is read-only, so deliver working-tree changes without commits.

## Global constraints
- Same session, distinct agent and dind tokens; verified token selects policy.
- DinD never inherits agent scopes, cached approvals, or automatic agent credentials.
- docker.networkScopes uses existing Scope semantics, defaults empty; unmatched deny; review rejected at all policy locations.
- Both local addon inspection and broker use the selected policy, including colliding rule IDs.
- Stages orchestrate services; services own I/O. Preserve existing unrelated modifications.

## Task 1: Runtime identity and policy isolation
Read /tmp/dind-runtime-brief.md. Extend registry, protocol, immutable broker policy contexts, addon authentication/document routing, proxy lifecycle, and DinD endpoint selection. Add focused regression tests for leaked tokens and policy collision. Review implementation before completing.

## Task 2: Configuration and documented pull policy
Add optional TS/empty Pkl docker.networkScopes, a shared resolver that rejects review, validation, Docker Hub pull preset, tests, and migration documentation. Preserve default deny and explicit secret injection.

## Task 3: Verification and final review
Inspect complete change against security and Effect constraints. Run formatting/lint/type checks and full `bun run test`, then `hostexec bun run test` sequentially even if sandbox fails. Report environments and skips separately. Fix introduced issues and inspect final diff.

## Documentation intent
The development page serves users enabling Docker for tests. They need to add an explicit pull scope, know why their prior network.scopes no longer permits pulls, and verify docker pull after starting a new session. Keep token/protocol internals in the design document; explain only permission and credential behavior affecting configuration here.

## Progress
- Configuration/resolver implemented; dedicated resolver 7 tests pass. Config validation + Pkl integration 147 tests pass, including Docker Hub preset allow/deny cases.
- Runtime implementation delegated; final checks pending.
- Whole-change and CONNECT fix reviews approved. Final config tests 155 pass. fmt/lint/type checks and docs build pass.
- Full restricted run: 6/14 suites pass, 8 fail due environment restrictions. Full host run: 13/14 pass, new CONNECT403 regression identified and corrected. Final complete addon unit/integration rerun: 23+23 pass, no skips. Detailed verification /tmp/dind-verification.md.
