---
name: deno-post-change-checks
description: Run the standard post-change verification flow for this Deno project. Use when code, tests, or configuration changed and Codex should finish by running formatting, linting, tests with coverage, then report pass/fail status and the coverage summary to the user.
---

# Deno Post Change Checks

Run the repository's standard verification sequence after making changes. Prefer this skill when the user wants the usual "wrap up" checks instead of ad hoc verification.

## Workflow

1. Run formatting first.

```bash
deno task fmt
```

2. Run lint next.

```bash
deno task lint
```

3. Run tests with coverage instead of plain `deno task test`, so the test pass also produces the report.

```bash
deno test --allow-all --coverage=.coverage
```

4. Show coverage after the test run succeeds.

```bash
deno coverage .coverage
```

## Reporting

Report these items in the final response:

- Whether `fmt`, `lint`, and `test` passed or failed
- Test summary counts when available
- Overall coverage numbers from `deno coverage .coverage`
- Notable low-coverage files if the output highlights them
- Coverage artifact locations if useful, especially `.coverage/` contents

## Failure Handling

If one step fails, stop the sequence there and report the failure clearly.

If the coverage-producing test command fails, say that coverage is incomplete or unavailable rather than guessing.

If dependencies must be downloaded or sandbox/network approval is needed, request it and then continue the workflow.

## Notes

- Prefer the commands above over alternative shortcuts so the workflow stays consistent.
- Do not run both `deno task test` and `deno test --allow-all --coverage=.coverage` unless the user explicitly asks for both.
- Treat `.coverage/` as generated output, not source content.
