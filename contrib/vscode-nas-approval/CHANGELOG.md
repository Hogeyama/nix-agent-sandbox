# Changelog

All notable changes to vscode-nas-approval are documented in this file.
vscode-nas-approval is versioned and released separately from nas, under
`vscode-nas-approval-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- The approvals panel now follows the nas ui pending card layout: session
  and rule chips, verb + target, the "why" line, request context, scope
  chips with a per-scope effect line, and Allow/Deny actions. Network
  violations render as one block each — headline, count, selector,
  pointer, excerpt — instead of a single dimmed line.

### Fixed

- The "pending approval(s)" notification is dismissed when the pending
  count reaches zero, when it is cancelled, or when the review panel is
  opened, instead of lingering after the approvals were resolved
  elsewhere.

## [0.2.0] - 2026-09-21

### Added

- Windows + WSL2 support: when `nasPath` is left as `"nas"` on Windows, the
  extension reaches a `nas` that lives inside WSL. It takes a distro hint
  from the Dev Container authority (best effort only — that encoding is a
  Dev Containers implementation detail) and otherwise probes the distros
  from `wsl.exe -l -q` for a working `nas`.

### Changed

- The extension now activates outside `dev-container` remotes as well, so
  the WSL auto-detection works wherever the UI side runs on Windows.
- `nas-approval.nasPath` is a command line split on whitespace rather than
  a binary path, so a bridge such as `wsl.exe -d <DISTRO> nas` can be set
  explicitly when auto-detection fails.
- A network violation that carries a `label` shows that label in place of its
  value. nas sets it on findings whose value is a per-request identity.

### Fixed

- `NAS: Refresh Approval Session` clears the cached WSL command resolution,
  so retrying after installing `nas` into a distro re-probes instead of
  keeping the stale failure.

## [0.1.0] - 2026-09-18

First release.

### Added

- Surface nas Dev Container approval requests (hostexec / network) as webview
  cards in the attached VS Code window, with approve/deny wired to
  `nas approve` / `nas deny`.
- Status bar item showing the pending approval count, plus
  `NAS: Review Pending Approvals` and `NAS: Refresh Approval Session`
  commands.
- `nas-approval.nasPath` setting for the path to the `nas` binary.
