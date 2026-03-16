# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start Commands

```bash
# Development and testing
deno task test             # Run tests: `deno test --allow-all`
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
deno task test tests/config_test.ts # Run specific test file
# Tests use Deno.test() and @std/assert for assertions
```

## Important Notes

- Tests should import from relative paths, not use import maps for internal modules
