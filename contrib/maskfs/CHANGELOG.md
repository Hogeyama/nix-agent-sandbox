# Changelog

All notable changes to maskfs are documented in this file. maskfs is
versioned and released separately from nas, under `maskfs-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.2.0] - 2026-09-21

First independent release. Earlier builds were attached to nas releases
and the Nix package used version 0.1.0.

### Added

- `maskfs --version`: print the version of the bundled `nas-maskfs`
  engine.

### Changed

- Release maskfs separately under `maskfs-v*` tags, with a rolling
  `maskfs-latest` download URL. Move its source from `src/maskfs` to
  `contrib/maskfs` and use `VERSION` as the release version source.
