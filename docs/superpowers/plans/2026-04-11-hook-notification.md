# `nas hook notification` — Design & Implementation Plan

**Goal:** Add a `nas hook notification` subcommand that agent runtimes (Claude
Code, Copilot CLI) can call from their hooks config to report session
lifecycle events. The main payoff is a dashboard in `nas ui` that answers one
question at a glance: **"which sessions are waiting on me right now?"**

Desktop notifications are a secondary output — the primary purpose of the
command is to update per-session turn state that the UI renders.

---

## Mental Model

Every nas session is always in one of three **turn** states:

| State | Meaning |
|---|---|
| `user-turn` | Ball is in the user's court — input, approval, or acknowledgement needed |
| `agent-turn` | Agent is actively working; user is just waiting |
| `done` | Session has ended; may still need a glance before dismissal |

A session is born in `user-turn` (no prompt submitted yet), flips to
`agent-turn` when the agent starts working on a prompt, and flips back to
`user-turn` when the agent needs attention. On shutdown it becomes `done`.

`nas hook notification` is the single CLI surface for triggering these
transitions. Everything else (desktop notification, UI update) is a side
effect.

---

## Hook Event Mapping

The CLI takes a `--kind` flag with three values. Each agent maps its native
hook events onto these:

| `--kind` | Transition | Claude Code hook | Copilot CLI hook |
|---|---|---|---|
| `start` | → `agent-turn` | `UserPromptSubmit` | `sessionStart` / `userPromptSubmitted` |
| `attention` | → `user-turn` | `Notification` | `notification` (added in v1.0.18, 2026-04-04) |
| `stop` | → `done` | `Stop` | `sessionEnd` |

Example `hooks.json` for Claude Code:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "nas hook notification --kind start" }] }],
    "Notification":    [{ "hooks": [{ "type": "command", "command": "nas hook notification --kind attention" }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "nas hook notification --kind stop" }] }]
  }
}
```

The hook runs **inside** the nas sandbox container, so the session id is
available from an environment variable set by the pipeline (e.g.
`NAS_SESSION_ID`) — no need to parse or correlate the agent's own session id.

---

## Storage: Lightweight Session Store

A new runtime-only store, parallel to `network/registry` and
`hostexec/registry`:

- Location: `$XDG_RUNTIME_DIR/nas/sessions/<session-id>.json`
- Lifecycle: created at pipeline entry (initial state `user-turn`), mutated by
  `nas hook notification`, removed at pipeline teardown
- Schema (minimum viable):

  ```jsonc
  {
    "sessionId": "sess_abc123",
    "agent": "claude-code",
    "profile": "default",
    "worktree": "feature-x",
    "turn": "user-turn",
    "startedAt": "2026-04-11T12:00:00.000Z",
    "lastEventAt": "2026-04-11T12:34:56.000Z",
    "lastEventKind": "attention",
    "lastEventMessage": "Claude needs your input"
  }
  ```

No history, no cross-process queueing. Latest state wins. Persistent history
lives in the existing audit log if we want it later.

---

## UI: Extending the Containers Tab

The existing **Containers tab** (`ContainersTab.tsx`) is the natural home.
Today it lists running containers with Name / Status / Kind / Uptime / PWD.
We add a **Turn** column and sort so `user-turn` rows pin to the top.

### Changes

1. Containers are tagged at startup with a `nas.session_id` label so the
   frontend can join container rows against the session store.
2. Backend `/api/containers` response is enriched with `turn`, `agent`,
   `profile`, `worktree`, `lastEventKind`, `lastEventMessage` joined from the
   session store.
3. Frontend adds a `Turn` column with visual treatment:
   - `user-turn` → yellow badge, bold, pinned to top
   - `agent-turn` → muted badge
   - `done` → faded
4. Row click expands (accordion) to show `lastEventMessage` and raw session
   JSON. If the accordion pattern turns out awkward, fall back to a detail
   route.
5. SSE updates ride on the existing 2-second poll in `/api/events`.

`SessionsTab.tsx` is dead code and gets deleted in the same PR.

---

## Desktop Notification

Reuse `src/lib/notify_utils.ts` (`tryDesktopNotification`). Fire on
`--kind attention` always; on `--kind stop` optionally (configurable).
Skip on `--kind start` — that's not worth interrupting the user for.

Click action opens `nas ui` at the Containers tab (deep link optional, not
MVP-critical). If the UI daemon is not running, the notification still pops;
clicking is a no-op.

Headless fallback: if `DBUS_SESSION_BUS_ADDRESS` is missing, skip the desktop
notification silently — the store update still happens so the UI shows the
right thing next time it is opened.

---

## Out of Scope (Explicitly Deferred)

- **tmux pane activation** — a nice future flag (`--tmux-pane`) that runs
  `tmux select-pane` on `attention`. Trivial to bolt on later.
- **Notification history / audit persistence** — the runtime store is
  ephemeral by design. If we want history later, write-through to the audit
  log.
- **Approve/Deny actions from the UI** — network and hostexec already have
  their own pending/approve flow; we do not duplicate it here.
- **Copilot CLI below v1.0.18** — users on older versions can still use
  `--kind start` / `stop` via `sessionStart` / `sessionEnd`; they just miss
  mid-session `attention` events until they upgrade.
- **Duplicate suppression, mute rules, forwarding to Slack/webhooks** —
  consider after MVP ships and we know what hurts.

---

## Implementation Steps

Execute in order. Each step is independently committable.

- [ ] **Step 1: Delete `SessionsTab.tsx`**
      Remove `src/ui/frontend/src/components/SessionsTab.tsx`. Verify nothing
      imports it (`grep -r SessionsTab src/`). Type-check passes.

- [ ] **Step 2: Add session store module**
      New file `src/sessions/store.ts` with types (`SessionTurn`,
      `SessionRecord`) and CRUD helpers (`createSession`, `updateTurn`,
      `getSession`, `listSessions`, `deleteSession`) backed by
      `$XDG_RUNTIME_DIR/nas/sessions/`. Unit tests co-located.

- [ ] **Step 3: Wire session store into the pipeline**
      At pipeline entry create a `user-turn` record; at teardown delete it.
      Stamp the launched container with a `nas.session_id` label so the UI
      can join. Integration-test via an existing e2e scenario.

- [ ] **Step 4: Add `nas hook notification` command**
      New file `src/cli/hook.ts` registered in `src/cli.ts`. Subcommand
      `notification` takes `--kind start|attention|stop`, reads
      `NAS_SESSION_ID` from env, reads hook payload JSON from stdin
      (best-effort), updates the session store, fires a desktop notification
      on `attention` (and optionally `stop`). Unit tests for the arg parser
      and state transition; integration test that writes to the store.

- [ ] **Step 5: Enrich `/api/containers` with turn data**
      In `src/ui/data.ts` (and/or the containers route), join the session
      store against the container list by `nas.session_id` label. Add
      `turn`, `agent`, `profile`, `worktree`, `lastEventKind`,
      `lastEventMessage` to the response shape.

- [ ] **Step 6: Add `Turn` column to `ContainersTab.tsx`**
      Render the badge, pin `user-turn` rows to the top, keep existing
      columns. Visual polish: color per state, relative time on
      `lastEventAt`.

- [ ] **Step 7: Row expansion (accordion)**
      Click row → expand to show `lastEventMessage` + raw session JSON. If
      this gets ugly, fall back to a `/containers/:id` detail route.

- [ ] **Step 8: Example `hooks.json` docs**
      Add a short section to `README.md` or `docs/` showing the recommended
      hooks config for Claude Code and Copilot CLI.

---

## Open Questions

- Should `--kind stop` pop a desktop notification by default, or only with an
  opt-in flag? Leaning: off by default, `--notify-on-stop` opt-in, because
  most stops are expected and not interesting.
- Do we want `nas hook notification` to also be callable from outside the
  sandbox (for testing / scripting)? If yes, accept `--session <id>`
  explicitly. Probably yes for test ergonomics.
- Where should the `nas.session_id` label be stamped — in the launch stage,
  or is there a more central point? Decide during Step 3.
