---
name: post-change-checks
description: Run the standard post-change verification flow for this Bun and Zig project. Use when code, tests, or configuration changed and you should finish by running formatting, linting, type checking, and tests, then report pass/fail status to the user.
---

# Post Change Checks

Run the repository's standard verification sequence after making changes. Prefer this skill when the user wants the usual "wrap up" checks instead of ad hoc verification.

## Workflow

1. Run formatting first.

```bash
bun run fmt
```

`fmt` covers the Biome-managed files. When Zig files changed, also run
`zig fmt` on those files and verify them with `zig fmt --check`.

2. Run lint next.

```bash
bun run lint
```

This is the aggregate for every `lint:*` script, including Biome,
ast-grep rule tests and scanning, and composed-effects checks. Do not
substitute `lint:biome` or run each child again separately.

3. Run type check.

```bash
bun run check
```

`check` currently includes the lint aggregate as well as TypeScript checks.

4. Before ending the work session, run the full suite in NAS and on the host.

Use the repository's Nix development environment (or equivalent installed
build tools). `test:unit` now includes Zig suites as well as Bun suites;
addon Python wrappers also require Python and the generated vendor dependencies.
Inspect [package.json](../../package.json) for the current aggregate membership.

Inside NAS, run both commands from the repository root, once each as the final
check for the session, including narrow changes:

```bash
bun run test
hostexec bun run test
```

Run them sequentially and record both exit statuses. Run the second even if
the first fails; do not join them with `&&`. The user has requested both
environments as the standard final verification, so do not ask again whether
to include the host run. If host execution is denied or unavailable, report
that check as not run with its reason.

While iterating, use the unit aggregate or focused tests:

```bash
bun run test:unit
```

When already working on the host, run the full suite directly:

```bash
bun run test
```

Plain `bun test` only discovers Bun tests; it does not run the Zig or sumi
black-box suites. `test`, `test:unit`, and `test:integration` explicitly
aggregate component suites without overlapping them. They finish the other
selected suites after a failure and then return a nonzero status.

Use the aggregate scripts rather than plain `bun test` or `bun test src/`.
Plain discovery does not include every native or black-box suite and may import
Docker probes outside the intended lanes.

Keep the NAS and host results separate: their dependencies and wrapper
environments differ, and either can catch failures the other misses. Report
skipped tests as unverified in that environment, not passed.

## Reading aggregate output

Test aggregates use [scripts/run_tests.ts](../../scripts/run_tests.ts).
They print each suite's start and result, then a final `Test results` table.
`PASS` means the suite command exited successfully; the `Suites:` totals
count suite commands, not individual tests. Use the per-suite summaries
for test counts and skips. A Zig `(cached)` summary includes cached test
steps; do not count those as freshly run. Consult its full log to distinguish
cached and executed steps.

Successful suites keep their detailed output in logs. `Logs:` and
`Full logs:` show the temporary directory; each suite has a file named
with colons replaced by hyphens, such as `test-nas-ts-unit.log`.
Read that file for skip names, warnings, or details absent from the summary.
Failing suites also print their full log to the terminal. Preserve needed
logs before temporary-directory cleanup; rerunning is not necessary just
to recover output. Direct component commands, such as
`bun run test:nas-ts-unit`, still print their normal detailed output.

## Reporting

Report these items in the final response:

- Whether `fmt`, `lint`, and `check` passed or failed
- Separate pass/fail results and log locations for `bun run test` inside NAS
  and `hostexec bun run test` on the host
- Test summary counts by suite/runtime when available; distinguish skips and
  cached Zig successes from tests actually rerun
- Which integration/e2e tests were skipped or not run and why; do not infer
  coverage merely from running inside NAS
- If either final test run could not be executed, which one and why
- Notable failures or errors if the output highlights them

## Failure Handling

If formatting, lint, or type checking fails, fix it before starting the tests
or report the blocker. Once testing starts, let each aggregate finish its
selected suites and run both environments even if one fails. Report each
failure clearly; continue-on-error behavior does not turn failures into success.

If dependencies must be downloaded or sandbox/network approval is needed, request it and then continue the workflow.

## Notes

- Prefer the commands above over alternative shortcuts so the workflow stays consistent.
- `src/` contains Docker integration tests, so `bun test src/` is not a unit-only substitute. Use `bun run test:unit`.
