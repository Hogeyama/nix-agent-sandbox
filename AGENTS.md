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

## Important Notes

- Tests should import from relative paths, not use import maps for internal modules
