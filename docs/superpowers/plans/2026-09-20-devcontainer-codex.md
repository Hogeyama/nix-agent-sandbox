# Dev Container Codex Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `nas devcontainer init --profile codex` generate a working Dev Container whose VS Code `openai.chatgpt` extension runs inside the nas-managed container through a wrapper script.

**Architecture:** Mirror the Claude path. The generated `devcontainer.json` points `chatgpt.cliExecutable` at a new container-side wrapper (`nas-devcontainer-codex`) which resolves the extension-bundled codex binary, re-applies the captured nas environment, and execs `codex -c ... app-server ...`. Host `~/.codex` is bind-mounted RW (with `config.toml` RO-overlaid when `protectSettings`); profile `agentArgs` are filtered to `-c`/`--config` pairs on the Compose path only.

**Tech Stack:** Bun, TypeScript (strict), Effect, Docker Compose, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-20-devcontainer-codex-design.md` (committed in this branch).

## Global Constraints

- Bun runtime; `bun run test:unit` while iterating; `bun run test` once at the end; `bun run check` for typecheck/lint.
- Relative imports for internal modules.
- `copilot` stays rejected by `validateDevcontainerProfile`; `init` default profile stays `claude`.
- Host codex binary is NOT mounted (review decision); the wrapper resolves only the extension-bundled binary.
- Codex devcontainer `agentArgs`: only `-c <kv>` / `--config <kv>` pairs (plus joined `-c=...` / `--config=...` forms) pass; everything else is dropped and warned about at `init`.
- Normal (non-devcontainer) CLI launches keep unfiltered `agentArgs` and keep the host-binary mount.
- `~/.codex` is mounted RW; `config.toml` is RO-overlaid only when `profile.agentState.protectSettings` is on.
- Do not weaken `protectSettings` / mask / hostexec fail-closed behaviour.
- Stages stay pure: I/O goes through probes/services, `planMount`/`finalizeDevcontainerPlan` stay pure functions (existing `logWarn` calls in planners are the established exception).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/domain/devcontainer/agent_args.ts` (new) | Pure `filterDevcontainerAgentArgs` |
| `src/domain/devcontainer/policy.ts` | accept `claude`/`codex` |
| `src/domain/devcontainer/config.ts` | agent-specific VS Code customizations |
| `src/domain/devcontainer/disclosure.ts` | agent-specific credentials disclosure + `droppedAgentArgs` on init result |
| `src/domain/devcontainer/lifecycle.ts` | pass agent to render; return dropped args |
| `src/cli/devcontainer.ts` | print dropped-args warning |
| `src/agents/types.ts` | `CodexStatePaths`, `DevcontainerAgentState`, `AgentConfigInput.codexState` |
| `src/agents/codex.ts` | `codexState` devcontainer branch returning structured mounts |
| `src/agents/registry.ts` | forward `codexState` |
| `src/agents/observability.ts` | `devcontainer` flag → `-c` into `extraArgs` |
| `src/stages/mount/mount_probes.ts` | `ensureDevcontainerCodexState`, `ensureDevcontainerAgentState` |
| `src/stages/mount/stage.ts` | `DevcontainerMountInput` generalization |
| `src/stages/mount.ts` | barrel exports |
| `src/devcontainer/runtime.ts` | agent-dispatched state ensure |
| `src/stages/launch/compose_stage.ts` | apply agentArgs filter + warn |
| `src/stages/observability/stage.ts` | forward `devcontainer` dep |
| `src/pipeline/cli_builder.ts` | pass `devcontainer` flag to observability stage |
| `src/docker/embed/devcontainer-codex.sh` (new) | container-side wrapper |
| `src/docker/embed/Dockerfile` | COPY + chmod the wrapper |

---

### Task 1: `filterDevcontainerAgentArgs` pure function

**Files:**
- Create: `src/domain/devcontainer/agent_args.ts`
- Test: `src/domain/devcontainer/agent_args_test.ts`

**Interfaces:**
- Produces: `filterDevcontainerAgentArgs(agent: AgentType, agentArgs: readonly string[]): FilteredDevcontainerAgentArgs` where `FilteredDevcontainerAgentArgs = { readonly kept: readonly string[]; readonly dropped: readonly string[] }`. Consumed by Tasks 4 and 7.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { filterDevcontainerAgentArgs } from "./agent_args.ts";

test("codex keeps -c/--config pairs and drops everything else", () => {
  expect(
    filterDevcontainerAgentArgs("codex", [
      "-c",
      "model=o4-mini",
      "--config",
      "sandbox_mode=workspace-write",
      "--yolo",
      "some prompt text",
    ]),
  ).toEqual({
    kept: [
      "-c",
      "model=o4-mini",
      "--config",
      "sandbox_mode=workspace-write",
    ],
    dropped: ["--yolo", "some prompt text"],
  });
});

test("codex keeps the joined -c=/--config= forms", () => {
  expect(
    filterDevcontainerAgentArgs("codex", [
      "-c=model=o4-mini",
      "--config=sandbox_mode=workspace-write",
      "--full-auto",
    ]),
  ).toEqual({
    kept: ["-c=model=o4-mini", "--config=sandbox_mode=workspace-write"],
    dropped: ["--full-auto"],
  });
});

test("codex drops a dangling -c with no value", () => {
  expect(filterDevcontainerAgentArgs("codex", ["--search", "-c"])).toEqual({
    kept: [],
    dropped: ["--search", "-c"],
  });
});

test("non-codex agents pass every arg through unchanged", () => {
  expect(
    filterDevcontainerAgentArgs("claude", ["--add-dir", "/x", "--yolo"]),
  ).toEqual({ kept: ["--add-dir", "/x", "--yolo"], dropped: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/domain/devcontainer/agent_args_test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```ts
import type { AgentType } from "../../agents/types.ts";

export interface FilteredDevcontainerAgentArgs {
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
}

/**
 * The Codex VS Code extension spawns `codex ... app-server`, not the TUI, so
 * only `-c`/`--config` key=value overrides may reach the launch argv. TUI
 * flags (--yolo, --sandbox, ...) would fail the app-server launch invisibly.
 * The terminal CLI path does not use this filter; see compose_stage.ts.
 */
export function filterDevcontainerAgentArgs(
  agent: AgentType,
  agentArgs: readonly string[],
): FilteredDevcontainerAgentArgs {
  if (agent !== "codex") return { kept: agentArgs, dropped: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let index = 0; index < agentArgs.length; index++) {
    const arg = agentArgs[index];
    if (
      (arg === "-c" || arg === "--config") &&
      index + 1 < agentArgs.length
    ) {
      kept.push(arg, agentArgs[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("-c=") || arg.startsWith("--config=")) {
      kept.push(arg);
      continue;
    }
    dropped.push(arg);
  }
  return { kept, dropped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/domain/devcontainer/agent_args_test.ts`
Expected: 4 pass

- [ ] **Step 5: Commit**

`feat(devcontainer): add agentArgs filter for Codex IDE sessions` — body: why the allowlist (app-server argv, TUI flags fail invisibly) and why the filter lives in domain (shared by init warning and compose planning).

---

### Task 2: Policy accepts `codex`

**Files:**
- Modify: `src/domain/devcontainer/policy.ts:9-10`
- Test: `src/domain/devcontainer/policy_test.ts`

- [ ] **Step 1: Update the failing test + add the new assertions**

Replace the `"non-claude agents are rejected"` test with:

```ts
test("codex is accepted", () => {
  expect(
    validateDevcontainerProfile({
      ...devcontainerProfile(),
      agent: "codex",
    }),
  ).toEqual([]);
});

test("copilot is rejected: no devcontainer launch contract exists for it", () => {
  const errors = validateDevcontainerProfile({
    ...devcontainerProfile(),
    agent: "copilot",
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("claude or codex");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/domain/devcontainer/policy_test.ts`
Expected: FAIL — codex test gets 1 error; copilot test expects "claude or codex" text.

- [ ] **Step 3: Implement**

```ts
  if (profile.agent !== "claude" && profile.agent !== "codex")
    errors.push("agent must be claude or codex for devcontainer sessions");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/domain/devcontainer/policy_test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

`feat(devcontainer): accept codex profiles` — body: codex now has a launch contract (Tasks 3–9); copilot still has none so it stays rejected.

---

### Task 3: Agent-specific `devcontainer.json` customizations

**Files:**
- Modify: `src/domain/devcontainer/config.ts`
- Modify: `src/domain/devcontainer/lifecycle.ts:246-250` (the `renderDevcontainerConfig` call site)
- Test: `src/domain/devcontainer/config_test.ts`

**Interfaces:**
- Produces: `renderDevcontainerConfig(registration, remoteUser, agent: AgentType)` — new third parameter.

- [ ] **Step 1: Write the failing test**

Update `config_test.ts`: pass `"claude"` to the existing call, and add:

```ts
test("codex config points the Codex extension at the nas wrapper", () => {
  const registration = registrationFixture();
  const config = renderDevcontainerConfig(registration, "nas", "codex");
  expect(config.customizations).toEqual({
    vscode: {
      extensions: ["openai.chatgpt"],
      settings: {
        "chatgpt.cliExecutable": "/usr/local/bin/nas-devcontainer-codex",
      },
    },
  });
  // The shared contract fields do not change with the agent.
  expect(config).toMatchObject({
    service: "agent",
    remoteUser: "nas",
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/domain/devcontainer/config_test.ts`
Expected: FAIL (signature mismatch / missing customization)

- [ ] **Step 3: Implement**

`config.ts` — add `import type { AgentType } from "../../agents/types.ts";` and branch the vscode block:

```ts
export function renderDevcontainerConfig(
  registration: DevcontainerRegistration,
  remoteUser: string,
  agent: AgentType,
) {
  return {
    name: "nas",
    initializeCommand: [
      ...registration.command,
      "devcontainer",
      "up",
      "--workspace",
      registration.workspace,
    ],
    dockerComposeFile: [registration.composePath],
    service: "agent",
    workspaceFolder: registration.workspace,
    remoteUser,
    updateRemoteUserUID: false,
    overrideCommand: false,
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
    customizations: {
      vscode:
        agent === "codex"
          ? {
              extensions: ["openai.chatgpt"],
              settings: {
                "chatgpt.cliExecutable":
                  "/usr/local/bin/nas-devcontainer-codex",
              },
            }
          : {
              extensions: ["anthropic.claude-code"],
              settings: {
                "claudeCode.claudeProcessWrapper":
                  "/usr/local/bin/nas-devcontainer-claude",
              },
            },
    },
  };
}
```

`lifecycle.ts` — update the call site:

```ts
      const bytes = `${JSON.stringify(
        renderDevcontainerConfig(
          record,
          host.user.trim() || "nas",
          inputs.profile.agent,
        ),
        null,
        2,
      )}\n`;
```

- [ ] **Step 4: Run tests**

Run: `bun test src/domain/devcontainer/`
Expected: all pass

- [ ] **Step 5: Commit**

`feat(devcontainer): render Codex extension settings for codex profiles` — body: `chatgpt.cliExecutable` is the extension's only executable override; claude customizations unchanged.

---

### Task 4: Agent-specific disclosure + dropped-args warning at `init`

**Files:**
- Modify: `src/domain/devcontainer/disclosure.ts` (init result type + credentials entry)
- Modify: `src/domain/devcontainer/lifecycle.ts` (return `droppedAgentArgs`)
- Modify: `src/cli/devcontainer.ts` (print warning)
- Test: `src/domain/devcontainer/disclosure_test.ts`, `src/cli/devcontainer_test.ts`

**Interfaces:**
- Produces: `DevcontainerInitResult` gains `readonly droppedAgentArgs: readonly string[]` (required field — update every fixture that builds one).

- [ ] **Step 1: Write the failing tests**

In `disclosure_test.ts` (read the file first to match style) add:

```ts
test("codex disclosure names the shared ~/.codex directory", () => {
  const sharing = describeDevcontainerSharing({
    ...devcontainerProfile(),
    agent: "codex",
  });
  const credentials = sharing.find((entry) =>
    entry.topic.includes("credentials"),
  );
  expect(credentials).toEqual({
    topic: "Codex credentials",
    detail: "host ~/.codex, read-write; kept on the host after down",
  });
});
```

In `cli/devcontainer_test.ts` update the fixture `init` result to include `droppedAgentArgs: []`, and add a test where the fake client returns `droppedAgentArgs: ["--yolo"]` asserting the printed output contains `--yolo`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/domain/devcontainer/disclosure_test.ts src/cli/devcontainer_test.ts`
Expected: FAIL (missing field / codex disclosure)

- [ ] **Step 3: Implement**

`disclosure.ts`:

```ts
export interface DevcontainerInitResult {
  readonly registration: DevcontainerRegistration;
  readonly sharing: readonly DevcontainerDisclosure[];
  /**
   * Profile agentArgs the IDE session cannot use (Codex app-server accepts
   * only -c/--config pairs). Surfaced at init, the last point nas is on
   * screen before VS Code takes over.
   */
  readonly droppedAgentArgs: readonly string[];
}
```

In `describeDevcontainerSharing`, replace the credentials entry with:

```ts
    profile.agent === "codex"
      ? {
          topic: "Codex credentials",
          detail: "host ~/.codex, read-write; kept on the host after down",
        }
      : {
          topic: "Claude credentials",
          detail:
            "host ~/.claude and ~/.claude.json, read-write; kept on the host after down",
        },
```

`lifecycle.ts` — in `init`'s return, add `import { filterDevcontainerAgentArgs } from "./agent_args.ts";` and:

```ts
      const filtered = filterDevcontainerAgentArgs(
        inputs.profile.agent,
        inputs.profile.agentArgs,
      );
      return {
        registration: record,
        sharing: describeDevcontainerSharing(inputs.profile),
        droppedAgentArgs: filtered.dropped,
      };
```

`cli/devcontainer.ts` — destructure and print:

```ts
    const { registration, sharing, droppedAgentArgs } = await domain.init(
      command.workspace,
      command.profile,
    );
    console.log(`Created ${registration.configPath}`);
    console.log(`Profile: ${registration.profileName}`);
    printSharing(sharing);
    if (droppedAgentArgs.length > 0) {
      console.log("");
      console.log(
        "Profile agentArgs the Codex IDE session cannot use (only -c/--config pairs are passed):",
      );
      for (const arg of droppedAgentArgs) console.log(`  dropped: ${arg}`);
    }
```

Also update the `init` fixture in `cli/devcontainer_test.ts` to return `droppedAgentArgs: []`.

- [ ] **Step 4: Run tests**

Run: `bun test src/domain/devcontainer/ src/cli/devcontainer_test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

`feat(devcontainer): disclose codex state and warn about dropped agentArgs at init` — body: init is the only point nas is still on screen before the IDE takes over; dropped args would otherwise vanish silently into the detached runtime log.

---

### Task 5: Codex host-state types and `ensure` functions

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/stages/mount/mount_probes.ts` (append at end)
- Modify: `src/stages/mount.ts` (barrel)
- Test: `src/stages/mount/mount_probes_test.ts`

**Interfaces:**
- Produces:
  - `CodexStatePaths = { readonly codexDir: string }` in `src/agents/types.ts`
  - `DevcontainerAgentState = { readonly claudeState?: ClaudeStatePaths; readonly codexState?: CodexStatePaths }` in `src/agents/types.ts`
  - `ensureDevcontainerCodexState(hostHome: string): Promise<CodexStatePaths>`
  - `ensureDevcontainerAgentState(agent: AgentType, hostHome: string): Promise<DevcontainerAgentState>`

- [ ] **Step 1: Write the failing test**

In `mount_probes_test.ts`:

```ts
import {
  ensureDevcontainerAgentState,
  ensureDevcontainerClaudeState,
  ensureDevcontainerCodexState,
} from "./mount_probes.ts";
import { stat } from "node:fs/promises";

test("IDE Codex state is created once with private permissions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-codex-"));
  try {
    const created = await ensureDevcontainerCodexState(home);
    expect(created).toEqual({ codexDir: path.join(home, ".codex") });
    const mode = (await stat(created.codexDir)).mode & 0o777;
    expect(mode).toBe(0o700);

    // Idempotent: a marker inside the state dir survives a second call.
    await writeFile(path.join(created.codexDir, "auth.json"), "{}");
    await ensureDevcontainerCodexState(home);
    expect(
      await readFile(path.join(created.codexDir, "auth.json"), "utf8"),
    ).toBe("{}");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureDevcontainerAgentState dispatches per agent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-state-"));
  try {
    expect(await ensureDevcontainerAgentState("claude", home)).toEqual({
      claudeState: {
        claudeDir: path.join(home, ".claude"),
        claudeJson: path.join(home, ".claude.json"),
      },
    });
    expect(await ensureDevcontainerAgentState("codex", home)).toEqual({
      codexState: { codexDir: path.join(home, ".codex") },
    });
    expect(await ensureDevcontainerAgentState("copilot", home)).toEqual({});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/stages/mount/mount_probes_test.ts`
Expected: FAIL (exports missing)

- [ ] **Step 3: Implement**

`src/agents/types.ts` — after `ClaudeStatePaths`:

```ts
export interface CodexStatePaths {
  readonly codexDir: string;
}

/** Host agent state pre-created for a Dev Container session; at most one member is set. */
export interface DevcontainerAgentState {
  readonly claudeState?: ClaudeStatePaths;
  readonly codexState?: CodexStatePaths;
}
```

and add to `AgentConfigInput`:

```ts
  readonly codexState?: CodexStatePaths;
```

`mount_probes.ts` — extend the import to include `CodexStatePaths`, `DevcontainerAgentState`, `AgentType`, then append:

```ts
/**
 * Host Codex state for an IDE session, created when it does not exist yet.
 * Same contract as ensureDevcontainerClaudeState: Compose refuses to create
 * a missing bind source, so the directory must exist before the first `up`.
 */
export async function ensureDevcontainerCodexState(
  hostHome: string,
): Promise<CodexStatePaths> {
  const codexDir = path.join(hostHome, ".codex");
  await mkdir(codexDir, { recursive: true, mode: 0o700 });
  return { codexDir };
}

/** Agent dispatch for the IDE state ensure; unsupported agents get no state. */
export async function ensureDevcontainerAgentState(
  agent: AgentType,
  hostHome: string,
): Promise<DevcontainerAgentState> {
  switch (agent) {
    case "claude":
      return { claudeState: await ensureDevcontainerClaudeState(hostHome) };
    case "codex":
      return { codexState: await ensureDevcontainerCodexState(hostHome) };
    default:
      return {};
  }
}
```

`src/stages/mount.ts` barrel — change the first export line to:

```ts
export {
  ensureDevcontainerAgentState,
  ensureDevcontainerClaudeState,
  ensureDevcontainerCodexState,
} from "./mount/mount_probes.ts";
```

- [ ] **Step 4: Run test**

Run: `bun test src/stages/mount/mount_probes_test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

`feat(devcontainer): add Codex host state creation for IDE sessions`

---

### Task 6: `DevcontainerMountInput` generalization + `configureCodex` codexState branch + runtime dispatch

**Files:**
- Modify: `src/stages/mount/stage.ts:57-59` and the `configureAgent` call at ~475
- Modify: `src/agents/codex.ts` (input type + branch)
- Modify: `src/agents/registry.ts:58-65` (forward `codexState`)
- Modify: `src/devcontainer/runtime.ts` (agent-dispatched ensure)
- Test: `src/agents/codex_test.ts` (new), `src/stages/mount/stage_test.ts` (reshape `ideMounts`)

**Interfaces:**
- `DevcontainerMountInput` becomes `{ vscodeDir: string } & DevcontainerAgentState` — `claudeDir`/`claudeJson` move under `claudeState`.
- `CodexConfigInput` gains `readonly codexState?: CodexStatePaths`.
- `configureAgent` input (already extended in Task 5) gains `codexState`.

- [ ] **Step 1: Write the failing tests**

New `src/agents/codex_test.ts`:

```ts
import { expect, test } from "bun:test";
import { configureCodex } from "./codex.ts";

const input = {
  containerHome: "/home/nas",
  hostHome: "/host/home",
  probes: {
    codexDirExists: true,
    codexBinPath: "/host/codex",
    codexCodeModeHostBinPath: null,
    codexSettingsFiles: [] as readonly string[],
  },
  protectSettings: true,
  priorDockerArgs: [] as readonly string[],
  priorEnvVars: {},
};

test("dedicated state mounts ~/.codex read-write and never the host binary", () => {
  const result = configureCodex({
    ...input,
    codexState: { codexDir: "/state:$x/codex" },
  });
  // Structured mounts only — colon-bearing paths cannot ride -v strings.
  expect(result.mounts).toEqual([
    { source: "/state:$x/codex", target: "/home/nas/.codex" },
  ]);
  expect(result.dockerArgs).toEqual([]);
  // "codex" keeps canApplyAgentObservabilityConfig true; the Compose path
  // discards agentCommand anyway — the wrapper supplies the real argv.
  expect(result.agentCommand).toEqual(["codex"]);
});

test("protectSettings overlays config.toml read-only on the dedicated state", () => {
  const result = configureCodex({
    ...input,
    probes: { ...input.probes, codexSettingsFiles: ["config.toml"] },
    codexState: { codexDir: "/state:$x/codex" },
  });
  expect(result.mounts).toEqual([
    { source: "/state:$x/codex", target: "/home/nas/.codex" },
    {
      source: "/state:$x/codex/config.toml",
      target: "/home/nas/.codex/config.toml",
      readOnly: true,
    },
  ]);
});

test("protectSettings = false leaves the codex state fully writable", () => {
  const result = configureCodex({
    ...input,
    probes: { ...input.probes, codexSettingsFiles: ["config.toml"] },
    protectSettings: false,
    codexState: { codexDir: "/state:$x/codex" },
  });
  expect(result.mounts).toEqual([
    { source: "/state:$x/codex", target: "/home/nas/.codex" },
  ]);
});

test("normal Codex CLI retains host mounts and the host binary", () => {
  const result = configureCodex(input);
  expect(result.dockerArgs).toEqual([
    "-v",
    "/host/home/.codex:/home/nas/.codex",
    "-v",
    "/host/codex:/usr/local/bin/codex:ro",
  ]);
  expect(result.agentCommand).toEqual([
    "codex",
    "-c",
    "shell_environment_policy.inherit=all",
  ]);
});
```

In `stage_test.ts` reshape `ideMounts` and add a codex case:

```ts
const ideMounts = {
  vscodeDir: "/state:$x/vscode",
  claudeState: {
    claudeDir: "/state:$x/claude",
    claudeJson: "/state:$x/claude.json",
  },
};
```

(update `source: ideMounts.claudeDir` → `source: ideMounts.claudeState.claudeDir` in the existing test) and add:

```ts
test("IDE mounts codex state read-write next to the IDE server dir", () => {
  const { input, mountProbes } = makeInput({
    profile: makeProfile({ agent: "codex" }),
    mountProbes: makeMountProbes({
      agentProbes: {
        codexDirExists: true,
        codexBinPath: "/host/codex",
        codexCodeModeHostBinPath: null,
        codexSettingsFiles: ["config.toml"],
      },
    }),
  });
  const plan = planMount(input, mountProbes, {
    vscodeDir: "/state:$x/vscode",
    codexState: { codexDir: "/state:$x/codex" },
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: "/state:$x/codex",
    target: `${CONTAINER_HOME}/.codex`,
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: "/state:$x/codex/config.toml",
    target: `${CONTAINER_HOME}/.codex/config.toml`,
    readOnly: true,
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: "/state:$x/vscode",
    target: `${CONTAINER_HOME}/.vscode-server`,
  });
  // The host codex binary is deliberately not mounted for IDE sessions.
  expect(plan.dockerArgs.join(" ")).not.toContain("/host/codex");
});
```

Note: `makeProfile` builds `agent: "claude"` by default and merges overrides — `makeProfile({ agent: "codex" })` works. `agentState.protectSettings` defaults true (check `DEFAULT_AGENT_STATE_CONFIG` — if it defaults false, pass `agentState: { protectSettings: true }` in the test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/agents/codex_test.ts src/stages/mount/stage_test.ts`
Expected: FAIL (`codexState` unknown property; `ideMounts` shape mismatch)

- [ ] **Step 3: Implement**

`src/stages/mount/stage.ts`:

```ts
export interface DevcontainerMountInput extends DevcontainerAgentState {
  readonly vscodeDir: string;
}
```

(replace `extends ClaudeStatePaths`; import `DevcontainerAgentState` instead of `ClaudeStatePaths` — `ClaudeStatePaths` import may become unused, remove it if so)

and in the `configureAgent` call:

```ts
    configureAgent({
      claudeState: devcontainer?.claudeState,
      codexState: devcontainer?.codexState,
      agent: profile.agent,
      ...
```

`src/agents/codex.ts` — add `codexState?: CodexStatePaths` to `CodexConfigInput`, import `CodexStatePaths` from `./types.ts` and `settingsMountSpecs` from `./settings_protection.ts`, and add before the `probes.codexDirExists` block:

```ts
  // Dev Container (Compose) path: ~/.codex always mounts — the runtime
  // creates it on the host first — as structured MountSpecs so colon-bearing
  // paths survive. The host codex binary is deliberately not mounted; the
  // devcontainer-codex wrapper execs the extension-bundled binary so the
  // app-server protocol version always matches the extension.
  if (input.codexState) {
    return {
      dockerArgs: args,
      envVars,
      agentCommand: ["codex"],
      mounts: [
        {
          source: input.codexState.codexDir,
          target: `${containerHome}/.codex`,
        },
        ...settingsMountSpecs(
          input.codexState.codexDir,
          `${containerHome}/.codex`,
          input.protectSettings ? probes.codexSettingsFiles : [],
        ),
      ],
    };
  }
```

`src/agents/registry.ts` — in the codex case add `codexState: input.codexState`.

`src/devcontainer/runtime.ts` — replace `ensureDevcontainerClaudeState` import with `ensureDevcontainerAgentState`, and:

```ts
      const agentState = await guard.wait(
        ensureDevcontainerAgentState(options.profile.agent, host.home),
      );
```

return `agentState` in the destructure (rename `claudeState` → `agentState`), and:

```ts
    devcontainerMounts: {
      ...agentState,
      vscodeDir: paths.vscodeDir,
    },
```

- [ ] **Step 4: Run tests**

Run: `bun test src/agents/ src/stages/mount/`
Expected: all pass

- [ ] **Step 5: Commit**

`feat(devcontainer): mount codex state for IDE sessions` — body: structured mounts (colon-safe), host binary deliberately absent per review, protectSettings preserved.

---

### Task 7: Apply the agentArgs filter in `finalizeDevcontainerPlan`

**Files:**
- Modify: `src/stages/launch/compose_stage.ts`
- Test: `src/stages/launch/compose_stage_test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("codex devcontainer keeps only -c pairs from profile agentArgs", () => {
  const codexInput = {
    ...input,
    profile: {
      agent: "codex",
      agentArgs: ["-c", "model=o4-mini", "--yolo", "prompt"],
    },
  } as StageInput;
  const result = finalizeDevcontainerPlan(codexInput, container, {
    registration,
  });
  expect(result.container.command.extraArgs).toEqual([
    "already",
    "-c",
    "model=o4-mini",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/stages/launch/compose_stage_test.ts`
Expected: FAIL — extraArgs include `--yolo`, `prompt`

- [ ] **Step 3: Implement**

In `compose_stage.ts`:

```ts
import { filterDevcontainerAgentArgs } from "../../domain/devcontainer/agent_args.ts";
import { logWarn } from "../../log.ts";

export function finalizeDevcontainerPlan(
  shared: StageInput,
  container: ContainerPlan,
  options: ComposeStageOptions,
) {
  const filtered = filterDevcontainerAgentArgs(
    shared.profile.agent,
    shared.profile.agentArgs,
  );
  if (filtered.dropped.length > 0)
    logWarn(
      `[nas] devcontainer dropped agentArgs the IDE session cannot use: ${filtered.dropped.join(" ")}`,
    );
  const finalized = finalizeLaunchPlan(
    {
      ...shared,
      profile: { ...shared.profile, agentArgs: [...filtered.kept] },
      container,
    },
    options.agentExtraArgs ?? [],
  );
  return {
    ...finalized,
    container: mergeContainerPlan(finalized.container, {
      env: {
        static: {
          NAS_DEVCONTAINER: "true",
          NAS_DEVCONTAINER_ENV_KEYS: [
            ...new Set(finalized.container.env.dynamicOps.map((op) => op.key)),
          ].join(" "),
        },
      },
      labels: {
        "devcontainer.local_folder": options.registration.workspace,
        "devcontainer.config_file": options.registration.configPath,
      },
    }),
  };
}
```

(`finalizeLaunchPlan` input is `StageInput & Pick<PipelineState, "container">` — overriding `profile` and `container` keys via spread works.)

- [ ] **Step 4: Run test**

Run: `bun test src/stages/launch/compose_stage_test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

`feat(devcontainer): filter codex agentArgs to -c pairs on the Compose path` — body: only the Compose path filters; `finalizeLaunchPlan` (terminal CLI) is untouched.

---

### Task 8: Observability `-c` config through `extraArgs` for devcontainer

**Files:**
- Modify: `src/agents/observability.ts` (`BuildAgentObservabilityContainerPatchArgs` + codex branch)
- Modify: `src/stages/observability/stage.ts` (deps + patch args)
- Modify: `src/pipeline/cli_builder.ts` (pass the flag)
- Test: `src/agents/observability_test.ts`

**Interfaces:**
- `BuildAgentObservabilityContainerPatchArgs` gains `readonly devcontainer?: boolean`.
- `ObservabilityStageDeps` gains `readonly devcontainer?: boolean`.

- [ ] **Step 1: Write the failing test**

In `observability_test.ts`:

```ts
test("buildAgentObservabilityContainerPatch: codex devcontainer routes trace config into extraArgs", () => {
  expect(
    buildAgentObservabilityContainerPatch({
      agent: "codex",
      sessionId: "s",
      profileName: "p",
      port: 4318,
      agentCommand: ["codex"],
      extraArgs: ["--existing"],
      devcontainer: true,
    }),
  ).toEqual({
    command: {
      agentCommand: ["codex"],
      extraArgs: [
        "-c",
        'otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/traces",protocol="json"}}',
        "--existing",
      ],
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agents/observability_test.ts`
Expected: FAIL — `devcontainer` arg unknown / extraArgs not prefixed

- [ ] **Step 3: Implement**

`src/agents/observability.ts`:

```ts
export interface BuildAgentObservabilityContainerPatchArgs
  extends BuildObservabilityEnvArgs {
  readonly agentCommand: readonly string[];
  readonly extraArgs: readonly string[];
  /**
   * Dev Container (Compose) sessions discard agentCommand and capture only
   * extraArgs into NAS_AGENT_ARGS, so codex's -c config must ride extraArgs.
   */
  readonly devcontainer?: boolean;
}
```

and in `buildAgentObservabilityContainerPatch` replace the codex branch:

```ts
    ...(args.agent === "codex"
      ? {
          command: args.devcontainer
            ? {
                agentCommand: [...args.agentCommand],
                extraArgs: [
                  "-c",
                  buildCodexTraceExporterConfig({ port: args.port }),
                  ...args.extraArgs,
                ],
              }
            : {
                agentCommand: buildCodexCommand(args.agentCommand, args.port),
                extraArgs: args.extraArgs,
              },
        }
      : {}),
```

`src/stages/observability/stage.ts` — add `readonly devcontainer?: boolean;` to `ObservabilityStageDeps` and `devcontainer: deps.devcontainer` to the `buildAgentObservabilityContainerPatch` call.

`src/pipeline/cli_builder.ts` — in the `createObservabilityStage` call add `devcontainer: devcontainerMounts !== undefined`.

- [ ] **Step 4: Run tests**

Run: `bun test src/agents/observability_test.ts src/stages/observability/`
Expected: all pass

- [ ] **Step 5: Commit**

`fix(devcontainer): route codex OTLP config through extraArgs` — body: Compose discards agentCommand; without this the codex IDE session silently loses trace export.

---

### Task 9: `nas-devcontainer-codex` wrapper + Dockerfile + integration test

**Files:**
- Create: `src/docker/embed/devcontainer-codex.sh`
- Modify: `src/docker/embed/Dockerfile:31` and the chmod list at `:39-41`
- Test: `src/docker/devcontainer_entrypoint_integration_test.ts` (add a second test)

- [ ] **Step 1: Write the wrapper**

```bash
#!/bin/bash
set -euo pipefail

# chatgpt.cliExecutable replaces the spawned executable outright — unlike
# claudeProcessWrapper, no bundled-binary path arrives in "$@". Resolve the
# extension's own codex so the app-server protocol version always matches the
# extension build (the host codex is deliberately not mounted).
shopt -s nullglob
candidates=(
  "$HOME"/.vscode-server/extensions/openai.chatgpt-*/bin/*/codex
  "$HOME"/.vscode-server-insiders/extensions/openai.chatgpt-*/bin/*/codex
)
shopt -u nullglob
executables=()
for candidate in "${candidates[@]:-}"; do
  [ -x "$candidate" ] && executables+=("$candidate")
done
if [ "${#executables[@]}" -eq 0 ]; then
  echo 'nas-devcontainer-codex: no bundled codex found under ~/.vscode-server*/extensions/openai.chatgpt-*' >&2
  exit 64
fi
codex_bin=$(printf '%s\n' "${executables[@]}" | sort -V | tail -n 1)
codex_bin_dir=$(dirname "$codex_bin")

source /usr/local/lib/nas/devcontainer-env.sh
nas_devcontainer_apply
# nas_devcontainer_apply restores the captured baseline PATH, which drops the
# bundled bin dir the extension appended; re-add it so sibling helpers such as
# codex-code-mode-host stay reachable the way the extension intended.
export PATH="$PATH:$codex_bin_dir"

source /usr/local/lib/nas/devcontainer/agent-args.sh
# -c is a global codex option: it is valid ahead of the extension's own
# `-c features.code_mode_host=true app-server` argv. NAS_AGENT_ARGS carries the
# filtered profile args plus the observability -c pairs.
exec "$codex_bin" \
  -c shell_environment_policy.inherit=all \
  "${NAS_AGENT_ARGS[@]}" \
  "$@"
```

- [ ] **Step 2: Update the Dockerfile**

Add after the `devcontainer-claude.sh` COPY:

```
COPY devcontainer-codex.sh /usr/local/bin/nas-devcontainer-codex
```

and add `/usr/local/bin/nas-devcontainer-codex` to the chmod list.

- [ ] **Step 3: Add the integration test**

In `devcontainer_entrypoint_integration_test.ts` add a second `test.skipIf(!imageBuildable)` that:

1. Builds the same fixture image but also COPYs `devcontainer-codex.sh` to `/usr/local/bin/nas-devcontainer-codex` (add the asset to the copied list and the Dockerfile heredoc).
2. Starts the idle container exactly like the existing test.
3. Inside the container, creates a fake bundled codex:

```bash
mkdir -p "$HOME/.vscode-server/extensions/openai.chatgpt-9.9.9/bin/linux-x86_64"
printf '#!/bin/bash\nprintf "%%s\\n" "$@"\n' > "$HOME/.vscode-server/extensions/openai.chatgpt-9.9.9/bin/linux-x86_64/codex"
chmod +x "$HOME/.vscode-server/extensions/openai.chatgpt-9.9.9/bin/linux-x86_64/codex"
```

4. `docker exec` the wrapper as the agent user with `HOME=/home/nas` and assert stdout lines equal:

```
-c
shell_environment_policy.inherit=all
<captured NAS_AGENT_ARGS...>
<args passed to the wrapper, e.g. -c, features.code_mode_host=true, app-server>
```

5. Assert a second `docker exec` with no extension dir returns exit 64 and the stderr message.

Keep the two tests independent — do not refactor the existing test's fixture into a shared helper beyond optionally extracting the image-build step if it stays readable.

- [ ] **Step 4: Run the integration test**

Run: `bun test src/docker/devcontainer_entrypoint_integration_test.ts`
Expected: pass on a host with the fixture image; skip with a clear reason otherwise. Record which happened.

- [ ] **Step 5: Commit**

`feat(devcontainer): add the codex wrapper for the VS Code extension` — body: cliExecutable replaces the executable so the wrapper must resolve the bundled binary itself; bundled-only per review (protocol lockstep with the extension).

---

### Task 10: Final verification

- [ ] **Step 1: `bun run check`** — type check + lint clean.
- [ ] **Step 2: `bun run test:unit`** — all unit tests pass.
- [ ] **Step 3: `bun run test`** — full suite once; note Docker/network-dependent skips separately from failures.
- [ ] **Step 4: Self-review the diff** — `git diff <implementation-base>...HEAD`; confirm: copilot still rejected, claude behaviour unchanged (config test pins it), no host codex mount on the IDE path, docs/spec consistency.
- [ ] **Step 5: Report** — worktree/branch, test results, skips, and whether real VS Code + openai.chatgpt validation was performed (it requires a desktop VS Code; if unavailable, say so explicitly).

---

## Self-Review Notes

- Spec coverage: policy (T2), config render (T3), disclosure+warning (T4), host state (T5), mounts (T6), agentArgs filter (T1+T7), observability (T8), wrapper+image (T9), verification (T10). All spec sections map to a task.
- `DevcontainerInitResult.droppedAgentArgs` is required; every constructor of that type must be updated (cli fixture, lifecycle).
- `AgentConfigInput.codexState` added in Task 5 is consumed in Task 6 — order matters.
- `agentState.protectSettings` default: verify `DEFAULT_AGENT_STATE_CONFIG.protectSettings` before assuming true in the Task 6 stage test.
