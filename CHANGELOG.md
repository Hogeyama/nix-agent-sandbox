# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-04-15

### Added

- **UI session launcher**: New Session dialog in the Sessions tab with profile, worktree base branch, working directory, and name selection, backed by `GET /api/launch/info` and `POST /api/launch` endpoints ([1fca123], [95fc5d1], [ad8de8f], [fb9f3ca], [6b7726e], [5f25bd7], [4b4c12d])
- **Terminal search bar**: Ctrl-F/Cmd-F search with next/prev navigation and match count via `@xterm/addon-search`, plus clickable URLs via `@xterm/addon-web-links` ([731eb11])
- **OSC 52 clipboard forwarding**: terminal copy sequences (e.g. Claude Code `/copy`) now reach the browser clipboard via `@xterm/addon-clipboard` ([21ee7ce])

### Changed

- **Breaking:** removed the osc52-clip clipboard shim and tmux detection; dtach persistence makes startup-time `TMUX` env detection unreliable, and X11/Wayland socket mounting will be considered separately ([60e3ef1])
- Routed host `wl-copy`/`wl-paste` through hostexec to enable clipboard access from inside the container ([0e79328])
- Extracted domain services from pipeline stages to enforce the effect-separation rule: `ContainerLaunchService`, `MountSetupService`, `HostExecSetupService`, `DbusProxyService`, `DockerBuildService`, `NetworkRuntimeService`, `EnvoyService` ([03c8529], [526ec5e], [3ee0efa], [69f1a7f], [d5f6809], [0d16ef5])
- `dtachNewSession` accepts an optional `cwd` for spawning sessions from user-selected directories ([4b4c12d])
- Replaced the Deno-based `post-change-checks` skill with a Bun equivalent (fmt/lint/check, `bun test`, tsc) ([6e38d78])

### Fixed

- **hostexec binary-safe I/O**: stdout/stderr are now captured as raw bytes and base64-encoded on the wire, so `wl-paste --type image/png` and other binary payloads are no longer corrupted by UTF-8 replacement ([ea0252c])
- **Git worktree mount and nesting**: `resolveRepository` uses `--git-common-dir` to find the real repo root, the mount stage widens its source when inside a worktree, and probes detect worktrees correctly — fixes missing `.git` access and nested worktree creation ([c5e6a31])
- **Tab double-click rename**: stop mousedown propagation and explicitly focus the rename input so xterm no longer swallows keystrokes ([fc85646])
- **TerminalModal header**: consolidated into a single row (FHD height fix); renaming moved to active-tab double-click ([1152c32])
- Resolve outstanding Biome findings (template literal, unused imports/parameters/suppressions, label htmlFor, dialog Escape-to-close, role annotations on wrapper elements) ([8446e35])

## [0.5.1] - 2026-04-14

### Fixed

- **Terminal modal attach**: new sessions now appear in the modal tab bar in real time and Attach correctly focuses the selected session instead of falling back to the first open session — the `terminal:sessions` SSE event listener was missing from the useSSE hook ([2e9c4b4])

## [0.5.0] - 2026-04-13

### Added

- **dtach-backed session management** for multi-client attach, plus a web terminal powered by xterm.js and browser input forwarding ([44c08b6], [04542f8], [70a6b18])
- **Session naming workflow**: add `--name`, show/edit names in the UI, and track acknowledged user turns ([df05843], [c3f55ff], [30839b5], [4a19325])
- **Terminal UX upgrades**: tabbed sessions, pending-session indicators, attach command copy, right-click copy, and terminal font-size/refit controls ([9545d3d], [e5d161a], [1201bd9], [49b9a55], [d553298])

### Changed

- Worktree management now uses an extracted `GitWorktreeService` and shorter generated branch/worktree names ([c8c7120], [037eab9])
- UI session management was reorganized: split Containers into Sessions and Sidecars, sort Sessions by `started_at`, and simplify status/action presentation ([5a9799f], [7c61138], [478070d], [f6272fe], [bada58c], [f744bf7], [bf8d7f7])
- Devshells now include `dtach` support for the new session attach flow ([546ded9])

### Fixed

- Session attach now preserves `NAS_SESSION_ID` across dtach re-exec ([bddd5d1])
- Terminal stability and rendering: fix focus loss, redraw timing, resize/attach races, invalid resize payloads, and cleanup handling for live sessions ([2e9d07f], [2163528], [89af437], [386d371], [9c6c742], [f1b3ca7], [202b471])
- UI polish: prevent layout shift on session status changes, shrink the name column, and enlarge the terminal modal ([bff6491], [8a03fa0], [e4d4846])
- Worktree branch resolution now supports local branch names with slashes ([ee78096])
- Lint: resolve outstanding Biome findings ([2903e05])

### Documentation

- Document dtach-based session management and capture web terminal status/TODO notes ([725d294], [230d835])

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

[0.5.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hogeyama/nix-agent-sandbox/releases/tag/v0.1.0
