# Changelog

All notable changes to vscode-nas-approval are documented in this file.
vscode-nas-approval is versioned and released separately from nas, under
`vscode-nas-approval-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

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
