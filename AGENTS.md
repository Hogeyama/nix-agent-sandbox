# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Quick Start Commands

```bash
# Setup (required on a fresh checkout)
bun install                # Install JS dependencies
bun run vendor             # Populate src/docker/mitmproxy/vendor/ (gitignored;
                           # the mitmproxy addon's python tests skip without it)

# Development and testing
bun run test:unit          # Unit only, no Docker — use this while iterating
bun run test               # Final check inside NAS after implementation changes
hostexec bun run test      # Final check on the host after implementation changes
bun run test:integration   # All component integration + nas e2e tests
bun run test:nas-unit      # nas TS + hostexec + mask-filter unit tests
bun run test:nas-integration # nas integration + tests/ e2e tests
bun run test:vscode-approval # VS Code approval extension tests
bun run test:mitmproxy-addon-unit # Addon unit tests (including Python wrappers)
bun run test:mitmproxy-addon-integration # Addon integration tests
bun run test:masking-unit  # Shared masking and stream unit tests
bun run test:process-supervisor-unit # Shared supervisor and relay unit tests
bun run test:sumi          # sumi unit + black-box tests
bun test path/to/file_test.ts         # Single file
bun test --test-name-pattern 'config' # Run specific test pattern
bun run check              # Type check (uses strict mode)

# Building
bun run build-ui           # Build frontend UI
bun run compile            # Build standalone binary (bun build --compile)
```

## End-of-session Verification

When a session changes executable code, tests, or configuration that affects
runtime or build behavior, run both `bun run test` and `hostexec bun run test`
once before finishing, from the repository root. Run them sequentially, and run
the second even if the first fails. Host execution is part of the requested
verification; do not ask again whether to include it. Report each environment's
result and skips separately. See `skills/post-change-checks/SKILL.md` for details.

Do not run tests merely to answer a question, explain a commit, inspect or review
existing code, or edit documentation or agent instructions. For documentation-
or instruction-only changes, inspect the diff for correctness. Run tests in these
cases only when the user explicitly requests them.

## Project Overview

**nas** (Nix Agent Sandbox) is a Bun CLI tool that creates isolated Docker environments for running AI agents (Claude Code / GitHub Copilot CLI / OpenAI Codex CLI) with optional Nix integration. It uses a pipeline architecture where each stage modifies a shared execution context (`ExecutionContext`).

## Important Notes

- `bun test src/` is **not** a unit run: `src/` holds `*integration_test.ts` files, some of
  which spawn `docker` at import time even when their tests skip. Use `bun run test:unit`
  while iterating. See `.claude/skills/test-policy/SKILL.md`.
- Tests run in the container; `hostexec bun run test` runs the suite on the
  host instead and prompts for approval. The two do not agree: a test whose
  `docker build` has to reach the network cannot pass in a sandbox, because a DinD
  build container has no route out (`apt-get` resolves nothing, while the base image
  pull still succeeds through the proxied daemon). Those cases carry an
  `imageBuildable`-style predicate and skip here, so a green suite inside the sandbox
  is a smaller claim than a green one on the host.
- Tests should import from relative paths, not use import maps for internal modules
- Runtime: Bun (migrated from Deno)
- Nix packaging via bun2nix (nix-community/bun2nix) + nix-bundle-elf for standalone binaries
- Before changing anything under `contrib/strait/`, read
  `contrib/strait/DESIGN.md` (how strait is put together) and
  `contrib/strait/SECURITY.md` (what must hold, which code is trusted, and how
  to verify a change).
