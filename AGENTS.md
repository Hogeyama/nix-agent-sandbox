# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Quick Start Commands

```bash
# Development and testing
bun run test:unit          # Unit only, no Docker — use this while iterating
bun run test               # Full suite (src/ + tests/) — run ONCE as the final check
bun run test:integration   # Integration + e2e only
bun test path/to/file_test.ts         # Single file
bun test --test-name-pattern 'config' # Run specific test pattern
bun run check              # Type check (uses strict mode)

# Building
bun run build-ui           # Build frontend UI
bun run compile            # Build standalone binary (bun build --compile)
```

## Project Overview

**nas** (Nix Agent Sandbox) is a Bun CLI tool that creates isolated Docker environments for running AI agents (Claude Code / GitHub Copilot CLI / OpenAI Codex CLI) with optional Nix integration. It uses a pipeline architecture where each stage modifies a shared execution context (`ExecutionContext`).

## Important Notes

- `bun test src/` is **not** a unit run: `src/` holds `*integration_test.ts` files, some of
  which spawn `docker` at import time even when their tests skip. Use `bun run test:unit`
  while iterating. See `.claude/skills/test-policy/SKILL.md`.
- **`bun run test` runs on the host; every other test command runs in the container.**
  The hostexec rule matches that exact argv (`bun` + `^run test$`) and prompts for
  approval; `bun test <anything>` does not match and stays inside the sandbox. The two
  environments do not agree: a test that needs `docker build` to reach the network can
  only pass on the host, because a DinD build container has no route out (`apt-get`
  resolves nothing, while the base image pull still succeeds through the proxied
  daemon). Such tests carry an `imageBuildable`-style predicate and skip inside the
  sandbox — so a green `bun test src/` there is a smaller claim than a green
  `bun run test`.
- Tests should import from relative paths, not use import maps for internal modules
- Runtime: Bun (migrated from Deno)
- Nix packaging via bun2nix (nix-community/bun2nix) + nix-bundle-elf for standalone binaries
