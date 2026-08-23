# Hostexec Approval Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the unexplained hostexec capability choice with plain-language approval effects and exact, secret-safe match evidence.

**Architecture:** The broker adds its effective default scope and already-resolved capability identity to each host-only pending entry. The frontend normalizes that additive metadata, derives presentation strings in pure view helpers, and renders approval and denial as visibly independent actions without changing wire semantics.

**Tech Stack:** Bun, strict TypeScript, SolidJS, bun:test, and the hostexec Unix-socket broker.

## Global Constraints

- Read AGENTS.md, docs/todo/ui.md,
  docs/superpowers/specs/2026-08-23-hostexec-approval-card-design.md,
  skills/security-constraints/SKILL.md, skills/test-policy/SKILL.md, and the
  test-driven-development skill before changing code.
- Follow test-driven-development: add each behavior test first, observe the expected failure, then add the smallest implementation.
- Keep once and capability as wire values. Do not change approval grouping, denial semantics, or session lifetime.
- Never expose resolved environment values, secret values, or host environment contents. Metadata may contain variable names and configured sources only.
- Keep control and pending paths host-only; add no mount, socket, or endpoint.
- Preserve old payloads: absent metadata falls back to capability and renders unavailable evidence explicitly.

---

### Task 1: Publish broker-owned approval metadata

**Files:**
- Modify: src/hostexec/types.ts:13-31
- Modify: src/hostexec/broker.ts:824-842, 880-897, 1485-1504
- Test: src/hostexec/broker_integration_test.ts:2224-2282

**Interfaces:**
- Produces: HostExecPendingEntry.defaultScope?: HostExecPromptScope.
- Produces: HostExecPendingEntry.capability?: ResolvedExecutionCapability with no resolved environment values.
- Consumes: HostExecBroker.config.prompt.defaultScope and ResolvedExecution.capability.

- [ ] **Step 1: Write the failing integration assertion**

In the existing “defaultScope once used” test, read the entry after waitForPendingEntries:

    const [pending] = await listHostExecPendingEntries(paths);
    expect(pending?.defaultScope).toBe("once");
    expect(pending?.capability).toEqual({
      ruleId: "node-eval",
      argv0: "node",
      normalizedArgv: ["node", "-e", "console.log('first')"],
      normalizedCwd: workspace,
      envBindings: [],
      inheritEnv: { mode: "minimal", keys: [] },
    });

- [ ] **Step 2: Run the focused test and verify RED**

    bun test src/hostexec/broker_integration_test.ts --test-name-pattern "defaultScope once used"

Expected: FAIL because both metadata fields are absent.

- [ ] **Step 3: Extend the additive contract**

Import HostExecPromptScope as a type and add to HostExecPendingEntry:

    defaultScope?: HostExecPromptScope;
    capability?: ResolvedExecutionCapability;

They remain optional because version-1 entries may already exist on disk. New broker entries populate both.

- [ ] **Step 4: Populate both broker paths**

Extend toPendingEntry with defaultScope: HostExecPromptScope and include:

    defaultScope,
    capability: structuredClone(resolved.capability),

Pass this.config.prompt.defaultScope at both call sites. Never copy resolved.envVars.

- [ ] **Step 5: Verify GREEN and regressions**

    bun test src/hostexec/broker_integration_test.ts --test-name-pattern "defaultScope once used"
    bun test src/hostexec/broker_integration_test.ts

Expected: the focused test and full broker test file pass.

- [ ] **Step 6: Commit**

    git add src/hostexec/types.ts src/hostexec/broker.ts src/hostexec/broker_integration_test.ts
    git commit -m "feat(hostexec): describe pending approval identity"

### Task 2: Normalize metadata and define plain-language views

**Files:**
- Modify: src/ui/frontend/src/stores/types.ts:121-130
- Modify: src/ui/frontend/src/stores/pendingStore.ts:86-101, 164-176
- Test: src/ui/frontend/src/stores/pendingStore_test.ts:260-350
- Modify: src/ui/frontend/src/components/pendingCardView.ts
- Test: src/ui/frontend/src/components/pendingCardView_test.ts

**Interfaces:**
- Consumes: optional defaultScope and capability from Task 1.
- Produces: HostExecPendingRow.defaultScope, ruleId, cwd, and capability.
- Produces: hostExecScopeLabel, hostExecApprovalEffect, and hostExecMatchDetails.

- [ ] **Step 1: Write failing store tests**

Test a payload containing:

    const capability = {
      ruleId: "git.push",
      argv0: "git",
      normalizedArgv: ["git", "push", "origin", "main"],
      normalizedCwd: "/workspace",
      envBindings: [{ key: "GITHUB_TOKEN", source: "secret:github" }],
      inheritEnv: { mode: "minimal" as const, keys: ["SSH_AUTH_SOCK"] },
    };

Expect the normalized row to preserve ruleId, cwd, defaultScope: "once", and capability.

Test an old payload separately:

    expect(row?.defaultScope).toBe("capability");
    expect(row?.ruleId).toBeNull();
    expect(row?.cwd).toBeNull();
    expect(row?.capability).toBeNull();

- [ ] **Step 2: Run store tests and verify RED**

    bun test src/ui/frontend/src/stores/pendingStore_test.ts

Expected: FAIL because hostexec normalization discards the fields.

- [ ] **Step 3: Add frontend types and normalization**

Define HostExecCapabilityLike with ruleId, argv0, normalizedArgv, normalizedCwd, envBindings of key/source, and inheritEnv mode/keys. Add optional ruleId, defaultScope, and capability to HostExecPendingItemLike.

Extend HostExecPendingRow and normalize:

    defaultScope: it.defaultScope === "once" ? "once" : "capability",
    ruleId: it.ruleId ?? it.capability?.ruleId ?? null,
    cwd: it.cwd ?? it.capability?.normalizedCwd ?? null,
    capability: it.capability ?? null,

- [ ] **Step 4: Run store tests and verify GREEN**

    bun test src/ui/frontend/src/stores/pendingStore_test.ts

Expected: all tests pass.

- [ ] **Step 5: Write failing pure-view tests**

Assert:

    expect(hostExecScopeLabel("once")).toBe("This request only");
    expect(hostExecScopeLabel("capability")).toBe(
      "Matching command for this session",
    );
    expect(hostExecScopeLabel("capability")).not.toContain("capability");
    expect(hostExecApprovalEffect("once")).toBe(
      "Approves this request only. Nothing is remembered.",
    );
    expect(hostExecApprovalEffect("capability")).toContain(
      "future requests in this session",
    );

For the capability fixture, expect details:

    [
      { label: "Rule", value: "git.push" },
      { label: "Command", value: "\"git\" \"push\" \"origin\" \"main\"" },
      { label: "Working directory", value: "/workspace" },
      { label: "Environment bindings", value: "GITHUB_TOKEN ← secret:github" },
      { label: "Inherited environment", value: "minimal; SSH_AUTH_SOCK" },
    ]

Also test that old payload evidence says “not reported” instead of inventing data.

- [ ] **Step 6: Run view tests and verify RED**

    bun test src/ui/frontend/src/components/pendingCardView_test.ts

Expected: FAIL because the helpers do not exist.

- [ ] **Step 7: Implement pure view helpers**

Define HostExecApprovalScope as once | capability. hostExecScopeLabel returns the two approved labels. hostExecApprovalEffect returns:

    once:
    "Approves this request only. Nothing is remembered."

    capability:
    "Approves all requests waiting on these exact conditions and remembers them for future requests in this session."

hostExecMatchDetails JSON-quotes each argv item, formats bindings as key ← source, uses “none” for known-empty lists, and “not reported” for absent metadata. It accepts no resolved value field.

- [ ] **Step 8: Verify GREEN and commit**

    bun test src/ui/frontend/src/components/pendingCardView_test.ts src/ui/frontend/src/stores/pendingStore_test.ts
    git add src/ui/frontend/src/stores/types.ts src/ui/frontend/src/stores/pendingStore.ts src/ui/frontend/src/stores/pendingStore_test.ts src/ui/frontend/src/components/pendingCardView.ts src/ui/frontend/src/components/pendingCardView_test.ts
    git commit -m "feat(ui): explain hostexec approval scopes"

Expected: both test files pass before committing.

### Task 3: Separate approval scope from request-only denial

**Files:**
- Modify: src/ui/frontend/src/components/PendingPane.tsx:1-19, 407-470
- Modify: src/ui/frontend/src/styles.css:1760-1850
- Modify: docs/todo/ui.md:3-18, 69-98, 230-243
- Test: src/ui/frontend/src/components/pendingCardView_test.ts

**Interfaces:**
- Consumes: Task 2 row metadata and view helpers.
- Preserves: onApprove(row, once | capability) and scope-free onDeny(row).

- [ ] **Step 1: Add a failing Deny copy guard**

    expect(HOSTEXEC_DENY_LABEL).toBe("Deny this request only");
    expect(HOSTEXEC_DENY_LABEL).not.toContain("scope");

- [ ] **Step 2: Run the copy test and verify RED**

    bun test src/ui/frontend/src/components/pendingCardView_test.ts --test-name-pattern "Deny"

Expected: FAIL because the constant is absent.

- [ ] **Step 3: Add copy and restructure hostexec JSX**

Export:

    export const HOSTEXEC_DENY_LABEL = "Deny this request only";

Then:

- initialize scope from props.scopeFor(row.key) ?? row.defaultScope;
- render hostExecMatchDetails(row) as five labeled rows;
- group the buttons, effect text, and Approve under “Approve scope”;
- use human labels and aria-pressed while passing unchanged wire values;
- place Deny separately with HOSTEXEC_DENY_LABEL;
- leave onClick={() => props.onDeny(row)} unchanged;
- remove PendingPane’s dependency on DEFAULT_HOSTEXEC_SCOPE.

- [ ] **Step 4: Add narrow-pane styles**

Add hostexec-only classes:

    .hostexec-match { display: grid; gap: 5px; margin: 0 0 10px; }
    .hostexec-match-row {
      display: grid;
      grid-template-columns: minmax(0, 0.45fr) minmax(0, 1fr);
      gap: 8px;
      font-size: 10px;
    }
    .hostexec-match-row dt,
    .hostexec-match-row dd {
      min-width: 0;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .hostexec-scope-row {
      flex-direction: column;
      border-bottom: 0;
      padding-bottom: 0;
    }
    .hostexec-scope {
      width: 100%;
      text-align: left;
      text-transform: none;
      letter-spacing: 0.02em;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .hostexec-approve,
    .hostexec-deny {
      border-top: 1px dashed var(--line);
      padding-top: 10px;
    }
    .hostexec-deny { margin-top: 10px; }

Long IDs, paths, names, and sources must wrap within a 240px pane.

- [ ] **Step 5: Verify frontend behavior**

    bun test src/ui/frontend/src/components/pendingCardView_test.ts src/ui/frontend/src/stores/pendingStore_test.ts src/ui/frontend/src/handlers/createPendingActionHandlers_test.ts
    bun run check

Expected: all tests and strict typing pass; the handler regression still proves Deny sends no scope.

- [ ] **Step 6: Update docs and commit**

Move the hostexec mismatch in docs/todo/ui.md into the implemented summary. Record the labels, broker default, evidence, old-payload fallback, and request-only Deny. Do not promote held items.

    git add src/ui/frontend/src/components/PendingPane.tsx src/ui/frontend/src/components/pendingCardView.ts src/ui/frontend/src/components/pendingCardView_test.ts src/ui/frontend/src/styles.css docs/todo/ui.md
    git commit -m "fix(ui): make hostexec approval effects explicit"

### Task 4: Run repository verification

**Files:**
- Verify only; formatter changes must be amended into their owning task.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: fresh format, lint, type, and test evidence.

- [ ] **Step 1: Run standard checks in order**

    bun run fmt
    bun run lint
    bun run check
    bun test

Expected: every command exits 0 with zero failures. Stop on failure. If manual hostexec approval is unavailable, run bun run test:unit, do not bypass policy, and report the full suite as not run.

- [ ] **Step 2: Inspect final scope**

    git status --short
    git diff HEAD~3 --check
    git log --oneline -4

Expected: no uncommitted implementation changes, no whitespace errors, and three implementation commits after the design and plan commits.
