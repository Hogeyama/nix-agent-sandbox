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
- Tests run in the container; `./scripts/hostexec bun run test` runs the suite on the
  host instead and prompts for approval. The two do not agree: a test whose
  `docker build` has to reach the network cannot pass in a sandbox, because a DinD
  build container has no route out (`apt-get` resolves nothing, while the base image
  pull still succeeds through the proxied daemon). Those cases carry an
  `imageBuildable`-style predicate and skip here, so a green suite inside the sandbox
  is a smaller claim than a green one on the host.
- Tests should import from relative paths, not use import maps for internal modules
- Runtime: Bun (migrated from Deno)
- Nix packaging via bun2nix (nix-community/bun2nix) + nix-bundle-elf for standalone binaries
