---
name: effect-separation
description: Stage Architecture — Effect Separation Design Rules. Use when adding new stages, modifying existing stages, creating helper functions, or refactoring pipeline code. Always consult when touching stages/, pipeline/, or agents/ directories, or when design questions arise about where to place side-effects.
---

# Effect Separation Design Rules

The pipeline consists of two stage kinds: **PlanStage** (pure, default) and **ProceduralStage** (side-effectful, exception). When writing new stages or helpers, follow these rules to determine where side-effects belong.

## PlanStage — The Default Choice

```typescript
export interface PlanStage {
  kind: "plan";
  name: string;
  plan(input: StageInput): StagePlan | null;
}
```

- `plan()` is a **pure function**. Takes `StageInput`, returns `StagePlan` (dockerArgs, envVars, effects, etc.) or `null` (skip).
- No `Deno.env.get`, `Deno.Command`, `Deno.stat`, `Deno.mkdir`, or any I/O.
- Side-effects are described as `ResourceEffect[]` data; the executor runs them.

Typical pattern (from `createMountStage`):
```typescript
export function createMountStage(mountProbes: MountProbes): PlanStage {
  return {
    kind: "plan",
    name: "MountStage",
    plan(input: StageInput): StagePlan {
      return planMount(input, mountProbes);  // calls a pure function
    },
  };
}
```

When I/O is needed, resolve it as a probe beforehand and pass via factory argument or `input.probes`.

## ProceduralStage — The Exception

```typescript
export interface ProceduralStage {
  kind: "procedural";
  name: string;
  execute(input: StageInput): Promise<ProceduralResult>;
  teardown?(input: StageInput): Promise<void>;
}
```

- `kind: "procedural"` declares side-effects at the type level.
- Only for cases where plan/execute separation is impossible: user interaction, action-result branching, etc.
- Requires justification. Currently only `WorktreeStage` uses this.

## Environment Resolution

- `HostEnv`: built once at CLI startup via `buildHostEnv()`.
- `ProbeResults`: resolved once before the pipeline via `resolveProbes()`.
- Stages read `input.host` / `input.probes` — never call `Deno.env.get` directly.

## Naming Conventions for Purity

| Prefix | Meaning | Side-effects |
|---|---|---|
| `build*`, `format*`, `expand*`, `parse*`, `merge*`, `validate*` | Pure computation | **Forbidden** |
| `resolve*` | I/O-based resolution | Allowed (probe resolver / executor) |
| `ensure*` | Create if missing | Allowed (executor) |
| `check*`, `probe*` | Probe | Allowed (probe resolver) |

A function's name signals whether it may have side-effects. If you name it `build*`, it must be pure.

## Where Side-Effects Are Allowed

| Location | Role |
|---|---|
| CLI entry (`cli.ts`) | HostEnv construction, probe resolution, pipeline launch |
| Probe resolver (`host_env.ts`, `mount_probes.ts`, `agents/*.ts` の `resolve*Probes`) | FS probe, env read, command execution |
| Effect executor (`effects/`) | Docker ops, FS ops, process spawn |
| `ProceduralStage.execute()` | Unavoidable side-effects (user interaction, etc.) |
| **`PlanStage.plan()`** | **Forbidden** |
| **`configure*()` (agents)** | **Forbidden** |
| **`build*/format*/expand*` helpers** | **Forbidden** |

## Module-Level Constraints

- Module-level `const`: true constants only (literals, regexes, etc.).
- Module-level `let`: forbidden. Use injectable classes for caches.
- Module-level side-effects (file reads, env access, etc.): forbidden.

## Agent Configuration (`agents/`)

Agent files (`agents/claude.ts`, `agents/copilot.ts`, `agents/codex.ts`) follow the same probe/pure-configurator split:

```typescript
// 1. Probe types — plain data
export interface ClaudeProbes {
  readonly claudeDirExists: boolean;
  readonly claudeBinPath: string | null;
}

// 2. Resolver — side-effectful, called once at CLI startup
export function resolveClaudeProbes(hostHome: string): ClaudeProbes { ... }

// 3. Pure configurator — no I/O, called from PlanStage.plan()
export function configureClaude(input: ClaudeConfigInput): AgentConfigResult { ... }
```

Rules:
- `resolve*Probes()` — I/O allowed. Called from `resolveMountProbes()` before the pipeline starts.
- `configure*()` — **pure**. Receives pre-resolved probes via input, returns docker args / env vars / agent command.
- Environment variables must come from `HostEnv` (passed as argument), not from `Deno.env.get()` directly.

## Design Decision Flowchart

When adding new functionality:

1. **Need a stage?** — If adding Docker args, env vars, or effects, use PlanStage.
2. **Need I/O?** — Move it outside `plan()`. Pre-resolve as a probe, or describe as `ResourceEffect` for the executor.
3. **Can't separate plan/execute?** — Only if user interaction or result-dependent branching is required, consider ProceduralStage. Document the justification.
4. **Adding/modifying an agent?** — I/O goes in `resolve*Probes()`, pure logic in `configure*()`.
5. **Naming helpers** — Pure: `build*/format*/expand*`. I/O: `resolve*/ensure*/check*`.
