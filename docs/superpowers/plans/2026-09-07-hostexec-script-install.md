# Hostexec Command Installation Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent setup and broker tasks, followed by automated review. Human review gates were explicitly waived by the user.

**Goal:** Provide `hostexec` on the container PATH through `hostexec.installScript = true`.

**Architecture:** Embed `src/hostexec/hostexec` as the single source, write it into the session wrapper bin directory, and use the existing read-only mount. The broker unwraps payload argv only at the configured installed path, after authorization. Installation supplies a default prompt rule, following explicit user policies.

**Tech Stack:** Bun, TypeScript, Effect, Pkl.

## Global Constraints

- Follow AGENTS.md and the effect-separation, security-constraints, and test-policy skills.
- No workspace runtime mounts or generated repository files.
- Remove `scripts/hostexec` without a compatibility symlink.
- Installation supplies a prompt rule with the host environment. Preserve user rule order and precedence.
- Expose neither secrets nor the control socket to the container.
- Keep full original request argv for authorization fingerprints and audit.
- Preserve other user changes in `.nas/config.pkl` and unrelated files.

### Task 1: Configuration, asset, and setup lifecycle

- [x] Add Pkl/TypeScript `installScript`, default false; test actual Pkl loading.
- [x] Import the canonical executable as text and verify compiled embedding.
- [x] Install the executable in `<wrapperRoot>/bin/hostexec`; skip the ordinary client symlink for that name while enabled.
- [x] Add `/opt/nas/hostexec/bin/hostexec` to interceptor paths and expose it to the broker as `installedScriptPath?: string`. Do not include the container-only path in host integrity targets.
- [x] Own script cleanup through an Effect handle; cover successful close, setup failure, and broker-start failure. No workspace collision logic is needed.
- [x] Update planner/setup tests and config comments; run focused tests and type checking.

### Task 2: Authorized payload execution

- [x] Forward `installedScriptPath?: string` through HostExecBrokerService to HostExecBroker.
- [x] Resolve user rules or the default prompt rule before unwrapping the installed path's payload.
- [x] Strip one optional `--` and preserve argument boundaries. Other executable paths keep ordinary behavior.
- [x] Handle empty/help invocation through local script fallback after authorization where applicable. Deny still returns an error.
- [x] Exempt only the installed path from host-file integrity lookup; retain user rule integrity elsewhere.
- [x] Test with the real broker protocol: match/no-match, prompt/allow/deny, help/empty, argv boundaries, disabled behavior, and original request identity.

### Task 3: Documentation and verification

- [x] Document one-setting installation without user rules, a host-clipboard example, and existing deny/no-match behavior in the HostExec feature page.
- [x] Review the full change for security, correctness, lifecycle, and test coverage; fix findings.
- [x] Run formatting, lint/type checks, unit tests, and relevant broker/compiled asset checks. Run the full suite once as the final repository check; clearly report any environmental failures or skips.
- [x] Commit only the task's changes and report the working option plus verification results.

### Review corrections

- [x] Make installation usable without rules; test prompt defaults, help, exact-path matching, and user-denial precedence.
- [x] Cover PATH-search entry points and spawn fallback with native regressions.
- [x] Verify changes, review the complete diff, and prepare the feature fixup.
