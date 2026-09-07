# Hostexec Script Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `hostexec.installScript` setting that supplies a safe, session-scoped `./scripts/hostexec` command.

**Architecture:** HostExecStage adds a reserved rule, materializes an embedded script through HostExecSetupService, and overlays it read-only at the container workspace path. HostExecBroker recognizes only that reserved rule and shifts its arguments to the real host command while retaining the original request for approval and audit identity.

**Tech Stack:** Bun, TypeScript, Effect, Pkl, `bun:test`, Docker integration tests.

## Global Constraints

- Read and follow `AGENTS.md`, `skills/effect-separation/SKILL.md`, `skills/security-constraints/SKILL.md`, and `skills/test-policy/SKILL.md` before changing code.
- Stages may call pure planners and intentful services only; filesystem operations belong in HostExecSetupService.
- Never expose the hostexec control socket or mount secrets into the container.
- The script mount is read-only and must not overwrite or shadow an existing workspace path.
- The default is `installScript = false`; existing profiles retain their behavior.
- User rules precede nas internal rules and therefore retain first-match precedence.
- Use Bun tests and keep Docker-dependent coverage in `*integration_test.ts` with capability guards and cleanup.
- Do not modify or commit the user's existing `.nas/config.pkl`, `docs/todo/scratchpad.md`, or `docs/todo/playwright-cli-visible-browser.md` changes.

---

### Task 1: Configuration and session-scoped script setup

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/Schema.pkl`
- Modify: `src/config/load_integration_test.ts`
- Create: `src/hostexec/script.ts`
- Modify: `src/stages/hostexec/setup_service.ts`
- Modify: `src/stages/hostexec/setup_service_test.ts`
- Modify: `src/stages/hostexec/stage.ts`
- Modify: `src/stages/hostexec/stage_test.ts`
- Modify: `src/config/templates/config.pkl`

**Interfaces:**
- Produces: `HostExecConfig.installScript: boolean` with default `false`.
- Produces: exported reserved rule ID and embedded script content from `src/hostexec/script.ts`.
- Produces: `HostExecWorkspacePlan.script?: { runtimePath; workspacePath; content }` handled atomically by `HostExecSetupService.prepareWorkspace`.
- Produces: a read-only script mount and internal rule when enabled.

- [ ] **Step 1: Write failing configuration and planner tests**

Add tests asserting that Pkl defaults `installScript` to false, loads true,
and that `planHostExec` only adds the reserved rule, runtime script plan,
read-only `<workDir>/scripts/hostexec` mount, and LD_PRELOAD intercept path when
enabled. Assert user rules remain before the reserved rule.

- [ ] **Step 2: Run focused tests and verify the missing field/plan failures**

Run: `bun test src/config/load_integration_test.ts src/stages/hostexec/stage_test.ts`

Expected: FAIL because `installScript` and the generated script plan do not exist.

- [ ] **Step 3: Write failing setup-service tests**

Test a temp workspace and runtime root. Assert `prepareWorkspace` writes mode
`0o755`, rejects an existing workspace path without changing it, and removes a
partially created runtime script if a later setup operation fails. Use FsService
or a focused fake consistent with the existing service architecture.

- [ ] **Step 4: Run the setup-service test and verify RED**

Run: `bun test src/stages/hostexec/setup_service_test.ts`

Expected: FAIL because script setup is not implemented.

- [ ] **Step 5: Implement configuration, embedded asset, planner, and setup**

Add `installScript` to both configuration schemas and
`DEFAULT_HOSTEXEC_CONFIG`. Export constants for the reserved rule ID, relative
path, and script content. Extend the setup plan with an optional script intent;
the live service checks the workspace collision, creates the runtime parent,
writes the executable, and cleans it on failure. Extend `planHostExec` to add the
reserved rule after user rules and mount the runtime file read-only at the
workspace script path.

- [ ] **Step 6: Run Task 1 tests and unit suite**

Run: `bun test src/config/load_integration_test.ts src/stages/hostexec/setup_service_test.ts src/stages/hostexec/stage_test.ts`

Then: `bun run test:unit`

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

Commit only Task 1 files with a Conventional Commits message explaining why
the script is runtime-mounted rather than copied into repositories.

### Task 2: Reserved-rule execution and documentation

**Files:**
- Modify: `src/hostexec/broker.ts`
- Modify: `src/hostexec/broker_integration_test.ts`
- Modify: `docs/features/hostexec.md` (or the current hostexec documentation page located by repository search)
- Modify: `docs/todo/scratchpad.md` only if it is tracked and the target item can be changed without including unrelated user edits; otherwise leave it untouched.

**Interfaces:**
- Consumes: reserved rule ID from `src/hostexec/script.ts`.
- Produces: a pure helper that maps `(ruleId, request.argv0, request.args)` to the gateway command or usage error.
- Preserves: request capability and audit identity use the original wrapper argv.

- [ ] **Step 1: Write failing broker tests**

Add focused tests showing the reserved rule launches `args[0]` with
`args.slice(1)`, rejects empty args with exit status 64, and ordinary rules
still launch the original argv0 and args. Assert approval/audit normalization
continues to contain `./scripts/hostexec` and the full payload.

- [ ] **Step 2: Run focused broker tests and verify RED**

Run: `bun test src/hostexec/broker_integration_test.ts --test-name-pattern 'installed hostexec script'`

Expected: FAIL because the broker still launches the wrapper path.

- [ ] **Step 3: Implement narrow command rewriting**

Add a pure command-selection helper and call it only after rule resolution and
approval, immediately before gateway start. Match the exact reserved rule ID;
do not expose rewriting through user configuration. Convert empty invocation
to the wrapper's usage behavior without spawning a process.

- [ ] **Step 4: Document the option**

Document the Pkl snippet, read-only session lifecycle, collision error,
approval semantics, unsafe environment inheritance, and default-disabled
behavior. Do not claim that `hostexec` is on PATH.

- [ ] **Step 5: Run Task 2 tests and full verification**

Run the focused broker test, then `bun run check`, `bun run test:unit`, and once
at the end `bun run test`.

Expected: all applicable checks pass; environment-gated tests may report skips.

- [ ] **Step 6: Commit Task 2**

Commit Task 2 files with a Conventional Commits message explaining why argv
rewriting is restricted to the nas-owned rule.
