# strait

strait runs a command, typically Claude Code, under [srt](https://github.com/anthropics/sandbox-runtime) (Anthropic's sandbox-runtime) with a fixed network policy. Every HTTPS request the sandboxed process makes goes through strait's `filterRequest` policy. A request is allowed only if it goes to an allowed endpoint and carries no credential except the ones strait issued. A request to any other endpoint on an allowed host is held until a human approves or denies it with `strait review`.

The point is how much code has to be trusted. What decides what leaves the sandbox and what runs on the host is `src/core/`, about 2,000 lines: `policy.ts`, `graphql.ts`, `body.ts`, `approval.ts`, `hostexec.ts`, `session.ts`, `config.ts`, `selfcheck.ts` and `main.ts`. About 100 of those lines are the GraphQL allowlist. The trusted base is that code, the `strait` launcher, `src/cli.ts` (which routes subcommands), srt, three small patches to srt, and graphql-js, which parses GraphQL documents. Both packages are pinned to exact versions in `package.json`.

`src/ui/`, about 600 lines, cannot widen the policy: `strait review` can only answer requests that are already held, the status line and the desktop notification only report, and `strait hostexec` runs inside the sandbox, which is untrusted anyway. `src/core/` imports nothing from `src/ui/`, and a test checks that. So a change under `src/ui/` needs no security review, except for one point. `strait review` escapes what it shows (see below), so that a request cannot pass itself off as another one.

## Why srt needs patches

srt 0.0.77 terminates TLS and calls `filterRequest` only on HTTP proxy requests. Two other paths reach an allowed host without passing the filter. [srt-filter-bypass](../../docs/architecture/experiments/srt-filter-bypass/README.md) measured both:

- **SOCKS.** The proxy port also speaks SOCKS5, and SOCKS connections are tunnelled opaquely. A sandboxed process that changes `HTTPS_PROXY` to `socks5h://` sends any token it likes straight to GitHub.
- **Non-TLS CONNECT.** A CONNECT stream that does not start with a TLS ClientHello is relayed as-is. SSH to `github.com:22` or `ssh.github.com:443` got through this way.

[patches/](patches/) closes both. The mux drops SOCKS connections, and the HTTP proxy closes a CONNECT stream that is not TLS. `package.json` pins srt to exactly `0.0.77` and applies the patch through `patchedDependencies`.

The same patch file adds a third change, which closes nothing but is needed for [host commands](#running-commands-on-the-host). `filterRequest` may return `{action: "respond", status, headers, body}`, and srt then answers the client with that response instead of forwarding the request. Unpatched srt treats that decision as a denial, so a missing patch fails closed. strait also checks for the patch at launch when `hostExec` is on.

Before the command starts, strait probes the live proxy (`selfcheck.ts`) and refuses to run if either patch is missing. So a version bump or a patch that failed to apply fails loudly instead of silently reopening the holes. A test that removes one patch at a time confirmed that each missing patch is caught.

## What the policy allows

The policies for `api.anthropic.com`, `api.github.com` and `github.com` are fixed in code. `strait.json` can add other hosts ([Added hosts](#added-hosts)). Every host is reached on port 443 only, and TLS is always terminated. No host can be exempted from termination, and the config cannot add an external proxy.

| Host | Allowed | Held for approval |
| --- | --- | --- |
| `api.anthropic.com` | Claude Code's endpoints: nas's `presets.anthropic.v1` (messages, bootstrap, telemetry and feature flags) plus `GET /api/model_selector/cc` | everything else, including the Files API (`/v1/files`) |
| `api.github.com` | `GET`/`HEAD` on `/repos/{owner}/{repo}` and below, for repositories in `githubRepos`; GraphQL queries that only read listed fields of those repositories (below) | other repos, `/repositories/{id}`, `/user`, every REST write, GraphQL mutations and other GraphQL documents |
| `github.com` | `git fetch` (`info/refs?service=git-upload-pack`, `git-upload-pack`) for the same repositories | push (`info/refs?service=git-receive-pack`, `git-receive-pack`), other repositories and web pages |

Some requests are denied outright and never reach a human:

- a request that fails a transport check: not HTTPS, not port 443, credentials in the URL, a request target that is not in canonical form (below), or a host outside the list
- a request that carries a credential strait did not issue (see Credentials)
- a GraphQL request whose body strait cannot read: over 256 KiB, not UTF-8, not JSON, content-encoded, with a duplicated member, or with a query string on the URL

Owner and repo names are compared case-insensitively. A name containing `%` never matches.

srt forwards the request target exactly as the client sent it, but URL parsing resolves `..`, `%2e` and `\`. So a request whose target changes under parsing is denied, and the path strait judges is always the path GitHub receives.

### Added hosts

A host listed under `hosts` in `strait.json` takes every request on port 443, whatever its method or path, after the same transport checks as the fixed hosts. Credentials are the part strait still controls:

```json
{
  "hosts": {
    "devapi.example.com": { "credential": { "env": "DEVAPI_KEY", "header": "x-api-key" } },
    "api.example.org": { "credential": { "env": "ORG_TOKEN", "header": "authorization", "scheme": "Bearer" } },
    "docs.example.com": {}
  }
}
```

- `credential.env` names a variable in strait's environment, which must be set. srt masks it in the sandbox like strait's own credentials, and puts the real value back only on requests to this host.
- A request to the host may carry only that credential, in `credential.header`, as the value itself or as `<scheme> <value>`. Any other value in that header, a duplicated header, an `Authorization` or `x-api-key` header that is not the credential, a `Cookie` or an `access_token` query parameter is denied. A host without `credential` takes none of these.
- Names are exact and lowercase. There are no wildcards, ports or IP addresses, and the fixed hosts cannot be redefined. A variable cannot be one of strait's own (`GH_TOKEN` and the others), and one variable cannot serve two hosts.

Adding a host is a decision about who may receive what the sandbox sends. strait checks the credential, not the account behind it. So add only a service like the `devapi.example.com` of the [threat model](../../docs/architecture/threat-model.md): its one form of authentication is the header strait checks, and a valid key reaches only your own environment. On a service where the sandbox could reach someone else's account or forward data elsewhere, a host-wide allow lets it do so.

### GraphQL

`POST /graphql` is the one request whose body strait reads. The body must be `application/json` (optionally `charset=utf-8`), not content-encoded, at most 256 KiB, and a single `{query, variables, operationName}` object with no duplicated member. The URL must have no query string. Then the document must pass these checks:

- Every operation is a `query`. The check covers all operations, whatever `operationName` says.
- Every selected field lies on a path listed in `GITHUB_FIELDS` in `graphql.ts`. A leaf must be listed exactly. A field with children must lead to a listed leaf. Paths use real field names: aliases are dropped, fragments are expanded where they are used, and type conditions are ignored, so every branch is checked. `@skip` and `@include` do not exempt a field.
- Every path starts at `repository`, and each `repository` occurrence has `owner` and `name` arguments that resolve to one repository in `githubRepos`. Variables and their declared defaults are resolved per operation.
- The document is one strait can analyse: it parses, uses no other directive, has no duplicated argument, variable or fragment and no undefined or cyclic fragment, and stays within fixed token, depth and expansion budgets.

The listed paths are the ones gh 2.46 asks for in `pr view`, `pr list`, `pr checks`, `issue view`, `issue list`, `release view`, `release list` and `repo view`, captured in [src/testdata/gh_queries.json](src/testdata/gh_queries.json). Every listed leaf is a scalar. None of the paths reaches another repository's content: that would take a field such as `owner { repositories }` or `author { ... on User { pullRequests } }`, and none is listed. A document that fails is held for approval, and the reason names every violation: each operation that is not a query, each field outside the list at its topmost path, and each repository that is not allowed. Nothing is left out, so the reason shown in `strait-review` covers everything the document would fetch outside the policy.

The rules are a trimmed copy of nas's [GraphQL field path policy](../../docs/superpowers/specs/2026-09-20-graphql-field-path-policy-design.md). strait fixes the paths in code, and it requires both owner and name, where nas requires only the owner.

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

### Approving held requests

A held request waits in the proxy for up to 240 seconds. Approve or deny it from another terminal on the host:

```sh
strait review                  # stays open in fzf: Enter approves, Ctrl-D denies, Esc quits
strait review k3f9             # the same, for one session
strait review --all            # the same, for every session
strait review --json [k3f9]    # what is waiting, as JSON
strait review list [k3f9]      # what is waiting, one line each
strait review show k3f9-2      # one request in full, with a GraphQL query unescaped
strait review approve k3f9-2 ...
strait review deny k3f9-2 ...
```

`strait review` stays open. Approving or denying reloads the list rather than quitting. It also checks every second for requests that arrived or went away, and reloads when the set changes. Tab selects several requests at once, and the preview shows the one under the cursor in full. Without a session ID or `--all`, it shows only the sessions started in the current directory.

strait also sends a desktop notification through `notify-send` when that command exists. If no one answers in time, the request is denied, and the reason the sandboxed client gets says so.

An approval covers one request only. A `git push` makes two requests, `info/refs?service=git-receive-pack` and then `git-receive-pack`, so it needs two approvals. While the second one waits, srt may keep the part of the pack it has already received in memory, because it tees the body for upstream.

#### Which session a request came from

Several strait sessions often run in the same directory, so each has a session ID: four random characters such as `k3f9`, or the name given with `strait --name NAME`. A second session cannot take a name that a running one holds. strait prints the ID when it starts. Every request ID is `<session>-<n>`, and the list shows the session, the tmux pane and the terminal (`tmux %12 pts/3`). `show` adds the command, the directory and the start time.

To match a request to a terminal at a glance, strait puts the ID in Claude Code's status line. When the command is `claude`, strait adds `--settings` with a status line that prints `[strait:k3f9]` and then runs the status line you already have. strait finds that one in `.claude/settings.local.json`, `.claude/settings.json` and then the user settings, in that order. Set `"statusLine": false` in `strait.json` to leave the status line alone. The sandboxed process also gets the ID as `STRAIT_SESSION`, so an agent can name it when it asks you to approve something.

Each running strait listens on `<session>.sock` in `$XDG_RUNTIME_DIR/strait`, or in `strait-<uid>` under the temp directory when `XDG_RUNTIME_DIR` is unset. The directory must be owned by you and have mode 0700. The sandbox cannot reach the socket for two reasons. srt's seccomp filter blocks `AF_UNIX` sockets on Linux. And strait adds the directory to `denyRead`, which still hides it when srt runs without its seccomp helper. `strait review` and strait must agree on `XDG_RUNTIME_DIR`, or they look in different directories.

Everything `strait review` shows comes from the sandbox: the URL, the reason, which may quote a GraphQL argument, and the body. Control and format characters are therefore shown escaped, so a request cannot forge another line or redraw the terminal. The resident review has fzf listen on a localhost port for reloads, and it sets `FZF_API_KEY`, so no other local process can drive it.

### Running commands on the host

Some commands cannot run in the sandbox: a `nix build` that needs the daemon, or a tool the sandbox does not have. With `"hostExec": true` in `strait.json`, the sandboxed process can ask for such a command to run on the host. strait puts itself on the sandbox's `PATH`, so the sandbox runs `strait hostexec`:

```sh
# inside the sandbox
strait hostexec --env NIX_CONFIG='...' -- nix build .#sumi
strait hostexec --cwd /path/to/repo --env GH_HOST -- gh release view
```

- `--cwd DIR` sets the working directory; it defaults to the current one. Paths inside the sandbox are the same as on the host.
- `--env NAME=VALUE` sets a variable, and `--env NAME` copies one from the sandbox. The command gets `PATH` and `HOME` from strait's environment plus exactly these variables, and nothing else from strait. strait's own environment holds the real tokens.
- Each run is held for approval like any other request. `strait review` shows every argument on its own line, the working directory and each variable. An approval covers that one run. There are no rules that allow a command automatically.
- stdout and stderr come back once the command ends, and the exit status is the command's. There is no stdin, and output is not streamed. A refused request exits with 126. If the client goes away, the command is killed.
- Any real credential strait holds is replaced with `[masked by strait]` in the output, so an approved `gh auth token` cannot hand the real token to the sandbox. Anything else the command prints goes back unmasked, and so does whatever it writes to the files the sandbox can read.

The request travels as `POST https://hostexec.strait.invalid/run` through srt's proxy, so the one exit remains `filterRequest`. The host name does not exist. It is on the allowlist only when `hostExec` is on, and srt never resolves or dials it: strait answers it through the `respond` patch. srt blocks Unix sockets on Linux, so nas's socket-based hostexec is not an option here. srt's `mitmProxy` option cannot be combined with TLS termination.

Nothing limits run time or output size. A command that runs past the approval hold keeps running, because only the wait for approval is limited to 240 seconds.

## Usage

```sh
nix profile install .#strait    # or: nix build .#strait, and use result/bin
cp contrib/strait/strait.example.json /path/to/workspace/strait.json   # then edit githubRepos

cd /path/to/workspace
GH_TOKEN=$(gh auth token) \
CLAUDE_CODE_OAUTH_TOKEN=... \
  strait -- claude --permission-mode auto
```

Run the packaged strait, not `contrib/strait/strait` from a checkout. strait always makes its own directory read-only in the sandbox, because its code runs on the host at the next launch. Started from a checkout inside the workspace, that directory is the source you are editing, so the sandbox cannot touch it. The package lives in the nix store, which is read-only anyway, and leaves the checkout writable. The package build applies the srt patch and fails if any of its three changes is missing.

For work on strait itself, `cd contrib/strait && bun install` still sets up a checkout for the tests and for running `contrib/strait/strait` directly. After changing a dependency, run `bun2nix -o bun.nix` in `contrib/strait` so the package picks it up.

Always start strait through a launcher (`strait`, or `contrib/strait/strait` in a checkout), never with `bun src/cli.ts`. Otherwise bun reads `bunfig.toml` and `.env` from the working directory. The working directory is the sandbox's writable workspace, so a `preload` planted there would run on the host, outside the sandbox, at the next launch. The launcher passes `--config=<strait>/bunfig.toml --no-env-file` so that neither file is read.

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

`strait.json` accepts only five keys, and unknown keys are rejected:

- `githubRepos`: `owner/name` strings.
- `hostExec`: `true` lets the sandbox ask to run commands on the host (above). Off by default.
- `statusLine`: `false` keeps strait from putting the session ID in Claude Code's status line. On by default.
- `hosts`: hosts to allow besides the fixed ones, each with the credential it takes ([Added hosts](#added-hosts)).
- `filesystem`: `allowWrite`, `denyWrite`, `denyRead`, `allowRead`. These are the same fields as srt's `filesystem` section, with the defaults shown in [strait.example.json](strait.example.json).

**An existing `srt-settings.json` cannot be used as-is.** Copy its `filesystem` section into `strait.json`. The other sections are rejected on purpose:

- `network`: TLS termination and the filter are fixed in code. Add hosts with `hosts` instead.
- `credentials`: strait takes credentials only from the environment variables above. File masking (`credentials.files`) is not supported. Put files the agent must not read, such as `.env`, in `denyRead` instead.

## Limits

- **GraphQL covers only what gh asked for once.** The captured queries are only each command's first request, from gh 2.46. A different gh version, a flag that adds fields, or a later request in the same command can select a path that is not listed, and that request is denied. `gh api repos/...` works either way.
- **No WebSocket.** srt refuses every upgrade request on a TLS-terminated connection before `filterRequest` runs (`tls-terminate-proxy.js`, "out of scope for now"). A WebSocket therefore never reaches the policy or approval and simply fails. For example, Claude Code's live watch of a published Artifact cannot connect.
- **Approvals are per request.** There is no "allow this for the session" scope, because one path such as `/graphql` covers requests of every kind. A command that makes many out-of-policy requests needs one approval each.
- **Long holds are not tested live.** `probe.sh` approves and denies within a second. Whether a client or srt's server gives up before 240 seconds has not been checked. Node's default `requestTimeout` is 300 seconds, which is why the limit is below it.
- **Not part of strait:** nas features such as file-content masking (maskfs), output masking (sumi) and the audit log.
- **Tested only on Linux.** macOS uses a different srt backend, and the patches have not been checked there.
- **An unexplained failure.** Four launches failed to find a command in `~/.local/bin` (`gh` or `claude`) inside the sandbox. Repeated launches right afterwards did not reproduce it, whether back to back, with or without tokens, or with the command run directly or through `bash -c`. The cause is unknown.

## Tests

```sh
bun run test:strait-unit        # policy, GraphQL, approval, hostexec and config, from the repo root; no srt needed
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

It also checks approval and hostexec: an approved REST read of another repository and an approved GraphQL query outside the list go through, the sandbox cannot see a held request, and an approved host command runs outside the sandbox with only the declared environment and its output masked, while a denied one exits with 126.

The bypass attempts that would be held for approval expect a 403. `probe.sh` runs a background loop that denies every held request as it appears, so do not approve anything while it runs.
