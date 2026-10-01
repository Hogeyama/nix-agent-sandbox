# Changelog

All notable changes to sumi are documented in this file. sumi is versioned
and released separately from nas, under `sumi-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `sumi serve --secrets-file FILE --listen ADDR` runs a mask broker on the host, so hooks and `run` in another environment, such as a Dev Container, can mask without the secrets file being mounted there. ADDR is a Unix socket path or `unix:///path`.
- `sumi serve --listen tcp://127.0.0.1:PORT` (or `tcp://[::1]:PORT`) lets `sumi run` and the hooks inside Claude Code's Bash sandbox reach the broker through the sandbox's HTTP proxy, which does not allow Unix sockets. Use it on a host that only you log in to.

### Changed

- `--socket PATH` of `hook`, `run` and `init` is replaced by `--server ADDR`, which takes the same forms as `--listen`. Replace `--socket PATH` with `--server PATH`.

## [0.4.1] - 2026-09-30

### Changed

- A canonical padded base64 line in the secrets file masks its decoded value whenever that value is at least 4 bytes, even if it is not valid UTF-8 or contains control characters.

## [0.4.0] - 2026-09-30

### Added

- `sumi --licenses` prints the copyright and license notices of sumi and of the Zig standard library and musl libc statically linked into it. Releases up to 0.3.0 shipped the executable without these notices.

## [0.3.0] - 2026-09-30

### Added

- `sumi hook --agent codex|copilot`: `post-tool` and `prompt` hooks for Codex and GitHub Copilot CLI. Codex tool results are replaced through blocking feedback, and Copilot prompts are masked after attachment expansion. If masking cannot complete, the content is withheld. `init` and `scan` remain Claude-only.
- `--socket SOCKET` as an alternative to `--secrets-file F` for `hook`, `run` and `init`. sumi then keeps no list of values and sends each value to a `nas-mask-filter --serve` broker, which returns it masked. Giving both options is rejected.
- `sumi run SOURCE [--argv0 NAME] -- PROGRAM [ARGS...]` runs a program with its arguments unchanged, for wrappers that replace a whole shell.
- A secrets-file line that is canonical padded base64 also masks its decoded value, when that value is valid UTF-8 of at least 4 bytes without control characters. A trailing newline in the decoded value is dropped.

## [0.2.0] - 2026-09-18

### Changed

- `sumi scan` now registers verified credential masks in user settings, allowing sandboxed Bash to read files with secret values and their copies replaced. Rescans preserve user metadata and unverified paths, report skips and removed masks, and restore settings if saving ownership fails. Authentication destinations remain user-configured.

## [0.1.0] - 2026-09-14

First release under its own version. Earlier builds were attached to nas
releases up to v0.17.0 and reported a commit hash from `sumi --version`.

### Added

- `sumi init`: install Claude Code hooks and a shell prefix that mask listed values in `Read`, `Grep`, `Bash` and other tool output, keeping existing Bash permission rules effective.
- Prompt hook: reject prompts carrying a listed value and `@` attachments whose content holds one or cannot be verified.
- Automatic masking of URL-encoded and base64 variants of listed values, including embedded values and 76-column base64 wrapping.
- `sumi scan`: list project files holding a value in `sandbox.filesystem.denyRead`, so sandboxed Bash cannot read them while `Read` and `Grep` keep their masked view. See [README](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/contrib/sumi/README.md#秘密を置き換えたファイルを-bash-から読むオプショナル).
