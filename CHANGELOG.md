# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`display.sandbox: "xpra"`**: scoped replacement for the removed `display.enable`. Launches a per-session detached xpra X server (Xvfb-backed) and bind-mounts only its Xvfb socket plus a FamilyWild MIT-MAGIC-COOKIE Xauthority into the agent container. nas also auto-starts a host-side seamless-mode `xpra attach :N` viewer (inheriting the nas process's `DISPLAY` / `XAUTHORITY`) so X11 windows drawn by the agent pop up directly on the user's desktop without a manual command; the viewer is scoped to the same lifetime as the X server. Sub-option: `display.size` (default `"1920x1080"`). Requires `xpra` on the host.

### Removed

- **BREAKING: `display.enable` / unscoped X11 socket forwarding has been removed.** The feature bind-mounted `/tmp/.X11-unix` and `~/.Xauthority` into the agent container. X11 has no isolation between clients sharing a display, so any agent granted `display.enable` could record host keystrokes, capture the host screen, inject synthetic keys/mouse events into host apps, and read the host clipboard — none of which can be scoped per-window or per-app. Unlike the other opt-in capabilities in nas (which grant a specific, bounded resource), `display.enable` promoted a full sandbox-escape to a one-line config toggle. Replaced by `display.sandbox: "xpra"` (see Added above), which keeps the agent inside a dedicated, headless virtual X server. Users who specifically want the old unscoped behavior can still assemble it manually with `extra-mounts` (`/tmp/.X11-unix`, `~/.Xauthority`) and `env` (`DISPLAY`, `XAUTHORITY`); doing so surfaces the risk at config-review time.

### Migration

- If your config has `display: { enable: true }`, replace it with `display: { sandbox: "xpra" }` (and optionally `size: "WxH"`). The `enable` key is no longer recognized.

## [0.8.1] - 2026-04-18

### Security

- **UI server now binds to `127.0.0.1` only**: previously the UI daemon listened on `0.0.0.0`, exposing `/api/network/approve`, `/api/hostexec/approve`, and the terminal WebSocket — none of which carry per-caller authentication — to anything that could reach the host's port. Any LAN peer could approve pending broker prompts or attach to a running session ([35ad875])
- **Stop bind-mounting the host's Copilot config/state directories** (`$XDG_CONFIG_HOME/.copilot`, `$XDG_STATE_HOME/.copilot`): on Copilot CLI versions where the auth token lives there, the bind mount let any code inside the sandbox read the host token directly. Tokens now flow through `gh auth token`, brokered via the hostexec `gh` rule. The legacy `~/.copilot` (per-user CLI state without credentials) is still mounted ([a907895])

## [0.8.0] - 2026-04-18

### Added

- **Shell sessions inside agent containers**: open additional shell sessions attached to a running agent container, both via `POST /api/containers/:sessionId/shell` and the new Shell button in the TerminalModal header ([3f92be7], [f6a4992], [8f436f2], [00dfcb0], [9756de3])
- **Kick dtach attachers**: new button in the terminal modal to disconnect other dtach clients ([9bb7474])
- **Persistent UI daemon log**: UI daemon stdout/stderr is now written to a log file for later inspection ([73b8bf5])
- **Recent launch directories** persist across UI sessions ([a3b5398])
- Enlarged terminal modal sized for FHD monitors ([e16ff01])

### Changed

- **Sessions/Pending tab order swapped** in the UI ([1456b9e])
- `nas` options are now placed before the profile argument when launching sessions from the UI ([048eeb4])
- Dtach master and attacher split for session sessions ([d5bc88d])
- Centralized agent container name construction ([ff18f37])
- `FsServiceLive` tryPromise calls now attach catch mappers ([a9b4e96])
- Extra-mount destination conflict detection removed from mount stage ([91ba865])

### Fixed

- UI-launched sessions now resolve a stable `nas` binary path ([85b3d29])
- Strip `NAS_SESSION_ID`/`NAS_INSIDE_DTACH` from env when spawning the UI daemon ([a119d8a])
- Keep a newly opened shell tab selected while waiting for SSE catch-up ([caf0aea])
- Stale shell sockets are cleaned up on container stop/clean and on `dtachNewSession` failure ([441c04b], [cb6a018])

### Documentation

- Added a data-flow diagram ([a1b6479])

## [0.7.0] - 2026-04-17

### Added

- **Localhost port forwarding**: `proxy.forward-ports` config exposes host TCP ports inside the sandbox via an upstream CONNECT tunnel, so agents can reach tools like JVM debuggers on the host ([b2a8d0d], [0aab7c4], [72faf84])
- **LD_PRELOAD hostexec intercept**: new `hostexec_intercept.so` replaces the PATH-wrapper approach, hooking `execvp`/`posix_spawnp` inside the container so relative and bare-name commands dispatch through the broker correctly ([1f81bd9], [b10d22c], [8bb43a0])
- **UTF-8 locales** (`en_US.UTF-8`, `ja_JP.UTF-8`) baked into the sandbox image ([1dd9d1a])
- **Emoji and CJK width rendering** in the web terminal via `@xterm/addon-unicode-graphemes` ([d386bdb])
- **Directory-first New Session dialog**: working directory is picked first and drives the per-cwd profile and base-branch options ([3162ba4], [e32045d])

### Changed

- **Breaking:** AWS CLI and gcloud CLI removed from the sandbox image; install them per-project if needed ([0ab5598])
- **Breaking:** `hostexec` intercept is now LD_PRELOAD-based instead of bind-mounted PATH wrappers — relative paths (`./script.sh`) and bare names resolved inside the container are now matched, and `container` fallback works for non-bare argv0 ([4e0fedc], [f73ceb1], [29ccd74])
- **Pipeline rearchitected around a typed `PipelineState`** with a container plan compiler; every stage was migrated to slice-based inputs (session store, docker build, dind, mount, hostexec, proxy, launch) and tests rewritten against slice contracts. The legacy prior-bag wiring is removed ([24e4a04], [e8e86ba], [7503283], [0cc9a1f], [5d85837], [3fa8eb5], [e3e1fe1], [ec95f75], [312864f], [d609671], [73ed07e], [0da2faa], [0242fe0])
- Removed the "Clean All" button from the Containers tab ([68dae39])

### Fixed

- **Stale sandbox image on proxy asset changes**: docker build now detects changed proxy assets and rebuilds, so proxy fixes ship without manual `--rebuild` ([c78b29a])
- **Audit log pollution**: hide internal `nas hook` entries from the audit tab ([3d8a797])
- **GitHub Copilot CLI hooks**: corrected the hook wiring ([1f1953c])

### Documentation

- Document `proxy.forward-ports` with a JVM-tools example ([42237bd], [0292824])
- Update hostexec docs to describe the LD_PRELOAD intercept ([0e6a80f])

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

[0.7.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hogeyama/nix-agent-sandbox/releases/tag/v0.1.0
