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

4. Run the test lane required by the change's scope.

Use the repository's Nix development environment (or equivalent installed
build tools). `test:unit` now includes Zig suites as well as Bun suites;
addon Python wrappers also require Python and the generated vendor dependencies.
Inspect [package.json](../../package.json) for the current aggregate membership.

After a substantial change, run the complete aggregate even when working
inside NAS:

```bash
bun run test
```

A change is substantial when it crosses multiple components or changes
pipeline behavior, Docker or process lifecycle, security or resource
isolation, test aggregation, CI, release behavior, integration tests, or E2E
behavior. Also use the complete aggregate when the user requests thorough or
final verification. When uncertain whether the affected surface is narrow,
prefer the complete aggregate.

For a narrow ordinary change inside NAS, use the unit aggregate:

```bash
bun run test:unit
```

Outside NAS, when Docker and the other integration dependencies are directly
available, run the full suite:

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

Inside NAS, the complete aggregate may skip tests whose capabilities are not
available. Report those skips as unverified, not passed. If skipped coverage is
material to the change, it still needs a run in an environment where the
dependency is directly available. Do not switch to host execution merely to
fill skips unless the user asks for or authorizes that environment change.

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

- Whether `fmt`, `lint`, `check`, and the selected test lane passed or failed
- Test summary counts by suite/runtime when available; distinguish skips and
  cached Zig successes from tests actually rerun
- Which integration/e2e tests were skipped or not run and why; do not infer
  coverage merely from running inside NAS
- If the complete aggregate was not run, why the change qualified for the
  narrower lane
- Notable failures or errors if the output highlights them

## Failure Handling

If one step fails, stop the sequence there and report the failure clearly.
Let a running test aggregate finish its selected suites before reporting its
result; its continue-on-error behavior does not turn failures into success.

If dependencies must be downloaded or sandbox/network approval is needed, request it and then continue the workflow.

## Notes

- Prefer the commands above over alternative shortcuts so the workflow stays consistent.
- `src/` contains Docker integration tests, so `bun test src/` is not a unit-only substitute. Use `bun run test:unit`.
