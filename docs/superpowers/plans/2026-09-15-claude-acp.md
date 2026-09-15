# Claude ACP Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with skills/patched-superpowers task reviewers. Human review gates are waived by the user's explicit instruction.

**Goal:** Run Claude ACP inside nas with protocol-clean stdio and independent file diagnostics.

**Architecture:** Add a profile execution mode while reusing Claude identity and sandbox stages. Run a user-provided adapter from the container PATH and isolate protocol I/O at process boundaries.

**Tech Stack:** Bun, TypeScript, Effect, Pkl, Docker, Bash; claude-agent-acp supplied by the user's environment.

**Spec:** docs/superpowers/specs/2026-09-15-claude-acp-design.md

## Global Constraints

- Read AGENTS.md and skills/security-constraints, skills/effect-separation, skills/test-policy, skills/git-commit and skills/post-change-checks before touching corresponding code.
- `agent = "claude"` remains the identity. `mode = "terminal" | "acp"`, absent means terminal.
- No human intermediate review. Fresh implementer/task reviewer and a final whole-change reviewer; no worker-spawned subagents.
- Existing terminal and JSON command behavior must be preserved. ACP stdout is protocol-only; stdin must not feed nas prompts.
- First ACP release rejects worktree creation, guide injection and additional agent arguments. Inherited multiplex is bypassed.
- Docker unavailable means container E2E unverified, never a claimed pass. Unit tests must not reach live Docker.
- Runtime tools may live outside the repo under /workspace/scratch/1f6ad94dcbe7/tooling; avoid committing generated local tooling or unrelated dependency changes.

### Task 1: Profile contract and adapter invocation

Files: src/config/{Schema.pkl,types.ts,validate.ts}, src/agents/{types.ts,registry.ts,claude.ts}, src/stages/mount/stage.ts; colocated tests.

- [x] Add optional TypeScript mode with Pkl terminal default; reject unsupported agents and ACP-specific unsupported profile settings with actionable messages.
- [x] Thread mode into pure agent configuration and reuse existing Claude mounts. Require an installed Claude binary in ACP; set `CLAUDE_CODE_EXECUTABLE` and invoke `claude-agent-acp` from the container PATH.
- [x] Leave the adapter and its runtime to the user's environment (Nix devShell, direnv or mounts). Set additional CA trust for Node.
- [x] Add focused config/agent tests, inspect resulting diff, commit with git-commit skill, report exact test evidence.

### Task 2: Protocol stdio and lifecycle, with independent diagnostics

Files: src/cli.ts and focused CLI helpers/tests, src/log.ts and tests, src/services/docker.ts, src/docker/client.ts, src/stages/launch/*, src/docker/embed/{entrypoint.sh,direnv-exec.sh}, configuration loading paths if needed, usage documentation.

- [x] Parse `--log-file` before profile and before `--`; open host file with 0600/append, fail on open errors, send only nas diagnostic events to file. Keep data outputs separate.
- [x] Guarantee bootstrap, logs, process helpers, Effect logger and shutdown cannot pollute ACP stdout. Route bootstrap child output to stderr while forwarding only adapter protocol to stdout.
- [x] Guarantee nas prompts do not consume protocol stdin; reject ACP dtach invocation and CLI agent args; bypass inherited multiplex; explicit no-TTY Docker launch.
- [x] Propagate mode through launch options and control EOF, SIGINT/SIGTERM, output disconnect, nonzero exits and cleanup. Do not change terminal behavior incidentally.
- [x] Exercise protocol/log separation and lifecycle using fake processes and shell fixtures; test prelaunch errors and optional log file failure. Commit and report.

### Task 3: User documentation and full validation

Files: README.md and docs-site docs as appropriate (read docs-site/AGENTS.md); focused test fixes only if required by verification.

- [x] Document profile inheritance, editor command/args/cwd, initial host login, unsupported settings, rebuilding existing images, log file usage and client/MCP trust boundary.
- [x] Run repository fmt, lint, check, unit sequence and record results/limitations. If feasible, exercise installed adapter initialize without credentials, with exact runtime/package versions.
- [ ] Task review and final whole-change review; fix concrete findings in individual commits and re-review.
- [ ] Leave a reviewable feature branch and create draft GitHub PR if connector permits. Do not merge.
