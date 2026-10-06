# Changelog

All notable changes to strait are documented in this file. strait is
versioned and released separately from nas, under `strait-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.3.0] - 2026-10-07

### Added

- `"notify"` in `strait.json` picks how a held request is announced: `desktop` (`notify-send`, the default), `terminal` (an OSC 9 notification on the terminal strait runs in), `bell` or `off`. The terminal notification names only the session, never the request, since the URL and the reason come from the sandbox. Inside tmux it is wrapped for passthrough, which needs `set -g allow-passthrough all` (`on` drops notifications from panes that are not shown). The write never blocks: if the terminal stops draining, the notification is dropped rather than stalling the proxy and approvals.

## [0.2.0] - 2026-10-06

### Added

- `trustedGitHubRepos` accepts `owner/*` for every repository of one owner.
- `"trustLinkedIssues": true` lets GraphQL read, without approval, the titles of the issues linked to an issue as its parent, sub-issues or dependencies. Those issues may live in any repository, so this is off by default. `gh issue view` asks for them, so without it every `gh issue view` waits for approval.

### Changed

- **Breaking:** `githubRepos` in `strait.json` is renamed to `trustedGitHubRepos`. The old key is rejected as unknown.
- Reading an allowed repository with a recent gh no longer waits for approval. This covers `gh pr view`, `gh issue view`, `gh issue status`, `gh label list` and `gh release list`, and every `--json` field of `gh pr view`/`list`, `gh issue view`/`list`, `gh label list` and `gh repo view`. Checked with gh 2.102, where `gh issue view` also needs `trustLinkedIssues`.
- `gh pr status` and `gh search` still wait for approval, because they search beyond one repository.
- `strait review web` is easier to read. A GraphQL body is shown as its query, one line per line, and its variables as indented JSON; the raw body stays available under a toggle. A host command is shown as one shell command line, such as `printf '%s|' 'say "hi"' $'a\nb'`, and times are local dates without epoch milliseconds. The details no longer show the command that started the session, which was easy to mistake for the host command.

### Fixed

- Resizing the terminal now reaches the sandboxed command. srt runs bwrap with `--new-session`, so the command was outside the terminal's foreground process group and never got `SIGWINCH`; strait now forwards it.

## [0.1.0] - 2026-10-04

First release.

### Added

- `strait -- <command>` runs a coding agent under Anthropic's srt (sandbox-runtime 0.0.77, patched) with a fixed network policy. Only Anthropic's API, Artifact content hosts and GitHub are reachable, over TLS on port 443. Every request passes strait's policy, and the policy cannot be widened beyond its invariants from configuration.
- srt is patched so that SOCKS tunnels and non-TLS CONNECT streams, which unpatched srt relays without filtering, are cut. strait checks the patches at build time and against the running proxy at every launch, and refuses to start without them.
- GitHub reads of the repositories listed in `strait.json` (`githubRepos`) pass without approval: REST reads, `git fetch`, and GraphQL queries whose fields stay on the paths `gh`'s main commands use. Writes, other repositories, other Anthropic APIs and Artifact content fetches are held for approval; other hosts, cookies, URL userinfo and `access_token` queries are refused.
- Upstream authentication always comes from the host. Inside the sandbox `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the like are dummies; strait replaces the authentication header of each allowed or approved request with the host's credential, whatever the client sent.
- `strait review` approves or denies held requests from another terminal on the host, one request at a time, and `strait review web` does the same from a browser, guarded by a one-time token printed only to the controlling terminal. Held requests are denied after 240 seconds.
- `"hostExec": true` lets the agent ask, with `strait hostexec -- <command>`, to run a command on the host after approval. The command gets only the host's `PATH` and `HOME` plus the variables it declares, and real tokens in its output are masked. Its process group is stopped when the client leaves or strait exits.
- `hosts` in `strait.json` adds hosts reachable without approval, each with the one credential header strait sets for it.
- Sessions have IDs (or `--name`), shown in Claude Code's status line and used by `strait review` to pick the requests of the session started in the current directory.
- The configuration file, strait's own directory and the workspace's `.claude` are read-only inside the sandbox, and the launcher keeps Bun from reading a `bunfig.toml` or `.env` planted in the workspace.
- Release bundles for x86_64 and aarch64 Linux carry Bun and glibc, with license notices and corresponding-source materials. srt's `apply-seccomp` helper is rebuilt from the upstream source with musl. `strait --version` prints the version.
