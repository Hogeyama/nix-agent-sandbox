# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-04-13

### Added

- **Effect.ts pipeline architecture**: migrated all stages to `EffectStage` with typed service dependencies (`DockerService`, `FsService`, `ProcessService`, `PromptService`, etc.) ([2d36f7d], [21d6ddc])
- **Session store**: runtime session store wired into pipeline lifecycle ([8e2153f], [8e7652a])
- **Hook notifications**: send `notify-send` on user-turn (attention) with opt-out support ([2d0ea5c])
- **UI: glassmorphism redesign** with infinite-scroll audit tab, server-side filters, and live SSE indicator ([6af13da], [40d7c7f], [0ccc78d])
- **UI: session awareness**: yellow favicon badge and amber tab badge for user-turn containers, row expansion with session details, Turn column ([5b4977d], [d0e74d0], [e870d99], [aef97b0])
- **Audit log in SQLite** instead of JSONL ([5a7d734])
- CLI: filter Copilot hook turn updates ([663a370])
- Stages: bind-mount nas binary into sandbox for agent hooks ([53b087d])

### Changed

- **Breaking:** pipeline execution now uses Effect-based `runPipelineEffect`; old `runPipeline` removed ([68467bf], [5db89e8])
- Route hook notification through HostExec instead of mounting nas binary ([b77f67f])
- Remove redundant `notification` subcommand from `nas hook` ([f0a6755])
- Remove `PlanStage`, `ProceduralStage`, `ResourceEffect` types ([7f57c7a])

### Fixed

- UI: allow multiple container rows to be expanded simultaneously ([a49d467])
- UI: respect `XDG_CACHE_HOME` for daemon state path ([325e686])
- UI: debounce SSE offline flip with a 5s reconnect grace window ([e763ff2])
- Notify: open nas UI on WSL notification click ([1b22b9f])
- Hostexec: defer wrapper activation until agent exec ([f363a76])
- Lint: configure Biome to respect `.gitignore` via VCS integration ([507c0f7])

## [0.3.0] - 2026-04-10

### Added

- `nas worktree list` now shows the base branch each worktree was branched off of ([b8bd152])
- `--format json` output for `nas worktree list`, `nas hostexec pending`, and `nas network pending` ([2a0cdd9])
- `nas container list` subcommand (with optional `--format json`) ([2a0cdd9])
- GitHub Actions test workflows ([403ac8e])

### Fixed

- `hostexec`: resolve relative `argv0` against cwd when matching rules, so commands like `cd backend && ./gradlew ...` match workspace-root-relative rules ([ed1a01d])
- CI: split `test:unit` by file name instead of test name pattern so `*_integration_test.ts` files are reliably excluded ([8484efe])

## [0.2.0] - 2026-04-08

### Changed

- **Breaking:** Worktree directory moved from `.git/nas-worktrees/` to `.nas/worktrees/` ([dc08425])

### Fixed

- Deduplicate docker args caused by ProxyStage ([9ba682e])
- Replace dynamic import of bun with static import in worktree module ([f1840fc])

### Documentation

- Update installation section in README ([f7e2092])

## [0.1.0] - 2026-04-08

Initial release.

### Highlights

- CLI tool for creating isolated Docker environments for AI agents (Claude Code / GitHub Copilot CLI / OpenAI Codex CLI)
- Optional Nix integration with deterministic builds
- Pipeline architecture with composable stages
- Host-exec broker for controlled host access from containers
- Network filtering with allowlist/denylist supporting port-qualified entries
- Web UI for interactive session management
- Worktree support for parallel agent sessions
- Runtime: Bun (migrated from Deno)
- Nix packaging via bun2nix + nix-bundle-elf

[0.4.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hogeyama/nix-agent-sandbox/releases/tag/v0.1.0
