# Changelog

All notable changes to dind-bridge are documented in this file. dind-bridge
is versioned and released separately from nas, under `dind-bridge-v*` tags.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- Start the Dev Container and its relays without waiting for Docker. Only Docker API requests wait for daemon readiness (up to 30 seconds, retrying on the next request after failure); `ready` now denotes local listeners only. The example entrypoint starts serve in the background without a readiness barrier.
- Forward a repeated request header to Docker as separate lines. BuildKit builds, including `docker compose build`, failed with `no local sources enabled`, because Docker read the session methods BuildKit lists one per line as a single method name.

### Added

- First release. `dind-bridge serve` connects a rootless DinD sidecar to Claude Code's Bash sandbox in a Dev Container without nas: the Docker API and containers' published TCP ports reach commands in the sandbox on `127.0.0.1`.
- `dind-bridge env-file` prints the snippet for Claude Code's `CLAUDE_ENV_FILE`, which starts the sandbox namespace's relay before each Bash command.
- `dind-bridge --version`.
