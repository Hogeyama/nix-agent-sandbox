# Changelog

All notable changes to sumi are documented in this file. sumi is versioned
and released separately from nas, under `sumi-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

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
