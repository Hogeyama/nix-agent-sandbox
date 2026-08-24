---
name: post-change-checks
description: Run the standard post-change verification flow for this Bun project. Use when code, tests, or configuration changed and you should finish by running formatting, linting, type checking, and tests, then report pass/fail status to the user.
---

# Post Change Checks

Run the repository's standard verification sequence after making changes. Prefer this skill when the user wants the usual "wrap up" checks instead of ad hoc verification.

## Workflow

1. Run formatting first.

```bash
bun run fmt
```

2. Run lint next.

```bash
bun run lint
```

3. Run type check.

```bash
bun run check
```

4. Run the test lane for the current environment.

Inside NAS, run unit tests only:

```bash
bun run test:unit
```

Do not run `bun test`, `bun run test`, or `bun test src/` as the standard NAS
verification path. `bun test` is not routed through hostexec, and integration
test modules can execute `docker info` probes while being imported, causing the
run to hang instead of reaching an approval flow. This constraint applies even
when interactive hostexec approval is available.

Outside NAS, when Docker and the other integration dependencies are directly
available, run the full suite:

```bash
bun test
```

If integration or e2e verification is required while working inside NAS,
report that it was not run and must be executed in an environment where those
dependencies are directly available. Do not bypass the boundary with an
absolute host path, a permissive rule, or an already-allowed parent process.

## Reporting

Report these items in the final response:

- Whether `fmt`, `lint`, `check`, and the selected test lane passed or failed
- Test summary counts when available
- Whether integration/e2e tests were not run because verification occurred
  inside NAS
- Notable failures or errors if the output highlights them

## Failure Handling

If one step fails, stop the sequence there and report the failure clearly.

If dependencies must be downloaded or sandbox/network approval is needed, request it and then continue the workflow.

## Notes

- Prefer the commands above over alternative shortcuts so the workflow stays consistent.
- `src/` contains Docker integration tests, so `bun test src/` is not a unit-only substitute. Use `bun run test:unit`.
