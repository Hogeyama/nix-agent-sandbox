# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Profiles**: `extraAgents` makes more agents usable inside a session without launching them, for example `extraAgents { "claude" }` on a Codex profile so Codex can run `claude -p`. Each listed agent gets its host binary and state directory the same way `agent` does; `agentArgs`, observability, and the Claude guide apply only to the launched agent. Dev Container profiles reject `extraAgents` for now.

### Changed

- **Claude credentials**: `agentState.auth` now defaults to `"proxy"` for Claude. The host `~/.claude/.credentials.json` is no longer mounted into the container; the container sees a dummy credentials file, and nas's network proxy injects the host's access token into requests to `api.anthropic.com` and `mcp-proxy.anthropic.com`. Profiles that use an API key (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`) must set `agentState.auth = "shared"` to keep sharing the credentials file.
  - Known limitation: config validation only detects `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in `env`. Profiles that use Bedrock (`CLAUDE_CODE_USE_BEDROCK`), Vertex (`CLAUDE_CODE_USE_VERTEX`), an `apiKeyHelper`, or a gateway via `ANTHROPIC_BASE_URL` are not detected; set `agentState.auth = "shared"` for them.
  - Known limitation: with `"proxy"`, the container's `~/.claude` is a session-private directory into which each existing host entry is mounted. Entries that exist on the host at session start are read-write and kept on the host; top-level entries that Claude creates in the container during a session (for example `plugins/` from a first `/plugin install`) are not created on the host and are discarded when the session ends.
  - OAuth tokens for MCP servers, which Claude Code keeps in the same file, are copied into the dummy file when the session starts, so OAuth-authenticated MCP servers keep working in the container. Changes made in the container are not written back: an MCP login done there is lost when the session ends, and a refresh done there can invalidate the host's token for an MCP server that rotates refresh tokens. Tokens for MCP authorization through an enterprise IdP (cross-app access) are not copied; set `agentState.auth = "shared"` to use them.
  - Known limitation: this keeps the credentials file out of the container, not every route to the credentials. With `agentState.protectSettings` off (the default), the container can still write `~/.claude/settings.json`, whose hooks run on the host the next time Claude starts there. Turn `protectSettings` on to close that route.
- **Codex credentials**: `agentState.auth` now defaults to `"proxy"` for Codex, as it does for Claude. The container no longer sees the ChatGPT OAuth tokens in the host `~/.codex/auth.json`; it sees a dummy `auth.json` over the shared `~/.codex`, and nas's network proxy injects the host's access token and account id into requests to `chatgpt.com` under `/backend-api/` (other `chatgpt.com` paths get no credentials; `/backend-api/` also serves ChatGPT's own account APIs, which allowed requests reach with the host token). nas refreshes the token on the host. Profiles that use an API key (`OPENAI_API_KEY` / `CODEX_API_KEY`) or keep Codex credentials in the keyring must set `agentState.auth = "shared"`. Dev Container Codex sessions keep `"shared"`.
  - If the host `~/.codex/auth.json` is removed or replaced while a session runs (for example by `codex logout`), nas kills that session's container without a grace period, or does not launch it when the session is still starting. A replacement by rename leaves the new file readable in the container until the kill lands.
  - Known limitation: as for Claude, this keeps the token file out of the container, not every route to the tokens. `~/.codex` stays shared read-write, so with `agentState.protectSettings` off (the default) the container can still write `~/.codex/config.toml`, which declares commands, MCP servers and model providers that the host Codex uses. Turn `protectSettings` on to close that route.
  - Config validation cannot tell a Dev Container session from a terminal one, so it applies the terminal default. A Dev Container Codex profile with a static `OPENAI_API_KEY` or `CODEX_API_KEY` in `env` is rejected unless it sets `agentState.auth = "shared"`, even though Dev Container Codex sessions share credentials anyway.
- **extraAgents**: `agentState.auth` now applies to agents listed in `extraAgents` too, so a Claude provisioned next to Codex also gets proxied credentials by default.
- **Config**: `agentState.auth` also accepts a per-agent Mapping, for example `auth = new Mapping { ["codex"] = "shared" }`. Agents not listed keep their default; the string form still applies to every agent. This lets a Claude profile with `extraAgents { "codex" }` share only Codex's credentials (for an API key or the keyring) while Claude's stay on the host. An explicit `"proxy"` for Copilot in the Mapping is a config error.

### Fixed

- **Container**: agent containers (`docker run`, ACP and Dev Container) and the DinD sidecar start with Docker's `--init`, so `docker-init` is PID 1 and reaps orphaned processes. Before, the agent (or `rootlesskit` in the sidecar) was PID 1 and did not reap them, so they stayed as zombies until the session ended: exited `git`, shells and `nas-mask-filter` in the agent container, and the `containerd-shim` of each finished inner container in the sidecar.
- **HostExec / Network**: a session no longer fails or loses its broker when runtime cleanup runs while it starts. Cleanup, which the UI and the `nas hostexec` / `nas network` commands run when listing or answering pending requests, removed the session's broker directory before the session was registered. HostExec startup then failed with `nas-hostexec-gateway: failed (FileNotFound)`, and a network session started with its approval socket deleted, so approvals could not reach it.

### Removed

- **HostExec**: `HostExecRule.fallback` has been removed. It never had any effect: a request no rule matches always falls back to running in the container. Configs that still set it fail to load with "Cannot find property `fallback`"; delete the line. The legacy YAML/JSON migration drops it automatically.

### Security

- **Upstream TLS is verified**: the shared mitmproxy no longer runs with `--ssl-insecure`. Upstream certificates are checked against the image's certifi bundle and the requested host name, so injected credentials can no longer be read by someone intercepting the proxy's upstream connection. A proxy container started by an older nas is recreated. **Breaking:** HTTPS through a TLS-intercepting corporate network, or to services with self-signed or private-CA certificates, now fails with 502 `Certificate verify failed`, and there is no setting to override it.
- **Mask filter**: `mask.filter` masks command output again in sessions with `direnv.enable = true`. Since v0.16.0, `direnv exec` loaded the environment, and evaluated any `.envrc`, in a bash run through the mask wrapper. That bash ran under `nas-mask-filter`'s supervisor, which marks its child with `NAS_MASK_SUPERVISED=1`, and direnv passed the marker on to the agent as part of the loaded environment. Every bash the agent started then took the marker to mean a filter was already running, and skipped it. No filter was running, so command output, including secrets, reached the agent unmasked, without an error or a warning. Dev Container sessions, which load the environment through the same launcher, were affected too. The launcher now keeps the marker's value from when it started and discards the one picked up inside `direnv exec`.
- **Network**: `inject` headers, including user-configured ones and the proxied Claude/Codex credentials, are added only when the request leaves the proxy over TLS. A plain `http://` request, or plaintext HTTP sent inside a CONNECT tunnel to `:443`, is still allowed but goes out without them and is logged as `INJECT-SKIPPED-PLAINTEXT`. `removeHeaders` still applies to every request.
- **Network**: an allowed host name that resolves to a private, loopback, link-local, CGNAT or unspecified address (the ranges already refused as IP literals) is refused with 502. The proxy resolves the name itself after the request is authorized, drops such answers, and connects to the first remaining address, so a name cannot be rebound to one between the check and the connect. The proxy log records each refusal as `DNS-BLOCKED`. **Breaking:** internal services on private addresses, such as a company API at `10.x`, can no longer be reached through the proxy, and there is no setting to allow them. This includes host services allowed as `host.docker.internal:<port>`, which resolves to the Docker host gateway; reach them with a Remote port forward instead.
- **Container**: agent containers (`docker run`, ACP and Dev Container) start with `no-new-privileges` and drop every Linux capability except `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID` and `KILL`, which the entrypoint needs before it switches to the host user and while it supervises the initial port relay. When the host user is root, the agent keeps only those six capabilities, so it can no longer ping or bind ports below 1024.
- **Workspace**: the workspace's git config, hooks directory (including the target of `core.hooksPath`), `config.worktree` and a linked worktree's `.git` pointer file are mounted read-only, so an agent cannot edit them to plant a hook or a git setting that later runs on the host. Every directory between the workspace root and a read-only path, `.nas` included, is pinned as a mount point so it cannot be renamed away with the protected file inside. **Breaking:** commands that write `.git/config` inside the container, such as `git config`, `git remote add`, `git push -u` or `checkout -b` with tracking, now fail; run them on the host or through hostexec. A missing `.git/hooks` is created empty on the host.
- **Workspace**: `.git/commondir`, and the `commondir` of each linked worktree, are mounted read-only too. Git reads this file in any repository, not only in linked worktrees, and takes the config and hooks from the directory it names, so an agent could otherwise bypass the read-only config and hooks by writing one. When the file is missing, nas creates it on the host containing `./`, which git treats the same as no file and libgit2 (used by Nix flakes) still opens, and leaves it in place after the session.
  - Known limitation: the read-only mounts cover the git metadata nas knows to protect, not the working tree. A nested repository that the index records as a submodule still has its own config, which a host `git status` reads when it checks that submodule.
- **HostExec**: approval prompts, pending lists and audit logs show the command that actually runs on the host (for a bare-name rule, the host `PATH` command) instead of the path the container requested, and the approval key and the spawned command use that same value.
- **HostExec**: an `approval = "allow"` rule with `argRegex` no longer auto-approves a request that has an empty argument or one containing whitespace, because the space-joined string it matches cannot show where arguments start and end. Such requests ask for approval, or are denied when prompts are disabled. `argRegex` stays an unanchored match; anchor allow rules with `^…$`.
- **HostExec**: `file:`, `dotenv:` and `lines:` secret sources refuse well-known credential stores under HOME (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, git and gh credentials, the Claude and Codex logins) and nas's own state and runtime directories, and are checked again after resolving symlinks. Use `cmd:` to extract a single value from such a file.
- **HostExec**: `inheritEnv.mode = "unsafe-inherit-all"` no longer passes `NAS_*` variables or proxy variables whose URL contains credentials. The built-in `hostexec <cmd>` rule uses this mode, so an authenticated corporate proxy must now be listed in `inheritEnv.keys` to reach host commands.
- **DinD**: the sidecar's Docker API listens only on `127.0.0.1:2375`. Containers started inside DinD could previously reach it at the sidecar's session-network address, their bridge gateway and the slirp4netns address.
- **Brokers**: every JSON line read on the network broker and hostexec control sockets is size-capped (48 MiB and 64 KiB). An oversized or malformed message closes that connection instead of crashing the host process, and a broker message of unknown type is dropped instead of being answered as `list_pending`.

## [0.19.1] - 2026-09-24

### Added

- **Distribution**: the bundled binary now includes `dtach`, so it no longer has to be installed on the host. The Nix package uses the same `dtach`.
- **Distribution**: releases carry the license and copyright notices of every bundled component, in `licenses/` next to `nas` and under `share/nas/assets/licenses` after extraction. Each release adds a `-sources.tar.gz` asset with the sources nas provides directly (nas, dtach, glibc, libfuse, TinyCC, and others) and the pinned upstream revisions for Bun and Pkl, a `-components.json` inventory, and a `-sha256.txt` checksum list. [docs/release-materials.md](docs/release-materials.md) explains how to find a component's source, rebuild with a modified JavaScriptCore, and replace an extracted shared library.

### Changed

- **direnv**: `direnv.enable` now defaults to `true`. A workspace `.envrc` that is allowed on the host is loaded on session start without any profile setting; one that is not allowed still refuses to launch. Set `direnv { enable = false }` on a profile to skip project environments.

### Fixed

- **Bundled binary**: the maskfs helper now runs on hosts without Nix. It previously depended on the Nix store's loader and libfuse; it now uses the libraries in the bundle.
- **Config**: the generated `.nas/config.pkl` no longer fails to load when the user's `global.pkl` lacks a `claude` or `codex` profile. The generated file keeps only the `amends` line active and leaves the profile block as a commented example.
- **Network**: the approval proxy starts on hosts whose primary group is absent from the mitmproxy image (for example gid 1001), instead of exiting with `usermod: group '<gid>' does not exist`.

## [0.19.0] - 2026-09-20

### Added

- **Dev Container Codex**: `nas devcontainer init --profile codex` generates a `.devcontainer` that installs the `openai.chatgpt` extension and points its `chatgpt.cliExecutable` at an in-container wrapper, which resolves the extension-bundled `codex` binary and re-applies the nas environment (env ops, hostexec, observability `-c` config) before launching the app-server. Host `~/.codex` is shared read-write, with `config.toml` overlaid read-only when `agentState.protectSettings` is on, and `up` refuses to start when the profile's agent changed since `init`. Profile `agentArgs` are filtered to `-c`/`--config` key=value pairs for the app-server launch, and dropped args are reported at `init`. Note: `chatgpt.cliExecutable` is a development-only extension hook, so extension updates may change the contract.
- **Network**: authorize GraphQL requests by exact field path instead of root field or owner alone. Fragments are expanded and aliases ignored when forming paths, and argument requirements bind to each field occurrence so an owner on one field can't satisfy another's restriction. Body-level GraphQL conditions are validated at startup and enforced consistently across rule matching, approval and the mitmproxy addon, with approval identities scoped to the specific path/argument combination so approving one value doesn't cover another.

### Changed

- **Distribution**: standalone maskfs binaries are now released separately under `maskfs-v*` tags, with a stable `maskfs-latest` download URL. nas releases no longer include a separate maskfs archive; nas still bundles the maskfs engine it needs.

### Fixed

- **Network**: restore port bind/forward operation under Bun 1.4, including resuming paused relay sockets and cancelling a pending stream when the client disconnects.
- **HostExec**: report gateway socket resets as disconnects consistently instead of exposing a raw `ECONNRESET` error.

- **Agents**: protect Claude plugins, skills and hook programs from being modified by a session, not just its settings files. A private writable state root now layers read-only host configuration under writable credentials, history and project state, closing a gap where the shared host state directory left plugin/skill/hook code writable.
- **Dev Container**: IDE sessions now share the same host mounts as a plain CLI launch — `~/.config/git` (git identity, aliases, signing) is mounted, and a linked worktree gets the main repository root instead of just its own directory. Fixes missing git config in IDE sessions and worktrees outside the repo root failing to start under MaskFs.
- **Nix build**: `nix run` / the packaged `nas` binary segfaulted on startup under WSL2 (worked on native Linux). Bun 1.3.12–1.3.13's `bun build --compile` output added a `.bun` ELF segment by repurposing `PT_GNU_STACK` into its own `PT_LOAD` ([oven-sh/bun#29963](https://github.com/oven-sh/bun/issues/29963)); WSL2's kernel maps that layout without the trailing page actually backed, and Bun segfaults dereferencing it on startup, before any user code runs. Bump the pinned `nixpkgs` input to pull in `bun` 1.4.2, which carries upstream's fix ([oven-sh/bun#29967](https://github.com/oven-sh/bun/pull/29967)).

## [0.18.0] - 2026-09-18

### Added

- **Dev Container**: `nas devcontainer init/up/status/down`. `init` generates a `.devcontainer` whose `initializeCommand` runs `nas devcontainer up`, so opening the folder in VS Code prepares the sandbox (approval proxy, hostexec broker, maskfs, port relays) and the IDE attaches to the Compose service. Nix-enabled profiles are supported, and `init` discloses what the container will share on the user's behalf. Approvals can be answered inside the attached window with the separately released [vscode-nas-approval](contrib/vscode-nas-approval/CHANGELOG.md) extension.
- **Dev Container Docker**: accept `docker.enable = true` for devcontainer sessions. The agent container joins the session-scoped rootless DinD sidecar's network namespace via Compose `network_mode: container:` and shares the DinD temp volume, so Docker and Testcontainers work over `tcp://127.0.0.1:2375` the same way as in normal CLI sessions.
- **ACP**: `mode = "acp"` on a Claude profile launches Claude through an ACP adapter taken from the container PATH, keeping the profile's credentials, mounts and network policy. Preparation is cancelled when the client disconnects, and a session's Docker resources are reaped even when the client SIGKILLs nas. See [ACP](docs-site/src/content/docs/configuration/acp.md).
- **Approvals**: `nas network watch` and `nas hostexec watch` stream pending approval arrivals and departures as JSON Lines, using the same payload as `pending --format json`. `--session` narrows `watch`, `pending` and `review` to one session, and a session-scoped `watch` exits when that session ends; `--write-session-id <path>` tells a spawning client which id nas generated. See [approvals](docs-site/src/content/docs/work/approvals.md).
- **HostExec**: the structured pending payload carries capability metadata and `createdAt`.
- **Network**: the anthropic preset allows the Claude Code endpoints that used to fall to review when a session started (`/api/oauth/usage`, `/api/oauth/profile`, `/api/oauth/account/settings`, `/api/claude_code_grove`, org referral / model-selector endpoints, `/api/eval/*`, and `/api/event_logging/v2/batch`). The audit log records the concrete request path of each decision, including scope-fallback ones.
- **Agent settings**: add `agentState.protectSettings`, which mounts the host agent settings files read-only over the writable state directory — `~/.claude/settings.json` and `settings.local.json`, `~/.codex/config.toml`, `~/.copilot/config.json` and `mcp-config.json`. They declare hooks and MCP servers that run on the host, so an agent that rewrote them could run code on the host the next time the user started that agent outside the container. Off by default: tools that write these files from inside the container, such as VS Code extensions, fail against the read-only files. `~/.claude.json` is not covered: Claude rewrites it while running. See [the host credentials guide](docs-site/src/content/docs/configuration/authentication.md).

### Changed

- **Breaking — host credentials**: remove `gcloud.mountConfig`, `aws.mountConfig`, and `gpg.forwardAgent`. Each gave the agent access to a host credential store: the cloud config directories were bound read-write, and the forwarded gpg-agent socket let the agent sign and decrypt with the host's keys. Inject the credential where it is used — secrets with a network scope, or a hostexec rule for the CLI — or bind the single path you need through `extraMounts` with `mode = "ro"`. Configs that still set them fail to load, naming the replacement.
- **sumi**: release and version sumi separately under `sumi-v*` tags, starting at `sumi-v0.1.0`; nas releases no longer attach sumi binaries. See the [sumi changelog](contrib/sumi/CHANGELOG.md).

## [0.17.0] - 2026-09-14

### Added

- **sumi**: automatically mask URL-encoded and base64 variants of registered secrets, including embedded values and 76-column base64 wrapping. Pattern expansion is bounded and fails closed when its limits are exceeded. See the [supported formats and limitations](contrib/sumi/README.md).

### Changed

- **direnv**: cache container dev shells with a pinned nix-direnv installation so repeated workspace launches can reuse evaluations.
- **sumi documentation**: refresh validation results for shell prefix masking, HTTP tool failures, and stdio MCP connection limitations.

## [0.16.0] - 2026-09-12

### Changed

- **Breaking — network and secrets**: replace `reviewRules` and `credentials` with named scopes, rules, and secrets; select masking inputs with `mask.apply`. See the [migration guide](docs/migration/network-scopes.md).
- **Breaking — project environments**: remove `nix.extraPackages` and automatic devShell loading. Use `.envrc`, enable `direnv.enable`, and approve it on the host with `direnv allow`.
- **Breaking — Docker**: reject `docker.shared = true` when Docker is enabled; use isolated per-session daemons with a shared public Docker Hub pull cache.

### Added

- **Network**: scoped request/body validation, secret masking and injection, explicit WebSocket permissions, and SSRF/DNS-rebinding defenses.
- **Ports**: bidirectional forwarding through `nas network bind -L/-R` and the UI. Configure `localForwards` / `remoteForwards`; legacy `proxy.forwardPorts` remains supported with a [migration warning](docs/migration/port-forwarding.md).
- **Masking**: stream shell and hostexec output through `mask.filter`; add [sumi](contrib/sumi/README.md), a standalone Claude Code masking tool distributed for x86_64 and aarch64 Linux.
- **HostExec**: session-scoped `hostexec` command with streaming output and preserved stdin.
- **UI and docs**: clearer approvals and cross-session notifications, clipboard Markdown review, and a searchable user guide.

### Fixed

- Preserve Codex shell environments; improve hostexec execution integrity, stdin handling, and disconnect cleanup.
- Fix JVM proxy trust and Testcontainers port access; improve startup speed, live output latency, and audit storage limits.

## [0.15.2] - 2026-07-03

### Fixed

- **MaskFS**: stop bundling `fusermount3` in the standalone nix-bundle-elf distribution — the extracted copy can never carry the setuid bit, so it shadowed the host's setuid `fusermount3` on PATH and every unprivileged mount failed with EPERM. The bundle now falls back to the host binary (fuse3 package), and the standalone wrapper fails fast with a clear error when `fusermount3` is missing ([b2526a0e])

## [0.15.1] - 2026-07-03

### Fixed

- **MaskFS**: set `FUSE_USE_VERSION` to 317 to match actual >= 3.17 requirement; add comptime size assertion on `FuseFileInfo` to catch ABI drift on FUSE upgrades; eliminate per-read `mmap`/`munmap` syscalls by pre-allocating static buffers for `xRead` and `fdContainsSecret` hot paths ([b9d1dabe])

## [0.15.0] - 2026-07-03

### Added

- **MaskFS — workspace string masking via FUSE**: secrets referenced in config are transparently masked in the workspace view presented to the agent. A Zig masking core performs same-length in-place replacement with a sliding read window, and a FUSE passthrough daemon enforces masked reads and a write-protection policy. Includes a standalone CLI (`--daemon`/`--unmount`), `lines:` secret source for multi-line files, nix-bundle-elf distribution, `MaskFsService` for daemon lifecycle with scoped cleanup, and full pipeline integration via `MaskFsStage` ([5ecf816], [5fda8512], [44cc55f7], [61bc7e43], [a97b86c1], [f051ceda], [376829d4], [2ff37131], [b6f73da5], [13010074])
- **Proxy — mitmproxy backend**: replaced Envoy with a mitmproxy Python addon for network authorization. Simpler deployment, native HTTPS CONNECT handling via `http_connect` hook, and built-in CA cert management with `update-ca-certificates` in the entrypoint ([7b52a506], [3e37a75c], [1e311d6d], [d0ab8ad8])
- **Proxy — credential injection**: new `CredentialRule` config type allows automatic injection of authentication headers into proxied requests matching host/path patterns. Wired through the proxy stage, broker, and mitmproxy addon ([5c597124], [98639e71], [4a20a560], [d40b11d7])
- **Proxy — JVM trust store**: generate PKCS12 truststore alongside PEM CA cert, mount into agent container, and configure `JAVA_TOOL_OPTIONS` so JVM-based tools trust the proxy CA ([50fa05bb], [731e6c9b], [e04fdc43])
- **Proxy — addon change detection**: detect mitmproxy addon script changes and recreate the shared proxy container automatically ([96e21cb4])
- **Network — unified reviewRules**: replaced `allowlist`/`denylist`/`prompt` with a single first-match `reviewRules` array. Supports `audit` flag to suppress noisy audit logs, host pattern validation, `reviewContext` body preview in both CLI and UI pending views ([31c569dc], [80bc1311], [6df8eed6], [8079404c], [887f9f52], [2d435518], [6f99df43], [5406290d], [90bf6233])
- **Config — trust prompt**: gate untrusted repo-local config behind a trust prompt before applying ([cae03b2b])
- **DinD egress confinement**: Docker-in-Docker containers are now routed through the session network proxy via the internal session network ([2d09be29])
- **UI — scheduled send**: messages can be scheduled for delayed sending with a dialog, toolbar button, list view, and cancel support ([583bbbc3], [09b538cf], [addfcc06], [c2e98ebd], [5dc41445])
- **UI — turn events**: render Events section with styling in turn accordion body ([4d2e02cc], [8a891870])
- **Agents**: `buildPromptToTraceMap` dispatcher and Claude-specific `promptId`-to-`traceId` mapping ([79a00275], [bf1751ea])
- **Review**: `review_trace` verification as orchestrator checkpoint ([130e9aab])
- **Terminal**: `sendInput` method on `TerminalHandle` ([c64e1b21])
- **HostExec**: exec-socket path helpers in registry ([8b142734])

### Changed

- **Breaking — network config**: `allowlist`/`denylist`/`prompt` replaced by `reviewRules`. See migration guide in docs ([31c569dc], [b82aabd7])
- **Breaking — proxy backend**: Envoy removed entirely; mitmproxy is now the only proxy backend. `EnvoyService` replaced by `ProxyService`; auth-router GC removed from `RuntimePaths` ([d0ab8ad8], [c1418949], [8d2a6d87])
- **HostExec**: broker split into exec and control sockets ([7597e9ea])
- **DinD**: stopped owning a dind-private network; dropped container-network rewrite ([0f70d784])
- **Proxy**: auth-router detached as a shared daemon; `AuthRouterHandle` removed ([47060120], [e1c510f1])

### Fixed

- **Proxy**: ensure Docker image is pulled before use to prevent silent hang; mount `caCertDir` at correct mitmproxy home; run CA cert generation as host user to prevent root-owned files; use `openssl` for JVM truststore instead of Python `cryptography`; kill connection on CONNECT auth failure and on 407 to force client reconnect; overwrite existing headers on credential injection; handle missing addon script on first run; avoid leading space in `JAVA_TOOL_OPTIONS`; add `--add-host` to bypass Docker DNS for proxy alias; use CertStore API for CA generation ([8741daf4], [77426512], [c0fc55d0], [c2cf5a7c], [25e4b2c9], [dcb03cf8], [05b3e509], [309a7eb1], [64bd0da6], [138e0c6a], [3be7cc81], [94153cdd])
- **MaskFS**: harden `xCreate` write protection and `xReaddir` error handling; use 2-pass mark-then-replace for overlapping secret matches; route `MaskFsService` preflight/readiness IO through `FsService`; log `fusermount3` unmount failures ([f83edcc6], [c00ef278], [1ee43cd9], [16310c94])
- **Network**: enforce segment boundary on `pathPrefix` matching; eliminate socket gap in auth-router daemon restart; detach auth-router daemon to survive parent exit ([d5a47907], [547b109d], [e1c510f1])
- **Addon**: handle HTTPS CONNECT auth via `http_connect` hook; correct session registry path; use `flow.request.content` instead of non-existent `get_content(limit=)`; stop sending `matchedReviewRule` — broker evaluates rules directly ([86cfcdd6], [dbd5059f], [8a1d2eed], [51639b32])
- **Nix**: use `nix eval` instead of `nix flake show` for devShell detection; replace deleted Envoy assets with mitmproxy addon in flake ([7f23c984], [d50173e5])
- **UI**: bind scheduled-send to the session active at schedule time; force xterm mouse mode for Claude sessions; hide Search button when no terminal session is selected; replace native `<details>` with signal-driven toggle for Events section ([a3f01b13], [4f54365a], [1547c6b8], [02c30cd0])
- **Config**: use `MaskValueConfig` type in `validateMaskValues` signature ([8dbe7866])
- **Env**: use camelCase field names in env resolution error labels ([307a6b00])
- **Test**: fix 3 broken tests — TTY stdin hang, Pkl type mismatch, empty `reviewRules` ([d0c86764])

### Tests

- MaskFS: host-side FUSE integration test, Docker e2e test, binary-not-found fail-closed test for `MaskFsStage` ([e9cc286b], [bcf7aebf], [dae1c640])
- DinD: integration coverage for session-network egress confinement ([cbfb501b])
- Network: auth-router socket recovery integration tests ([2a8500b8])

## [0.14.2] - 2026-05-29

### Fixed

- **Deps**: bump `nix-bundle-elf` to fix an infinite loop in binaries produced by `nas --extract` ([62fa608])

### Changed

- **Config — observability**: default `observability.retention` to 31 days. Keeping OTEL history records indefinitely is a privacy/disk-usage hazard; `null` (keep indefinitely) remains available as an explicit opt-in ([bec4f3c])

### Docs

- **README**: refresh content and screenshots ([aeb9080])

## [0.14.1] - 2026-05-28

### Fixed

- **CI**: stop shipping `Schema.pkl` as a separate release artifact (the schema is embedded in the CLI binary and auto-written to `.nas/` at runtime). Also unblocks the v0.14.0 release pipeline that broke on the `Config.pkl` → `Schema.pkl` rename ([6065be7])
- **Config — migrate nix2pkl**: reject function-style `.agent-sandbox.nix` instead of producing silently broken Pkl. Previous behavior evaluated such files with `local {}` and either crashed cryptically or dropped global config entries because Pkl `amends` *replaces* listings where Nix `++` extends. Migration now errors with manual-conversion guidance ([e168e79])

### Docs

- **README**: clarify that the GitHub Releases binary works on hosts without Nix installed (pkl / glibc / assets are bundled via nix-bundle-elf). Remove Nix from the required prerequisites ([0fc8a4b])

## [0.14.0] - 2026-05-28

### Added

- **Config — Pkl migration**: full migration from YAML/Nix config to Pkl. New `nas config init` command scaffolds `.nas/` directory with typed `Config.pkl`, `Schema.pkl`, and `PklProject` ([155ddcd], [60d13b8], [c4381ea])
- **Config — migrate commands**: `nas config migrate yml2pkl` and `nas config migrate nix2pkl` convert existing configs to Pkl format ([f0e3888], [f66cb8f], [1278a46], [6fd5878], [ec98948])
- **Config — legacy detection**: auto-detect `.agent-sandbox.yml` / `.agent-sandbox.nix` and prompt users to migrate ([304a9a8], [6a0e73a])
- **Config — auto-init**: automatically initialize `.nas/` on `nas run` when no `config.pkl` exists ([c4381ea])
- **Config — Pkl loader**: `loadPklConfig` with `pkl eval`, typed `Config.pkl` module with structural defaults, camelCase key support ([8ac9c87], [f1d8629], [db27240], [05f2788])
- **CLI**: `nas config` subcommand framework ([2eade93])
- **Logging**: `--verbose` flag with debug-level timing instrumentation ([b2a22f7])
- **UI — mouse mode**: auto-recover xterm mouse mode state after attach/detach ([70527c2])
- **UI**: expose session agent type on frontend session rows ([e7b108e])
- **Agents**: browser-safe terminal trait module ([54aec0a])
- **Nix**: embed native `pkl` binary and `Config.pkl` into the Nix package ([79c1366], [c044260])

### Changed

- **Breaking — config format**: YAML and Nix config loaders removed; Pkl is now the only supported config format. Deprecated `snake_case` env keys dropped ([054a6cc], [20c8386])
- **Config internals**: collapse `RawConfig` / `mergeRawConfigs`, remove kebab/camel bridge, simplify validation, replace zod with semantic-only validation ([8da81e4], [af8fac4], [28bfdd1], [eda03aa])
- **Config resolution**: rewrite `loadConfig` to use `--project-dir` with nonce guard; move `eval.pkl` and `global.pkl` out of `.nas/` into tmpdir ([1be33f5], [e76b70a])
- **History**: split `ingestResourceSpans` into transform + write; move OTLP semantics module out of `src/agents/`; extract OTLP wire helpers ([415cfed], [366b38a], [85eb466])
- **UI**: drop manual xterm mouse mode controls from toolbar ([fd02aeb], [10e8992])

### Fixed

- **Config**: generate fallback `global.pkl` when missing; handle Pkl symlink limitation; restore `config.pkl` from deleted `.agent-sandbox.pkl`; emit typed constructors in migrate output ([c69c0da], [aedb75a], [95a1670], [947b203])
- **dtach**: reset mouse tracking mode after detach ([d9175af])
- **UI**: always fire dtach initial resize nudge for agent SIGWINCH race; disable mouse mode auto-recovery for shell terminals; scope auto mouse mode recovery to Copilot CLI sessions ([a85ca2b], [e11235c], [cdb5c38], [2db3f2e])
- **Docker**: list only running containers in `dockerListContainerNames` ([5d29ee8])

## [0.13.0] - 2026-05-16

### Added

- **History UI — user prompts**: surface each turn's user prompt on the
  conversation detail page and on Copilot turn rows ([531b836],
  [584ccb8], [d8b51e3])
- **Observability — logs signal**: ingest OTLP `ExportLogsServiceRequest`
  via `POST /v1/logs`, persist into a new `log_records` table, and
  inject `OTEL_LOGS_EXPORTER=otlp` for Claude
  ([681ea67], [6347f6a], [f789236], [735f3ec])
- **History — span events**: persist OTLP span events into
  `spans.events_json` ([b9699e8])
- **History — auto-migration**: history.db migrates forward on writer
  open; schema split into per-version steps ([1d6065b], [da3fa27],
  [5083bba])
- **History — retention**: `observability.retention` duration prunes
  history.db on writer open ([40fdb6c], [b9466ce], [bcde814])
- **UI — Stop container**: replace the "Kill clients" button with a
  Stop-container action ([bea0753])
- **UI — span attrs drawer**: add a copy button ([d82cb4e])
- **History — conversation costs**: surface conversation costs in the
  list view ([82fe80a])

### Changed

- **Breaking — history schema v4**: drop `turn_events` and
  `conversation_summaries` (both unread); summaries are now derived from
  the first trace's prompts at read time. Forward-only migration
  discards rows in those tables ([b99834f], [5664032])
- **Agents**: move trace-prompt extraction into per-agent modules
  ([bcd6d52])

### Fixed

- **Copilot prompt extraction**: filter `<skill-context>` blocks
  ([1e5cbc4])
- **History ingest**: suppress receiver diagnostics during agent
  sessions ([507e946])
- **UI**: column alignment in Turns table, "None" worktree always
  disables worktree, prompt-display colors in dark theme, layout shift
  on accordion open, attrs drawer overflowing span columns
  ([0fed808], [4c17a88], [4854239], [3303d4f], [896f8fd], [3375426])
- **Observability**: correct content-capture env names for Copilot &
  Claude; subtract cache reads from Copilot input tokens; resolve
  dot-versioned model names against LiteLLM pricing
  ([15ee87a], [554ccbf], [1031bbf])
- **Entrypoint / hostexec**: apply env ops after Nix devShell source;
  match relative argv0 against absolute exec paths
  ([db977cf], [f0b5fb3])
- **Copilot**: default `REMOTE_CONTAINERS=true` to enable OSC52
  clipboard ([d443410])

## [0.12.0] - 2026-05-03

### Added

- **Observability + History UI**: capture agent OTLP traces (Claude Code / Codex / Copilot CLI) into a SQLite history store and expose them on a new `#/history` UI with per-turn spans, per-model token totals, and LiteLLM-priced cost panels ([53ba327]–[1ea0bd0])

### Changed

- **Breaking — `network.proxy`**: always on. Sessions can no longer launch without the Envoy / auth-router / broker chain; empty allowlist & prompt now mean deny-by-default ([6d4e59d])
- **UI state**: daemon state relocated from `XDG_CACHE_HOME` to `XDG_STATE_HOME`, with one-shot migration on start ([cc87add], [2979282])

### Performance

- **Launch**: disable Docker log driver for agent containers ([531051c])

### Fixed

- **UI**: small fixes — xterm initial-font nudge, favicon palette, history SSE keepalive, rename apply-immediate, pending-row clearing on approve/deny, relaxed session-name validation ([99f7fbd], [eeb62ec], [b3ee423], [a07024a], [4d3c8c4], [a3f6b80])

## [0.11.0] - 2026-04-28

### Added

- **UI**: rewrite the daemon web UI on SolidJS (hash router, drag-resizable panes, settings pages, inline session actions, shortcut dispatcher) ([300b6af])
- **`network.proxy.forward-ports`**: forward host `127.0.0.1` ports via per-port UDS bind-mounted into the container; host `0.0.0.0` no longer required ([7bc290e], [685cfe9], [1ad6518])

### Security

- **UI**: require a bearer token on terminal WebSocket upgrades, cap WS payloads at 64 KiB, and add security response headers ([8bf2bd4], [9dcd636], [0ef86ca])
- **Mount**: bind-mount `.agent-sandbox.{yml,nix}` read-only ([23f2af8])

### Fixed

- **Network**: `gcRuntime` removes the entire per-session `brokers/{sessionId}/` directory so stale sockets are no longer double-counted by the orphan-dir pass ([666df0c])

## [0.10.1] - 2026-04-21

### Security

- **HostExec / Network broker**: isolate per-session broker sockets under a per-session 0o700 subdirectory (`brokers/{sessionId}/sock`) and bind-mount only that subdir into the agent container. Sibling sessions' sockets are no longer reachable — or nameable — from within the container, closing a defense-in-depth gap where the broker protocol performed no peer-cred or `sessionId` check ([eb8a3e0], [8cb6b72])

### Fixed

- **CLI**: update `--help` output to match implemented subcommands (session, container list, ui stop, hostexec subcommands, review) ([24d1f31])
- **Docs**: correct README discrepancies with the current implementation ([ecd4900])

## [0.10.0] - 2026-04-19

### Added

- **Display**: auto-detect read-only `/tmp/.X11-unix` and use `unshare` to work around it ([019f6ff])

### Changed

- **Stages**: co-locate each stage with its services into subdirectory layout ([e002d10]–[3dd3e12])
- **Worktree**: split service into per-concern files with D1/D2 effect separation ([4d83d40]–[d99db6d])
- **Worktree**: route logs through `log` module; rename `findProfileWorktrees` → `findNasWorktrees` ([b656964], [ac7e062])
- **Lint**: add composed-effects violation detector ([b101353])

### Fixed

- **Display**: remove non-null assertion in `spawnXpraWithUnshare` ([426ca21])
- **Test**: exclude bare `integration_test.ts` files from `test:unit` ([a7c3025])
- **Test**: isolate XDG dirs during `bun test`; make tests pass inside nas containers ([5b849ac], [5a96707])

### Tests

- Add unit tests for pure helpers, CLI args, secret store, service fakes ([5c13606]–[28e2399])

## [0.9.0] - 2026-04-19

### Added

- **`display.sandbox: "xpra"`**: scoped X11 forwarding. Launches a per-session xpra X server (Xvfb-backed), bind-mounts only its socket and an MIT-MAGIC-COOKIE Xauthority into the container, and auto-starts a host-side `xpra attach` viewer so agent windows surface on the user's desktop. Sub-option `display.size` (default `"1920x1080"`). Requires `xpra` on the host ([4ac0c69], [3c5ec9b])

### Changed

- **Breaking:** `session.enable` renamed to `session.multiplex` ([55c5a51])

### Removed

- **Breaking:** `display.enable` (unscoped X11 socket forwarding) removed. X11 has no isolation between clients sharing a display, so the feature let any agent granted it keylog the host, capture the screen, inject input, and read the clipboard — none of which can be scoped per-app. Replaced by `display.sandbox: "xpra"`. The old behavior can still be assembled manually with `extra-mounts` and `env`, which surfaces the risk at config-review time ([93ac88f])

### Security

- UI daemon rejects cross-origin requests and DNS-rebinding `Host` headers ([17c4339])
- UI rejects `sessionId`/`requestId` path traversal ([ee37b3f])
- UI sandboxes git invocations and tightens approve/clean/rename/xdg-open inputs; audit command prefix exclusion now matches absolute-path form ([19f70f5], [29c124e])
- Worktree hardens git invocations and avoids symlink-following `cp` ([c1d5560])
- Mount stage resolves `extra-mounts.src` via realpath and rejects `extra-mounts.dst` that escapes the container work/home dirs ([d4af561], [5862cdb])
- Hostexec restricts absolute `argv0` to safe container path prefixes, and validates `cwd.allow` entries and secret path prefixes ([c512347], [f38ad61])
- Dbus/config tighten validation on dbus rules, source-address, pid file, and `nix.extra-packages` ([4f0c011])

### Migration

- Replace `display: { enable: true }` with `display: { sandbox: "xpra" }` (optionally `size: "WxH"`); the `enable` key is no longer recognized.
- Replace `session: { enable: ... }` with `session: { multiplex: ... }`.

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

[0.15.2]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.14.2...v0.15.0
[0.14.2]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hogeyama/nix-agent-sandbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hogeyama/nix-agent-sandbox/releases/tag/v0.1.0
