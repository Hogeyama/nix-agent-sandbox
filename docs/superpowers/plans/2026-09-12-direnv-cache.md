# Container nix-direnv Integration Plan

User-approved scope, updated 2026-09-13: use native nix-direnv behavior and reduce nas maintenance. Human checkpoints through implementation remain waived.

## Goal and constraints

Keep the packaged, unmodified nix-direnv 3.2.0 and the existing idempotent loader installation. Limit nas runtime customization to a direnv layout override that separates container profiles from host profiles. Delegate evaluation, invalidation, manual reload and fallback to upstream.

Read `docs/superpowers/specs/2026-09-12-direnv-cache-design.md`, `test-policy`, and `post-change-checks`. Preserve the existing launcher authorization checks and environment ordering. No new user guide, network fetch at startup, Docker volume, or timing-dependent tests. The user's AGENTS.md requires one final full test run.

## Runtime task

Work in `.worktrees/direnv-cache` on `perf/direnv-cache`, starting at `07517339`.

- Simplify `src/docker/embed/direnv-lib.sh`: source upstream and override the public `direnv_layout_dir` function. Use the lowercase layout variable supported by direnv, defaulting to the current project's `.direnv`, and append the nas namespace. Keep HOME/worktree/version separation straightforward.
- Remove copied entry-point functions, temporary function replacement/restoration, private fallback/force flags, cached payload deletion and evaluator termination wrappers.
- Allow the layout override to apply to all direnv layouts. A project's own function override takes precedence; do not wrap it to enforce policy.
- Reduce `src/docker/direnv_cache_integration_test.ts` to nas integration checks. Remove tests that pin nas-specific refresh/failure/manual-reload behavior. Keep deterministic cache reuse and storage separation coverage without sleeps or elapsed-time assertions.
- Run affected tests and shell syntax checks. Do not run the complete suite from the implementation worker.

## Verification and delivery

The controller updates these existing design records, reviews the diff, runs fmt, lint, check and the full suite once, and obtains independent review using `skills/patched-superpowers/code-reviewer-prompt.md` and `.superpowers/review-config.yml`. Review covers the complete simplification diff against `07517339` and respects the explicitly accepted upstream fallback and manual-reload behavior.

Commit using `git-commit`, integrate locally, and report the behavior change and validation. Do not claim Docker image rebuild verification unless performed.
