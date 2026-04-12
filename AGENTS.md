# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Quick Start Commands

```bash
# Development and testing
bun test                   # Run all tests
bun test src/              # Unit tests only (no Docker needed)
bun test tests/            # Integration/e2e tests (Docker required)
bun test --test-name-pattern 'config' # Run specific test pattern
bun run check              # Type check (uses strict mode)

# Building
bun run build-ui           # Build frontend UI
bun run compile            # Build standalone binary (bun build --compile)
```

## Project Overview

**nas** (Nix Agent Sandbox) is a Bun CLI tool that creates isolated Docker environments for running AI agents (Claude Code / GitHub Copilot CLI / OpenAI Codex CLI) with optional Nix integration. It uses a pipeline architecture where each stage modifies a shared execution context (`ExecutionContext`).

## Important Notes

- Tests should import from relative paths, not use import maps for internal modules
- Runtime: Bun (migrated from Deno)
- Nix packaging via bun2nix (nix-community/bun2nix) + nix-bundle-elf for standalone binaries
