# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hogeyama/nix-agent-sandbox/releases/tag/v0.1.0
