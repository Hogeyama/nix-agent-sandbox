# Domain Services (`src/domain/`)

Long-lived application service layer shared between CLI (`src/cli/<sub>.ts`)
and UI (`src/ui/data.ts`, `src/ui/routes/api.ts`, daemon). Exists to
consolidate primitive-call sequences that were duplicated across those
call sites into a single testable seam.

Read this file when:
- adding or modifying anything under `src/domain/`,
- you spot CLI and UI invoking the same docker / fs / session / broker
  primitive sequence from two places, or
- you are touching a UI route whose body is a thick primitive-call
  sequence and wondering where to put the logic.

`docs/refactor-ui.md` tracks live progress of this migration (per-service
commit hashes, Phase 2/3 status). Consult it when starting adjacent work
so you know what has already moved and where design rationale lives.

## Tier placement

| tier | role | location | called from | examples |
|---|---|---|---|---|
| L1 | primitive | `src/services/` | Effect only | `FsService`, `DockerService`, `ProcessService` |
| **L2** | **domain (nas-specific, reusable)** | `src/domain/<name>/service.ts` | **plain-async or Effect** | `ContainerQueryService`, `ContainerLifecycleService`, `SessionUiService`, `AuditQueryService`, `TerminalSessionService`, `SessionLaunchService`, `NetworkApprovalService`, `HostExecApprovalService` |
| L3-a | stage-only | `src/stages/<name>/*_service.ts` | Effect only (stage `run()`) | `DindService`, `GitWorktreeService` |
| L3-b | api-only (rare) | `src/ui/routes/<name>_service.ts` | plain-async (HTTP route) | none yet — `sse_diff.ts` stays a pure function |

Call-direction rules:
- L3-a and L3-b may call L1 and L2.
- L3-a and L3-b never call each other — sibling tiers.
- L2 may call L2 (e.g. `ContainerLifecycleService` depends on
  `ContainerQueryService` and `SessionLaunchService`). Declare the
  dependency in `R` honestly and close it at the plain-async adapter.
- Reverse flow (L1→L2, L2→L3) is forbidden.

## When to create an L2 service

Create L2 only when **all** hold:

1. CLI and UI (or multiple UI routes) already call the same primitive
   sequence against the same runtime state.
2. The sequence isn't a one-shot pipeline step — it's CRUD repeated
   during a long-lived process.
3. There's enough composition (filter, join, multi-primitive sequencing,
   typed errors) that a plain helper doesn't capture it cleanly.

If (1) fails, keep it a plain helper until a second caller appears —
premature service extraction costs test surface without payoff.
If (2) fails, it belongs in `src/stages/` as L3-a.

## Canonical implementation — read the template, don't re-derive

**`src/domain/container/service.ts` is the reference.** Read it end-to-end
when starting a new L2 service. It shows: Tag + Live (with honest `R`) +
Fake (with `FakeConfig` overrides) + barrel + module-level `liveDeps =
Layer.mergeAll(...)` + `makeXxxClient(layer?)` plain-async adapter. The
barrel lives at `src/domain/<name>.ts`.

For typed-error variants (`ContainerNotRunningError` throws in Live, UI
route `instanceof`-matches to 409), read
`src/domain/container/lifecycle_service.ts` — specifically how
`makeContainerLifecycleClient` uses `Effect.runPromiseExit` +
`Cause.failureOption` to preserve identity across the plain-async
boundary, and how `src/ui/routes/with_error_handling.ts#mapErrorToResponse`
maps on the route side.

### Invariants to preserve (easy to break, hard to re-derive from code alone)

- **Tag string is `"nas/<Name>Service"`.**
- **Error channel is always `Error`** (or a subclass extending `Error`).
  Do **not** use `Data.TaggedError` — nas-wide convention across
  stages/CLI/UI is `Effect.Effect<T, Error>` + `instanceof` branching.
- **Never `.pipe(Effect.orDie)` on a primitive's methods.** Phase 3
  reverted this exactly because L2 services depend on the typed error
  channel flowing through to UI route `instanceof` maps.
- **Live's `R` is a dependency manifest, not minimized.** Don't nest
  `Effect.provide(...)` inside Live to shrink R — hides transitive deps
  and breaks fake granularity. Same rule as the D1/D2 Ops Tag pattern.
- **`R` is closed at the `makeXxxClient` adapter**, not at the pipeline
  root (L3-a does the latter). Module-level `liveDeps` is legal because
  `Layer` is a pure description.
- **Default Fake overrides are "empty and successful"** so tests override
  only the methods they care about. A wrong Fake is a silent test
  poisoner.
- **Pure types + pure helpers go in `types.ts`**, not `service.ts`. Keeps
  `service.ts` IO-description-only and lets frontend / `ui/data.ts`
  re-import without pulling in Effect.
- **CLI `const client = makeXxxClient()` placement mirrors the existing
  sibling's convention.** network / hostexec CLI do it inside
  `run*Command()`; UI does it module-level. `audit` was once rolled back
  by code-review for deviating.

## Commit granularity

Aim for **one commit per service introduction**, containing:

- `service.ts` + `service_test.ts` (+ `types.ts` if non-trivial).
- Barrel `src/domain/<name>.ts`.
- **Both** CLI and UI call sites migrated to the client.
- All primitive-direct imports from CLI/UI that the service replaces,
  removed.

Splitting creates a half-migrated middle state where `data.ts` mixes
"via service" and "direct primitive" for the same concern. Reviewers and
bisect both suffer. First resort: shrink the v1 service surface (fewer
methods) rather than splitting the migration.

If a split is unavoidable — e.g. `ContainerLifecycleService` (`b21e39a`)
deferred CLI migration to `6330ccc` because the CLI side also required
replacing `defaultBackend` and reshaping `cleanNasContainers` — state the
deferral explicitly in the introducing commit message and keep the
follow-up tightly scoped to finishing that migration only.

## Testing

Target **~6-7 tests** per `service_test.ts` (actual range across existing
services: 6-9):

- **Live 2-3**: real `*ServiceLive` composed with fake primitive layers
  (fake `DockerService` etc. via `Layer.mergeAll`) to exercise the
  `Effect.gen` body.
- **Fake 2-3**: verify default + override semantics of the Fake factory.
- **Client 1**: plain-async round-trip through `makeXxxClient()`.

Skip happy-path cases already covered by broker / integration tests.
**Do** add a test for any non-obvious invariant you want pinned (argument
order, gc position, error prefix) — these don't fail-fast at the type
level and will silently regress otherwise.

### Docker primitive testability

Filesystem and SQLite primitives can be Live-tested in tmpdir. Docker
primitives can't — the process boundary makes OS-level mocking
impractical. Route every docker call through `DockerService` so a fake
can substitute via `Layer.mergeAll`. Never shell out to docker or call
`Bun.spawn("docker", ...)` inside an L2 body.

## Pitfalls

Phase 2/3 mistakes, written down so they don't repeat.

- **`(paths, filter)` argument order**: L2 standardizes on `(paths, ...)`.
  Existing primitives sometimes have `(filter, paths)`. Swaps aren't
  caught by types alone — add a Live test commented `// argument order
  regression`.
- **gc call position**: `network` broker runs gc on listPending /
  approve / deny; `hostexec` runs gc only on listPending. Don't
  copy-paste one service's gc placement onto the other. If you change
  it intentionally, say so in the commit message.
- **broker protocol asymmetry**: `network` deny takes a scope;
  `hostexec` deny doesn't. Service signature, Fake config, and
  plain-async client must all reflect the broker's actual API.
  Copy-pasting from network and leaving `scope?` on hostexec is a
  common slip.
- **Error message prefix contracts**: several services return `Error`
  with prefix strings that routes prefix-match (`"Session not found:"`
  → 404, `"Cannot acknowledge turn in state:"` → 409). Preserve the
  exact prefixes. If you change one, grep the route layer and update
  the matcher in the same commit.
