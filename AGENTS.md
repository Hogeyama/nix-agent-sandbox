# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start Commands

```bash
# Development and testing
deno task test             # Run all tests
deno task test:unit        # Unit tests only (no Docker needed)
deno task test:integration # Integration tests only (Docker required)
deno task test <pattern>   # Run specific test file, e.g., `deno task test config_test`
deno task lint             # Check code style
deno task fmt              # Format code
deno task check            # Type check (uses strict mode)

# Building
deno task compile          # Build standalone binary
```

## Project Overview

**nas** (Nix Agent Sandbox) is a Deno CLI tool that creates isolated Docker environments for running AI agents (Claude Code / GitHub Copilot CLI / OpenAI Codex CLI) with optional Nix integration. It uses a pipeline architecture where each stage modifies a shared execution context (`ExecutionContext`).

### Pipeline

```
Input: Profile name + agent args
  ↓
WorktreeStage    git worktree 作成（設定時のみ）
  ↓
DockerBuildStage Docker イメージのビルド（キャッシュあり）
  ↓
NixDetectStage   flake.nix の有無を検出
  ↓
MountStage       マウント構成の組み立て
  ↓
DindStage        DinD rootless サイドカー起動（docker.enable 時のみ）
  ↓
ProxyStage       Shared Envoy + auth-router + per-session broker + session network（allowlist=[] かつ prompt.enable=false のときスキップ）
  ↓
LaunchStage      コンテナ起動 → エージェント実行
  ↓
Output: Exit code from agent process
```

## Testing

```bash
deno task test                      # Run all tests
deno task test:unit                 # Unit tests only (no Docker needed)
deno task test:integration          # Integration tests only (Docker required)
deno task test tests/config_test.ts # Run specific test file
# Tests use Deno.test() and @std/assert for assertions
# Test writing guidelines: /test-policy skill
```

## Stage Architecture — Effect Separation Design Rules

Stages come in two kinds: **PlanStage** (default, pure) and **ProceduralStage** (exception, side-effectful).

### PlanStage.plan() is pure

- Input: immutable `StageInput`
- Output: `StagePlan` (data description) or `null` (skip)
- **No** `Deno.env.get`, `Deno.Command`, `Deno.stat`, `Deno.mkdir`, etc.
- Side-effects are expressed as `ResourceEffect[]` in the returned `StagePlan`; the executor runs them

### ProceduralStage is the exception

- `kind: "procedural"` declares side-effects at the type level
- Requires justification (user interaction, action-result branching, etc.)
- Currently only `WorktreeStage`

### Environment resolution

- `HostEnv` is built once at CLI startup (`buildHostEnv()`)
- `ProbeResults` are resolved once before the pipeline (`resolveProbes()`)
- Stages read `input.host` / `input.probes` — never call `Deno.env.get` directly

### Naming conventions for purity

| Prefix | Meaning | Side-effects |
|--------|---------|-------------|
| `build*`, `format*`, `expand*`, `parse*`, `merge*`, `validate*` | Pure computation | **Forbidden** |
| `resolve*` | I/O-based resolution | Allowed (probe resolver / executor) |
| `ensure*` | Create if missing | Allowed (executor) |
| `check*`, `probe*` | Probe | Allowed (probe resolver) |

### Where side-effects are allowed

| Location | Side-effects |
|----------|-------------|
| CLI entry (`cli.ts`) | HostEnv construction, probe resolution, pipeline launch |
| Probe resolver (`host_env.ts`) | FS probe, env read, command execution |
| Effect executor (`effects.ts`) | Docker ops, FS ops, process spawn |
| ProceduralStage.execute() | Unavoidable side-effects (user interaction, etc.) |
| **PlanStage.plan()** | **Forbidden** |
| **build/format/expand helpers** | **Forbidden** |

### No module-level side-effects or mutable state

- Module-level `const`: true constants only
- Module-level `let`: forbidden; use injectable classes for caches

## Important Notes

- Tests should import from relative paths, not use import maps for internal modules
