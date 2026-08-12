# Codex Code Mode Host Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Code Mode available in nas sandboxes by mounting the version-matched `codex-code-mode-host` sibling executable.

**Architecture:** Extend the side-effectful Codex probe to resolve an executable sibling beside the selected `codex` binary, then pass that nullable path into the pure Codex configurator. The configurator adds one read-only Docker bind mount when the helper is available and otherwise preserves the existing launch behavior.

**Tech Stack:** Bun, TypeScript, `bun:test`, Node filesystem APIs, Docker CLI argument construction

## Global Constraints

- Read and follow `AGENTS.md`, `skills/effect-separation/SKILL.md`, `skills/test-policy/SKILL.md`, and `skills/post-change-checks/SKILL.md` before changing code.
- Keep host filesystem inspection in `resolveCodexProbes()` or its private helpers; keep `configureCodex()` pure.
- Resolve `codex-code-mode-host` only beside the real path of the selected `codex` executable; do not search for it independently through `PATH`.
- Mount the helper read-only at exactly `/usr/local/bin/codex-code-mode-host`.
- When the sibling is missing, unreadable, not a regular file, or not executable, return `null`, launch Codex as before, and do not alter the user's Codex feature configuration.
- Tests must import repository code through relative paths and must follow the red-green-refactor cycle.
- Runtime and test runner are Bun.

---

### Task 1: Detect and mount the Codex Code Mode host

**Files:**

- Modify: `src/agents/codex.ts`
- Modify: `src/agents/registry.ts`
- Test: `src/agents/agents_integration_test.ts`
- Test fixture update: `src/stages/mount/stage_test.ts`

**Interfaces:**

- Consumes: the resolved host-side `codex` executable path returned by `findBinaryResolved("codex")`.
- Produces: `CodexProbes.codexCodeModeHostBinPath: string | null` and, when non-null, the Docker mount `<host path>:/usr/local/bin/codex-code-mode-host:ro`.

- [ ] **Step 1: Add failing configurator and probe regression tests**

Change `withFakeBinary()` so its callback can create a sibling in the same temporary directory:

```ts
async function withFakeBinary(
  name: string,
  fn: (tmpBinDir: string) => Promise<void> | void,
): Promise<void> {
  const origPath = process.env.PATH;
  const tmpBinDir = await mkdtemp(path.join(tmpdir(), "nas-test-bin-"));
  try {
    await writeFile(`${tmpBinDir}/${name}`, "#!/bin/sh\nexit 0\n");
    await chmod(`${tmpBinDir}/${name}`, 0o755);
    process.env.PATH = `${tmpBinDir}:${origPath ?? ""}`;
    await fn(tmpBinDir);
  } finally {
    if (origPath !== undefined) process.env.PATH = origPath;
    else delete process.env.PATH;
    await rm(tmpBinDir, { recursive: true, force: true }).catch(() => {});
  }
}
```

Add this pure configurator regression test:

```ts
test("configureCodex: mounts detected code-mode host read-only", () => {
  const probes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: "/opt/codex/bin/codex",
    codexCodeModeHostBinPath: "/opt/codex/bin/codex-code-mode-host",
  };
  const result = configureCodex({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: ["--existing"],
    priorEnvVars: {},
  });

  expect(result.dockerArgs).toContain("--existing");
  expect(result.dockerArgs).toContain(
    "/opt/codex/bin/codex-code-mode-host:/usr/local/bin/codex-code-mode-host:ro",
  );
});
```

Add these probe regression tests:

```ts
test("resolveCodexProbes: finds executable code-mode host beside codex", async () => {
  await withFakeBinary("codex", async (tmpBinDir) => {
    const helperPath = `${tmpBinDir}/codex-code-mode-host`;
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n");
    await chmod(helperPath, 0o755);

    const probes = resolveCodexProbes("/tmp");

    expect(probes.codexCodeModeHostBinPath).toEqual(helperPath);
  });
});

test("resolveCodexProbes: ignores missing code-mode host", async () => {
  await withFakeBinary("codex", () => {
    const probes = resolveCodexProbes("/tmp");
    expect(probes.codexCodeModeHostBinPath).toEqual(null);
  });
});

test("resolveCodexProbes: ignores non-executable code-mode host", async () => {
  await withFakeBinary("codex", async (tmpBinDir) => {
    const helperPath = `${tmpBinDir}/codex-code-mode-host`;
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n");
    await chmod(helperPath, 0o644);

    const probes = resolveCodexProbes("/tmp");

    expect(probes.codexCodeModeHostBinPath).toEqual(null);
  });
});
```

Add `codexCodeModeHostBinPath: null` to every other explicit `CodexProbes` fixture in `src/agents/agents_integration_test.ts` and `src/stages/mount/stage_test.ts`, including the inline Codex probe passed to `configureAgent()`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
bun test src/agents/agents_integration_test.ts
```

Expected: the new configurator test fails because no helper mount is present, and the new probe assertions fail because `codexCodeModeHostBinPath` is not yet returned.

- [ ] **Step 3: Implement the minimal sibling probe and mount**

In `src/agents/codex.ts`, import the path API and extend the probe contract:

```ts
import path from "node:path";

export interface CodexProbes {
  readonly codexDirExists: boolean;
  readonly codexBinPath: string | null;
  readonly codexCodeModeHostBinPath: string | null;
}
```

Resolve the Codex binary once and derive the sibling probe from it:

```ts
export function resolveCodexProbes(hostHome: string): CodexProbes {
  const codexBinPath = findBinaryResolved("codex");
  return {
    codexDirExists: dirExistsSync(`${hostHome}/.codex`),
    codexBinPath,
    codexCodeModeHostBinPath: findSiblingExecutableResolved(
      codexBinPath,
      "codex-code-mode-host",
    ),
  };
}
```

Add the private sibling resolver:

```ts
function findSiblingExecutableResolved(
  executablePath: string | null,
  siblingName: string,
): string | null {
  if (!executablePath) return null;
  try {
    const fs = require("node:fs");
    const siblingPath = fs.realpathSync(
      path.join(path.dirname(executablePath), siblingName),
    );
    if (!fs.statSync(siblingPath).isFile()) return null;
    fs.accessSync(siblingPath, fs.constants.X_OK);
    return siblingPath;
  } catch {
    return null;
  }
}
```

Append the helper mount in `configureCodex()` immediately after the existing Codex binary mount:

```ts
if (probes.codexCodeModeHostBinPath) {
  args.push(
    "-v",
    `${probes.codexCodeModeHostBinPath}:/usr/local/bin/codex-code-mode-host:ro`,
  );
}
```

Update `expectCodexProbes()` in `src/agents/registry.ts` so the runtime shape check includes the new field:

```ts
function expectCodexProbes(probes: AgentProbes): CodexProbes {
  if (
    "codexDirExists" in probes &&
    "codexBinPath" in probes &&
    "codexCodeModeHostBinPath" in probes
  ) {
    return probes;
  }
  throw new Error("Agent probe mismatch: expected codex probes");
}
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```bash
bun test src/agents/agents_integration_test.ts src/stages/mount/stage_test.ts
```

Expected: both files pass, including the three sibling-resolution cases and the exact helper bind mount assertion.

- [ ] **Step 5: Run repository post-change checks**

Run these commands in order, stopping on the first failure:

```bash
bun run fmt
bun run lint
bun run check
bun test
```

Expected: formatting completes without leaving unintended changes; lint, all TypeScript checks, and the complete test suite pass.

- [ ] **Step 6: Inspect the final diff and commit**

Run:

```bash
git diff --check
git diff -- src/agents/codex.ts src/agents/registry.ts src/agents/agents_integration_test.ts src/stages/mount/stage_test.ts
```

Confirm the diff contains only the new Codex helper probe, mount, runtime shape check, fixture updates, and regression tests. Then commit:

```bash
git add src/agents/codex.ts src/agents/registry.ts src/agents/agents_integration_test.ts src/stages/mount/stage_test.ts
git commit -m "fix(codex): mount code-mode host in sandbox"
```
