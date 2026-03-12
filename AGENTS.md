# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start Commands

```bash
# Development and testing
deno task dev              # Run with all permissions (useful for quick testing)
deno task test             # Run tests: `deno test --allow-all`
deno task test <pattern>   # Run specific test file, e.g., `deno task test config_test`
deno task lint             # Check code style
deno task fmt              # Format code
deno task check            # Type check (uses strict mode)

# Building
deno task compile          # Build standalone binary: `deno compile --allow-all --include src/docker/embed/ --output nas main.ts`

# Development with Nix
nix develop               # Enter dev shell (provides Deno only)
```

## Project Overview

**nas** (Nix Agent Sandbox) is a Deno CLI tool that creates isolated Docker environments for running AI agents (Claude Code / GitHub Copilot CLI) with optional Nix integration. It uses a pipeline architecture where each stage modifies a shared execution context.

### Key Concepts

- **Pipeline Pattern**: Stages (`Stage` interface in `src/pipeline/pipeline.ts`) are executed sequentially, each receiving and modifying an `ExecutionContext`
- **ExecutionContext**: Central data structure passed through the pipeline containing config, profile, Docker args, mount points, environment variables, and the agent command to execute
- **Configuration**: YAML-based (`.agent-sandbox.yml`) with profile support; config is searched upward from current directory
- **Embedding**: `src/docker/embed/` contains Dockerfile and entrypoint.sh that get embedded in the compiled binary using `--include`

### Architecture Diagram

```
Input: Profile name + agent args
  ↓
WorktreeStage          (Creates git worktree with named branch if configured; teardown cleans up based on cleanup strategy)
  ↓
DockerBuildStage       (Builds/uses Docker image)
  ↓
NixDetectStage         (Checks for flake.nix, resolves "auto" setting)
  ↓
MountStage             (Builds mount points and docker args)
  ↓
DindStage              (Starts DinD rootless sidecar if docker.enable; shared mode reuses existing sidecar)
  ↓
LaunchStage            (Starts container, drops UID, runs agent)
  ↓
Output: Exit code from agent process
```

## File Structure

```
src/
  cli.ts                 # Entry point: argument parsing, subcommand routing, stage orchestration
  config/
    types.ts             # Config/Profile interfaces (RawConfig vs Config after validation)
    load.ts              # YAML loading, profile resolution, searching for .agent-sandbox.yml
    validate.ts          # validateConfig() - fills defaults, validates agent types
  pipeline/
    context.ts           # ExecutionContext interface & createContext()
    pipeline.ts          # Stage interface & runPipeline()
  stages/
    worktree.ts          # Creates git worktree with named branch, teardown cleanup, and management subcommands
    nix_detect.ts        # Resolves nix.enable="auto" by checking flake.nix existence
    mount.ts             # Assembles docker mount args, env vars (static + command-based)
    dind.ts              # DinD rootless sidecar lifecycle (start, readiness, teardown; shared mode)
    launch.ts            # DockerBuildStage (builds/rebuilds image) & LaunchStage (docker run)
  docker/
    client.ts            # Docker CLI wrappers (run, build, image existence checks)
    embed/
      Dockerfile         # Base: ubuntu:24.04 with git, curl, Docker CLI, gh, ripgrep, fd, Python, Node, gcloud
      entrypoint.sh      # Manages overlay, UID/GID drop, nix socket binding, agent launch
  agents/
    claude.ts            # Claude Code specific: ~/.claude/ mount, auth config
    copilot.ts           # Copilot CLI specific: ~/.config/.copilot/ mount, GITHUB_TOKEN env
tests/
  config_test.ts         # validateConfig() tests
  pipeline_test.ts       # runPipeline() tests
  mount_stage_test.ts    # Mount stage logic tests
```

## Key Implementation Details

### Configuration Loading

- `loadConfig()` searches for `.agent-sandbox.yml` starting from cwd and moving up
- `resolveProfile()` returns the selected profile (falls back to `config.default`)
- `validateConfig()` applies defaults: `nix.enable="auto"`, `docker.enable=false`, `docker.shared=false`, `env=[]`, etc.

### Pipeline Context

- `ExecutionContext` contains the full state that stages read/modify
- Key fields: `profile`, `workDir` (may change if worktree created), `imageName`, `dockerArgs`, `envVars`, `nixEnabled`, `agentCommand`
- Each stage is responsible for updating relevant fields

### Docker Integration

- `dockerImageExists()` checks if image is cached
- `--include src/docker/embed/` ensures Dockerfile and entrypoint.sh are bundled in the binary
- Entrypoint runs as root, then drops to host UID (preserves file ownership)

### Nix Integration

- When `nix.enable=true`, agent is launched via `nix develop` (or `nix shell` if `extra-packages`)
- Host's `/nix` directory is mounted; `NIX_REMOTE=daemon` points to host daemon
- No Nix needs to be installed in container

### Environment Variables

Config supports two formats:
- Static: `{ key: "VAR_NAME", val: "static-value" }`
- Command-based: `{ key_cmd: "echo VAR_NAME", val_cmd: "command-to-get-value" }`

Commands are executed during mount stage, results injected as env vars.

## Testing

```bash
# Run all tests
deno task test

# Run specific test file
deno task test tests/config_test.ts

# Tests use Deno.test() and @std/assert for assertions
# Example: assertEquals(), assertThrows()
```

## Important Notes

- Agent binaries must be **standalone ELF binaries** (not npm-installed with node_modules)
- `deno compile --include` is critical for bundling embedded files (Dockerfile, entrypoint.sh)
- Entrypoint uses `overlay.sh` (unionfs) for temporary changes during container run
- File ownership in container is preserved via UID/GID mapping (no chown needed)
- Tests should import from relative paths, not use import maps for internal modules
