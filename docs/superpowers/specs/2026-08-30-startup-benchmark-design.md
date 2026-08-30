# Startup Benchmark Design

## Goal

Measure the user-perceived time from invoking a pre-built NAS flake package
until the configured Copilot executable starts inside the container. The
measurement must exclude both the Nix build and container teardown.

## Measurement Boundary

- Before sampling, run `nix build .#default` once and require it to succeed.
- Start each sample immediately before spawning
  `nix run .#default -- copilot`.
- End each sample when a temporary `copilot` executable writes a unique marker
  to stdout as its first action.
- Include flake evaluation, the NAS wrapper and executable startup, config
  loading, pipeline preparation, and container launch.
- Exclude the build, the real Copilot CLI startup, and all teardown after the
  marker is observed.

The harness observes the marker on the host with a monotonic clock. This adds
only local pipe delivery and event-loop wake-up latency to the result and
avoids comparing clocks across the host and container.

## Interface

Add a package script named `benchmark:startup`, invoked as:

```bash
bun run benchmark:startup
```

It takes five samples. The output reports every sample in milliseconds, then
minimum, median, and maximum. Median is the primary comparison metric.

## Components

`src/benchmark/startup.ts` owns pure sample aggregation and marker-stream
scanning. `scripts/benchmark_startup.ts` owns the benchmark lifecycle:

1. Create a temporary directory and an executable file named `copilot`.
2. Make the executable emit a per-run marker immediately and exit successfully.
3. Prepend the temporary directory to `PATH` so NAS resolves and bind-mounts
   the stub as `/usr/local/bin/copilot`.
4. Run `nix build .#default` once.
5. Spawn each `nix run .#default -- copilot` sample without a TTY and inspect
   stdout incrementally.
6. Record the elapsed monotonic time at the first complete marker occurrence.
7. Forward ordinary NAS output so a failed or slow stage remains diagnosable.
8. Remove temporary state in a `finally` block.

The harness must terminate a sample and fail clearly if the command exits
before the marker or if the marker is not observed within 30 seconds.

## Testing

Keep aggregation and marker-stream parsing in `src/benchmark/startup.ts` so
the adjacent `src/benchmark/startup_test.ts` unit test can cover:

- median and extrema for five deliberately unsorted samples;
- detection when a marker is split across stream chunks;
- preservation of non-marker output while detecting the marker.

The actual Nix/Docker benchmark is an explicit developer command, not a unit
test: it depends on the host's Nix, Docker, and trusted `.nas/config.pkl`.

## Scope

This change only establishes the measurement. It does not alter NAS startup
behavior. Performance changes will be selected from verbose timing and system
observations collected with this harness, then compared using the same five
sample median.

## Why — なぜこのアプローチを選んだか

A standalone Bun harness can measure the whole command users invoke while
keeping benchmark-only behavior out of production NAS. A PATH-injected stub
uses the existing Copilot discovery and bind-mount path, so it exercises the
normal launch pipeline but stops before third-party CLI work begins. Building
first makes repeated results reflect startup rather than compilation.

## Why Not — なぜ他の案を選ばなかったか

- **Shell harness** — portable nanosecond timing, incremental stream parsing,
  timeout handling, and cleanup are less reliable across environments.
- **Production benchmark hook** — it would give a slightly closer internal
  endpoint but add a measurement-only branch to the application and would not
  naturally include Nix evaluation before NAS starts.
- **Whole-command timing** — an empty stub exits immediately, but elapsed
  process time still includes container and sidecar teardown, which is outside
  the requested startup boundary.
