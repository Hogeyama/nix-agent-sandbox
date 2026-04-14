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

4. Run tests.

```bash
bun test
```

## Reporting

Report these items in the final response:

- Whether `fmt`, `lint`, `check`, and `test` passed or failed
- Test summary counts when available
- Notable failures or errors if the output highlights them

## Failure Handling

If one step fails, stop the sequence there and report the failure clearly.

If dependencies must be downloaded or sandbox/network approval is needed, request it and then continue the workflow.

## Notes

- Prefer the commands above over alternative shortcuts so the workflow stays consistent.
- Integration tests (`tests/`) require Docker. If the user only changed unit-testable code, `bun test src/` is sufficient.
