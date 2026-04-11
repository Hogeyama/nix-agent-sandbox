# `nas hook notification` — Implementation Report

**Date:** 2026-04-11
**Branch:** `claude/nas-hook-notification-design-UZp75`
**Plan:** [`docs/superpowers/plans/2026-04-11-hook-notification.md`](./2026-04-11-hook-notification.md)
**Workflow:** `implement-with-review` skill (planner → plan-reviewer → user LGTM →
implementer × code-reviewer loop per commit)

---

## TL;DR

Added a `nas hook notification --kind start|attention|stop` CLI that agent
hooks (Claude Code, Copilot CLI) call from inside the sandbox to update a
lightweight runtime session store. The `nas ui` Containers tab now shows a
**Turn** column (pinned `You're up` on top), reacts live over SSE, and
supports row expansion to inspect `lastEventMessage` + raw session fields.

All 8 planned commits landed in one branch without scope creep. 1 code-review
reject occurred (later resolved without production code changes), 0 planner
iterations required, 0 plan reviewer rejections.

---

## Commits

| # | Hash | Title | Review result |
|---|------|-------|---------------|
| 1 | `9f51396` | `chore(ui): remove unused SessionsTab component` | approve, 0 findings |
| 2 | `c49df9c` | `feat(sessions): add runtime session store module` | approve, 2 info |
| 3 | `d602c55` | `feat(pipeline): wire session store into pipeline lifecycle` | approve, 0 findings |
| 4 | `b630468` | `feat(cli): add nas hook notification subcommand` | 1 reject → approve, 2 info |
| 5 | `2f7ac3e` | `feat(ui): enrich /api/containers with session turn data` | approve, 0 findings |
| 6 | `6637d67` | `feat(ui): add Turn column and sort to ContainersTab` | approve, 2 info |
| 7 | `c667db8` | `feat(ui): row expansion showing session details` | approve, 2 info |
| 8 | `15b5941` | `docs: example hooks.json config for agents` | approve, 0 findings |

Preceding design commits on the same branch: `a734840`, `c054f5b`.

---

## What shipped

### Runtime session store — `src/sessions/store.ts`

- Types: `SessionTurn` (`user-turn` | `agent-turn` | `done`), `SessionEventKind`
  (`start` | `attention` | `stop`), `SessionRecord`, `SessionRuntimePaths`.
- API: `resolveSessionRuntimePaths`, `createSession`, `readSession`,
  `listSessions`, `updateSessionTurn`, `deleteSession`.
- Location: `$XDG_RUNTIME_DIR/nas/sessions/<id>.json`; overridable via
  `NAS_SESSION_STORE_DIR`.
- Transition map: `start → agent-turn`, `attention → user-turn`,
  `stop → done`. Late-arriving hooks on a missing record create a partial
  `{agent: "unknown", profile: "unknown"}` entry so they still surface in
  the UI.
- Behavior mirrors the network / hostexec registries for consistency
  (`atomicWriteJson`, `readJsonFile`, `safeRemove`, ENOENT tolerance).

### Pipeline integration — `src/stages/session_store.ts`

- New `ProceduralStage` registered after `WorktreeStage`, before `MountStage`.
- `execute`: calls `createSession(...)`, injects
  `["-v", "${hostSessionsDir}:/run/nas/sessions"]` into `dockerArgs`, sets
  `NAS_SESSION_STORE_DIR=/run/nas/sessions` on container envVars.
- `teardown`: calls `deleteSession(...)` best-effort (logs, never throws).
- `NAS_SESSION_ID` is injected in `src/cli.ts` via `initialPrior.envVars`
  (not the stage) to avoid duplication.
- New `NAS_SESSION_ID_LABEL = "nas.session_id"` stamped on agent containers
  by `src/stages/launch.ts` so the UI can join rows.

### CLI — `src/cli/hook.ts`

- `nas hook notification --kind start|attention|stop`.
- Reads `NAS_SESSION_ID` from env; validates against path traversal (`/`,
  `\`, `..`, leading `.`).
- Best-effort stdin JSON read with 50 ms timeout race; extracts `message`
  from `payload.message` / `payload.notification.message` /
  `payload.Notification.message` (truncated to 200 chars).
- Updates the session store via `updateSessionTurn`.
- Fires `tryDesktopNotification` **only** on `--kind attention`.
- **Never fails the hook**: every error path (bad kind, missing env,
  traversal attempt, store failure, notifier throw) exits 0 with a stderr
  warning.
- Dependency injection for `stdinReader` and `notifier` makes every branch
  unit-testable; 25 test cases covering arg parsing, message extraction,
  state transitions, path traversal, malformed stdin, notifier throw, and
  store-update failure.

### UI backend — `src/ui/data.ts`, `src/ui/routes/{api,sse}.ts`

- `UiDataContext` gains `sessionPaths: SessionRuntimePaths`.
- `NasContainerInfo` extended with optional session fields (`sessionId`,
  `turn`, `sessionAgent`, `sessionProfile`, `worktree`, `sessionStartedAt`,
  `lastEventAt`, `lastEventKind`, `lastEventMessage`). `session*` prefix is
  used where names would collide with existing container fields.
- Pure function `joinSessionsToContainers(containers, sessions)` exported
  from `data.ts`, unit-tested for matching / no-label sidecar / orphan
  label / mixed scenarios.
- `/api/containers` forwards the enriched DTO.
- SSE poller adds a `containers` channel on the existing 2 s diff-and-emit
  loop so turn changes push in real time.

### UI frontend — `src/ui/frontend/src/components/ContainersTab.tsx`

- Containers state lifted to `App.tsx`; initial load via
  `api.getContainers()`, live updates via SSE `containers` event
  (`useSSE.ts` registers the new event name).
- New **Turn** column as first column with three variants:
  - `user-turn` → amber bold **"You're up"**, pinned to the top.
  - `agent-turn` → muted gray **"Working"**.
  - `done` → faded **"Done"**.
  - absent (sidecar) → dim `-`.
- Exported `sortContainers` orders user-turn → agent-turn → done → absent,
  with ties broken by `lastEventAt ?? startedAt` desc.
- Row click toggles an inline detail panel below the row:
  - Sidecars show `No session data (sidecar container).`.
  - Otherwise: prominent `lastEventMessage`, KV grid for session ID /
    agent / profile / worktree / turn / started at / last event, and a
    collapsible raw JSON dump.
- Stop button uses `e.stopPropagation()` so it still works inside an
  expanded row. `formatDateTime` guards against invalid ISO strings.
- Deleted `src/ui/frontend/src/components/SessionsTab.tsx` (dead code,
  never mounted).

### Docs

README gets a concise "セッション通知（エージェントフック経由）" section with
a Claude Code `hooks.json` example and a Copilot CLI mapping note
(`notification` hook requires Copilot CLI v1.0.18+).

---

## Decisions and trade-offs

### Bind-mount via a canonical in-container path

The design doc left the bind-mount target open. We went with
`/run/nas/sessions` on the container side, overriding
`NAS_SESSION_STORE_DIR` so the hook inside the sandbox honors it. This
sidesteps host/container `XDG_RUNTIME_DIR` mismatches and doesn't require
the host path to be syntactically valid inside the container.

### `NAS_SESSION_ID` ownership lives in `cli.ts`, not the stage

The plan review noted that putting `NAS_SESSION_ID` both in
`initialPrior.envVars` and in the new stage's output was redundant. We
chose `cli.ts` because the session id is already known at that point —
the stage only owns `NAS_SESSION_STORE_DIR` and the bind-mount.

### Desktop notifications from inside the sandbox are best-effort

`notify-send` / DBus is generally unavailable inside the container, so the
`tryDesktopNotification` call almost always no-ops in practice. The
agreed primary surface is the `nas ui` Containers tab. The call is kept in
a `try/catch` and the code exits cleanly either way. Moving notifications
to a host-side broker was rejected as scope creep.

### Turn change propagation piggybacks on the existing 2 s SSE poller

Rather than pushing events from the hook process itself, we let the
existing `sse.ts` diff-and-emit loop pick up store changes on its next
tick. ~2 s latency is acceptable for a "user's turn" dashboard and keeps
the architecture aligned with the other registries.

### Teardown deletes the session record

The design doc wondered whether `done` records should linger. The
implementation deletes them on pipeline teardown since the container
itself disappears from the Containers tab at the same moment — the UI
never sees a dangling `done` row. Keeping `done` rows around would
require audit-log persistence, which was deferred out of scope.

### Frontend tests

No frontend test infrastructure exists in the repo today. Per the plan
and the code-reviewer's pragmatic read, the `sortContainers` and
`formatDateTime` helpers remain untested — they're pure and exported and
would be easy targets once frontend scaffolding lands.

---

## Open items and concerns (non-blocking)

### Future / nice-to-have

1. **`sessionId` path-traversal guard in the store module.** Today the
   check lives in `src/cli/hook.ts::isSafeSessionId`. When the store
   starts crossing additional trust boundaries (e.g. network plugins),
   the guard should move into `createSession` / `updateSessionTurn` so
   every caller benefits automatically.

2. **`runHookCommand` dispatcher happy path not directly tested.** The
   `sub === "notification"` routing arm is only covered indirectly (the
   underlying function is tested in isolation). Adding a single
   dispatcher test would close the gap.

3. **Usage help text for `hook` is in English** while other subcommands'
   descriptions are Japanese. Trivial consistency fix.

4. **Frontend sort helper (`sortContainers`) and date helper
   (`formatDateTime`) have no unit tests.** They are pure and testable;
   the blocker is just the missing frontend test scaffolding.

5. **Containers with a label but no session record (orphans)** currently
   render as absent. If this ever starts happening in normal operation
   (e.g. because of a teardown race), we should surface it with a muted
   badge rather than making them look like sidecars.

### Product / UX

6. **Copilot CLI pre-v1.0.18 fallback.** Users on older versions can
   still wire `sessionStart` / `sessionEnd`, but mid-session
   `attention` events won't flow. Document this in the README (already
   done) and revisit when v1.0.18+ adoption is broad.

7. **`--kind stop` does not fire a desktop notification.** Deliberate —
   most stops are expected and not interesting. If users ask for it,
   add an opt-in `--notify-on-stop` flag.

8. **No tmux pane activation.** The plan explicitly deferred this. A
   `--tmux-pane` flag that runs `tmux select-pane` on `attention` would
   be an easy follow-up and is a natural fit for tmux-heavy workflows.

9. **Duplicate suppression / mute rules.** A session that flaps between
   `user-turn` and `agent-turn` could spam the user. Consider a debounce
   (coalesce within N seconds) if it becomes annoying in practice.

10. **No forwarding to Slack / webhooks.** Out of scope for MVP.

### Operational

11. **The 9 pre-existing `nix super:` / `loadConfig:` test failures** are
    unrelated to this work (Nix CLI unavailable in the dev sandbox) but
    continue to mask any future test regressions. Worth separating.

12. **No integration test that runs the hook CLI inside a real container
    and verifies the host-side record updates.** The unit tests cover
    the arg parser, state transitions, and error paths, but the
    end-to-end bind-mount + UI refresh path is only manually verifiable.
    Adding an e2e test would require a Docker-backed fixture in the
    `tests/` directory.

---

## How to try it

1. Check out the branch:
   ```bash
   git checkout claude/nas-hook-notification-design-UZp75
   bun install
   bun run build-ui
   ```

2. Drop the example `hooks.json` from `README.md` into `~/.claude/`.

3. Start a session with `nas ...`, then in another terminal run
   `nas ui` and watch the Containers tab. The new session should show
   up with `You're up` until the agent starts working, then flip back
   to `You're up` whenever Claude Code raises a `Notification` hook.

4. Click any row to see the detail panel — raw session JSON, latest
   event message, and a dismiss-by-collapse interaction.

---

## Workflow retrospective

- **Plan loop**: 1 planner pass, 1 plan-reviewer pass, 1 user LGTM. No
  re-planning needed.
- **Commit loop**: 8 implementer passes, 8 code-reviewer passes. One
  reject on Commit 4 (test-coverage warning) that turned out to be a
  stale read — the test already existed. Re-review cleared it.
- **Time budget**: Each implementer + reviewer pair for a feature commit
  ran ~3–5 minutes of background agent work.
- **Observations**:
  - Delegating initial codebase exploration to the planner worked well —
    orchestrator context stayed tight.
  - Reviewer missed the existing store-failure test on Commit 4. A
    pre-run `bun test` + targeted file grep would have avoided the
    false reject.
  - Splitting Commit 6 / 7 proved valuable: Commit 6 was already near
    the upper bound of review-friendliness.
