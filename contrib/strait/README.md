# strait

strait runs a command, typically Claude Code, under [srt](https://github.com/anthropics/sandbox-runtime) (Anthropic's sandbox-runtime) with a fixed network policy. Every HTTPS request the sandboxed process makes goes through strait's `filterRequest` policy. A request is allowed only if it goes to an allowed endpoint and carries no credential except the ones strait issued.

The point is how much code has to be trusted. strait's own code is about 1,150 lines: `policy.ts`, `graphql.ts`, `body.ts`, `config.ts`, `selfcheck.ts` and `main.ts`, plus the `strait` launcher. About 100 of those lines are the GraphQL allowlist. The trusted base is that code, srt, two small patches to srt, and graphql-js, which parses GraphQL documents. Both packages are pinned to exact versions in `package.json`.

## Why srt needs patches

srt 0.0.77 terminates TLS and calls `filterRequest` only on HTTP proxy requests. Two other paths reach an allowed host without passing the filter. [srt-filter-bypass](../../docs/architecture/experiments/srt-filter-bypass/README.md) measured both:

- **SOCKS.** The proxy port also speaks SOCKS5, and SOCKS connections are tunnelled opaquely. A sandboxed process that changes `HTTPS_PROXY` to `socks5h://` sends any token it likes straight to GitHub.
- **Non-TLS CONNECT.** A CONNECT stream that does not start with a TLS ClientHello is relayed as-is. SSH to `github.com:22` or `ssh.github.com:443` got through this way.

[patches/](patches/) closes both. The mux drops SOCKS connections, and the HTTP proxy closes a CONNECT stream that is not TLS. `package.json` pins srt to exactly `0.0.77` and applies the patch through `patchedDependencies`.

Before the command starts, strait probes the live proxy (`selfcheck.ts`) and refuses to run if either patch is missing. So a version bump or a patch that failed to apply fails loudly instead of silently reopening the holes. A test that removes one patch at a time confirmed that each missing patch is caught.

## What the policy allows

Hosts are fixed in code: `api.anthropic.com`, `api.github.com` and `github.com`, on port 443 only. TLS is always terminated. No host can be exempted from termination, and the config cannot add an external proxy.

| Host | Allowed | Everything else |
| --- | --- | --- |
| `api.anthropic.com` | Claude Code's endpoints: nas's `presets.anthropic.v1` (messages, bootstrap, telemetry and feature flags) plus `GET /api/model_selector/cc` | denied, including the Files API (`/v1/files`) |
| `api.github.com` | `GET`/`HEAD` on `/repos/{owner}/{repo}` and below, for repositories in `githubRepos`; GraphQL queries that only read listed fields of those repositories (below) | denied: other repos, `/repositories/{id}`, `/user`, every REST write, GraphQL mutations and other GraphQL reads |
| `github.com` | `git fetch` (`info/refs?service=git-upload-pack`, `git-upload-pack`) for the same repositories | denied, including push (`git-receive-pack`) and web pages |

Owner and repo names are compared case-insensitively. A name containing `%` never matches.

srt forwards the request target exactly as the client sent it, but URL parsing resolves `..`, `%2e` and `\`. So a request whose target changes under parsing is denied, and the path strait judges is always the path GitHub receives.

### GraphQL

`POST /graphql` is the one request whose body strait reads. The body must be `application/json` (optionally `charset=utf-8`), not content-encoded, at most 256 KiB, and a single `{query, variables, operationName}` object with no duplicated member. The URL must have no query string. Then the document must pass these checks:

- Every operation is a `query`. The check covers all operations, whatever `operationName` says.
- Every selected field lies on a path listed in `GITHUB_FIELDS` in `graphql.ts`. A leaf must be listed exactly. A field with children must lead to a listed leaf. Paths use real field names: aliases are dropped, fragments are expanded where they are used, and type conditions are ignored, so every branch is checked. `@skip` and `@include` do not exempt a field.
- Every path starts at `repository`, and each `repository` occurrence has `owner` and `name` arguments that resolve to one repository in `githubRepos`. Variables and their declared defaults are resolved per operation.
- The document is one strait can analyse: it parses, uses no other directive, has no duplicated argument, variable or fragment and no undefined or cyclic fragment, and stays within fixed token, depth and expansion budgets.

The listed paths are the ones gh 2.46 asks for in `pr view`, `pr list`, `pr checks`, `issue view`, `issue list`, `release view`, `release list` and `repo view`, captured in [src/testdata/gh_queries.json](src/testdata/gh_queries.json). Every listed leaf is a scalar. None of the paths reaches another repository's content: that would take a field such as `owner { repositories }` or `author { ... on User { pullRequests } }`, and none is listed. The rules are a trimmed copy of nas's [GraphQL field path policy](../../docs/superpowers/specs/2026-09-20-graphql-field-path-policy-design.md). strait fixes the paths in code, and it requires both owner and name, where nas requires only the owner.

### Files the sandbox cannot write

The default `allowWrite` is the whole workspace. Whatever the config says, strait also denies writes to these paths, so the sandboxed process cannot choose the next launch's policy:

- the config file
- strait's own directory: its sources, the patch, and the patched srt in `node_modules`
- the workspace's `.claude`

srt on Linux can only protect paths that already exist. That is why a missing config file is an error, not an empty policy. For the same reason, strait creates empty `.claude/commands` and `.claude/agents` directories before launch: srt always protects those two, and bubblewrap cannot create them inside a read-only `.claude`.

### Credentials

strait reads these variables from the host environment. srt replaces each value inside the sandbox with a random sentinel, and swaps the real value back in only on requests to the listed host.

| Variable | Host | Accepted form |
| --- | --- | --- |
| `GH_TOKEN` | `api.github.com` | `Authorization: token <s>` or `Bearer <s>` |
| `STRAIT_GIT_AUTH` (derived from `GH_TOKEN`) | `github.com` | the whole `Authorization` value |
| `CLAUDE_CODE_OAUTH_TOKEN` | `api.anthropic.com` | `Authorization: Bearer <s>` |
| `ANTHROPIC_API_KEY` | `api.anthropic.com` | `x-api-key: <s>` |

For git over HTTPS, GitHub accepts only Basic auth. srt swaps a sentinel only where it appears verbatim, and a sentinel inside a base64 value does not. So strait masks the whole `Basic …` header value as one credential. Inside the sandbox, git sends it through `http.extraHeader`.

A request that carries any other credential is denied. That covers a foreign or duplicated `Authorization`, an `x-api-key` sent anywhere else, any `Cookie`, and an `access_token` query parameter. So a token the sandboxed program brings along never reaches upstream, and neither does a sentinel sent to the wrong host.

## Usage

```sh
cd contrib/strait && bun install    # applies the srt patch
cp strait.example.json /path/to/workspace/strait.json   # then edit githubRepos

cd /path/to/workspace
GH_TOKEN=$(gh auth token) \
CLAUDE_CODE_OAUTH_TOKEN=... \
  /path/to/contrib/strait/strait -- claude --permission-mode auto
```

Always start strait through the `strait` launcher, never with `bun src/main.ts`. Otherwise bun reads `bunfig.toml` and `.env` from the working directory. The working directory is the sandbox's writable workspace, so a `preload` planted there would run on the host, outside the sandbox, at the next launch. The launcher passes `--config=<strait>/bunfig.toml --no-env-file` so that neither file is read.

Options are `--config <path>` (default `./strait.json`, which must exist) and `--debug` (srt's debug log). The command starts after `--`, or at the first argument that is not an option.

For Claude Code, the launch lessons from [srt-trial](../../docs/architecture/experiments/srt-trial/README.md) still apply:

- Point `CLAUDE_CONFIG_DIR` at a state directory inside the workspace.
- Pre-create `.claude.json` with `"hasCompletedOnboarding": true`.
- Create every `denyWrite` path before launch. srt on Linux protects only paths that already exist.

This was checked on the host with Claude Code 2.1.284 and `claude -p … --permission-mode auto`. The command ran, and the filter denied nothing. The only request refused was the one to `http-intake.logs.us5.datadoghq.com`, which is not an allowed host.

### Using the host's `~/.claude`

To share history, memory and projects with Claude Code on the host, leave `CLAUDE_CONFIG_DIR` unset. Then allow writes to `~/.claude` and `~/.claude.json`, and deny the parts that affect the host:

```json
{
  "filesystem": {
    "allowWrite": [".", "~/.claude", "~/.claude.json"],
    "denyWrite": [".claude", "~/.claude/settings.json", "~/.claude/skills", "~/.claude/plugins"],
    "denyRead": ["/tmp", "~/.ssh", "~/.aws", "~/.config/gh", "~/.claude/.credentials.json"],
    "allowRead": ["/tmp/claude-http-*.sock"]
  }
}
```

- `.credentials.json` holds the real OAuth token. Claude Code inside the sandbox runs on the `CLAUDE_CODE_OAUTH_TOKEN` sentinel and does not need to read it.
- `settings.json`, `skills` and `plugins` hold hooks and scripts that Claude Code on the host runs outside the sandbox. Add every other such path that exists on your host, such as `CLAUDE.md`, `hooks`, `commands`, `agents` or a status line script. srt cannot protect a path that does not exist yet.
- `~/.claude.json` must stay writable because Claude Code writes it constantly. It also holds MCP server commands, which Claude Code on the host starts. Restrict MCP servers with managed settings on the host, for example `allowManagedMcpServersOnly`.
- History, memory and projects are writable and shared. Anything the agent writes there carries over to later sessions.

This was checked on the host with Claude Code 2.1.284. From inside the sandbox, `.credentials.json` was unreadable, `settings.json` and `skills` were read-only, and history and `~/.claude.json` were writable. `claude -p` ran.

### Config

`strait.json` accepts only two keys, and unknown keys are rejected:

- `githubRepos`: `owner/name` strings.
- `filesystem`: `allowWrite`, `denyWrite`, `denyRead`, `allowRead`. These are the same fields as srt's `filesystem` section, with the defaults shown in [strait.example.json](strait.example.json).

**An existing `srt-settings.json` cannot be used as-is.** Copy its `filesystem` section into `strait.json`. The other sections are rejected on purpose:

- `network`: hosts, TLS termination and the filter are fixed in code.
- `credentials`: strait takes credentials only from the environment variables above. File masking (`credentials.files`) is not supported. Put files the agent must not read, such as `.env`, in `denyRead` instead.

## Limits

- **GraphQL covers only what gh asked for once.** The captured queries are only each command's first request, from gh 2.46. A different gh version, a flag that adds fields, or a later request in the same command can select a path that is not listed, and that request is denied. `gh api repos/...` works either way.
- **Deny only.** There is no human approval step yet. A request outside the policy fails immediately.
- **No write path.** Pushes and REST writes are always denied.
- **Not part of strait:** nas features such as file-content masking (maskfs), output masking (sumi) and the audit log.
- **Tested only on Linux.** macOS uses a different srt backend, and the patches have not been checked there.
- **An unexplained failure.** Four launches failed to find a command in `~/.local/bin` (`gh` or `claude`) inside the sandbox. Repeated launches right afterwards did not reproduce it, whether back to back, with or without tokens, or with the command run directly or through `bash -c`. The cause is unknown.

## Tests

```sh
bun run test:strait-unit        # policy, GraphQL and config, from the repo root; no srt needed
node_modules/.bin/tsc -p contrib/strait/tsconfig.json   # needs `bun install` in contrib/strait first
GH_TOKEN=$(gh auth token) contrib/strait/tests/probe.sh [owner/repo]
```

`tests/probe.sh` is a live check on a Linux host with network, bubblewrap and socat. It runs positive controls (a `curl` carrying the issued token, `gh api`, `git ls-remote`, and a request to Claude Code's messages endpoint) next to each bypass attempt:

- a foreign or duplicated token
- another repository
- a REST write, a GraphQL mutation and push discovery
- the Files API and a host outside the list
- SOCKS, SSH over CONNECT, and a client that does its own TLS
- writes to the config file, strait's sources and the patched srt
- a `bunfig.toml` preload planted in the workspace
