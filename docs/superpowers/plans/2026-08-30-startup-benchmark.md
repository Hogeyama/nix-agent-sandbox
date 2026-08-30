# Startup Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repeatable benchmark for the time from a pre-built `nix run` invocation until a PATH-injected Copilot stub begins executing in the container.

**Architecture:** A small source module owns pure marker parsing and statistics. A Bun script owns temporary stub creation, pre-build, child-process streaming, timeout, aggregation, and cleanup, while the Docker/Nix run remains an explicit developer benchmark.

**Tech Stack:** Bun, TypeScript, Nix flakes, Bun test

## Global Constraints

- Read and follow `AGENTS.md`, `skills/test-policy/SKILL.md`, and `docs/superpowers/specs/2026-08-30-startup-benchmark-design.md`.
- Run `nix build .#default` successfully before taking any sample.
- Start timing immediately before spawning `nix run .#default -- copilot` and stop at the first complete stub marker observed on stdout.
- Take exactly five samples and report each value plus minimum, median, and maximum in milliseconds; median is the primary metric.
- Embed the unique marker in the generated stub; arbitrary host environment variables are not forwarded into the container.
- Run each sample under util-linux `script` so multiplexed profiles receive the TTY required by dtach.
- Capture elapsed time at the marker, but wait for each `nix run` child to exit before starting the next sample.
- Fail if a run exits before its marker or does not produce the marker within 30 seconds.
- Do not change production NAS startup behavior in this task.

---

### Task 1: Add the startup benchmark harness

**Files:**
- Create: `src/benchmark/startup.ts`
- Create: `src/benchmark/startup_test.ts`
- Create: `scripts/benchmark_startup.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `summarizeSamples(samples: readonly number[]): { min: number; median: number; max: number }`
- Produces: `createMarkerScanner(marker: string, onOutput: (text: string) => void): { push(chunk: string): boolean; finish(): void }`
- Produces: package script `benchmark:startup`

- [ ] **Step 1: Write failing unit tests for statistics and streamed marker detection**

Create `src/benchmark/startup_test.ts` with tests that import from the relative
path `./startup.ts` and assert
`summarizeSamples([4100, 3900, 4050, 4200, 4000])` returns
`{ min: 3900, median: 4050, max: 4200 }`; a marker split between two `push`
calls is detected only by the second call; and surrounding non-marker text is
forwarded in its original order after `finish()`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test src/benchmark/startup_test.ts`

Expected: FAIL because `src/benchmark/startup.ts` does not exist.

- [ ] **Step 3: Implement pure statistics and marker-scanning helpers**

Create `src/benchmark/startup.ts`. Sort a copy of the non-empty sample
array numerically for the summary. Implement a scanner that retains at most
`marker.length - 1` trailing characters between chunks, emits confirmed
non-marker text through `onOutput`, returns `true` exactly when the marker is
first completed, and flushes retained non-marker text from `finish()`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bun test src/benchmark/startup_test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Implement benchmark orchestration**

Create `scripts/benchmark_startup.ts`, importing the helpers by the relative
path `../src/benchmark/startup.ts`. When `import.meta.main`, create a temporary directory with
`mkdtemp(join(tmpdir(), "nas-startup-"))`. Write an executable POSIX shell
stub named `copilot` with the unique marker embedded as a safely quoted
literal, and set mode `0o755`. Prepend that directory to
the child `PATH`. Run `nix build .#default` once with inherited output and
abort on non-zero status. Then take five sequential samples by spawning
`script --quiet --return --flush /dev/null -- nix run .#default -- copilot`
with piped stdout, inherited stderr, and ignored stdin. Start `performance.now()`
immediately before each spawn, stream-decode stdout, and capture the sample on
marker detection. Await that child's exit before returning the captured sample
so teardown cannot overlap the next run. Reject on early exit or after 30
seconds, killing a timed-out child. After all samples, print individual
millisecond values and the summary. Always remove the temporary directory
recursively in `finally`.

- [ ] **Step 6: Expose the command**

Add this exact entry to `package.json` scripts:

```json
"benchmark:startup": "bun run scripts/benchmark_startup.ts"
```

- [ ] **Step 7: Run focused verification**

Run: `bun test src/benchmark/startup_test.ts`

Expected: 3 tests pass.

Run: `bun run check`

Expected: exit code 0.

- [ ] **Step 8: Commit the benchmark**

Stage only `src/benchmark/startup.ts`, `src/benchmark/startup_test.ts`,
`scripts/benchmark_startup.ts`, and `package.json`, then commit with a
Conventional Commits message explaining that a PATH-injected stub excludes
third-party agent startup and teardown while preserving the full pre-built
`nix run` path.
