# Changelog

All notable changes to maskfs are documented in this file. maskfs is
versioned and released separately from nas, under `maskfs-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.1.0] - 2026-09-21

First release under its own version. Earlier builds were attached to nas
releases and the source lived in `src/maskfs`; it moved to
`contrib/maskfs` for this release.

### Added

- `maskfs`: FUSE overlay that serves a workspace with secret values
  replaced by masked copies on reads, with `readonly` (default) or
  `passthrough` write policy, `--daemon` for background mounting, and
  `--unmount` for tearing a daemon down.
- `maskfs --version`: print the version of the bundled `nas-maskfs`
  engine.
