# Hidden Pending Approval Toast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show notification toasts for approvals hidden by an open Pending pane that is filtered to another session, without duplicating approvals already visible in the pane.

**Architecture:** A pure selector in the existing notification view module computes the complement of the Pending pane's visible approvals from its collapsed, active-session, and `All` state. The notification component groups only those selected rows; `App` supplies the existing pane state and retains the current Review navigation behavior.

**Tech Stack:** TypeScript, SolidJS, Bun, `bun:test`

## Global Constraints

- Follow the repository `AGENTS.md`: runtime is Bun, internal test imports are relative, and `bun run check` is the strict type check.
- Follow `test-policy`: keep this Docker-free unit test beside its source as `*_test.ts`, use `bun:test`, and do not introduce live service dependencies.
- Follow `test-driven-development`: add the selector assertions first, run them and observe the expected missing-export failure, then write production code.
- Follow `post-change-checks` and `verification-before-completion`: run formatting, lint, strict type checking, and the NAS-safe unit test lane in order, and inspect fresh output before committing or claiming completion.
- Preserve the behavior in `docs/superpowers/specs/2026-08-24-hidden-pending-toast-design.md`, including the existing Review action and the open-pane behavior for both `All` and no-active-session states.
- Do not change toast layout, copy, grouping, Pending pane filtering, backend notifications, or pending payload contracts.

---

### Task 1: Notify only for approvals hidden from the Pending pane

**Files:**
- Modify: `src/ui/frontend/src/components/pendingNotificationView_test.ts`
- Modify: `src/ui/frontend/src/components/pendingNotificationView.ts`
- Modify: `src/ui/frontend/src/components/PendingNotifications.tsx`
- Modify: `src/ui/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `NetworkPendingRow[]`, `HostExecPendingRow[]`, `collapsed: boolean`, `activeSessionId: string | null`, and `showAllSessions: boolean`.
- Produces: `selectPendingNotificationRows(network, hostexec, paneState)`, returning `{ network, hostexec }` arrays containing only approvals hidden from the pane.
- Preserves: `PendingNotifications.onReview(sessionId)` and its existing session-selection, filter-reset, and pane-opening behavior.

- [ ] **Step 1: Add failing selector tests**

Extend the import in `src/ui/frontend/src/components/pendingNotificationView_test.ts` and add a focused suite after `groupPendingNotifications`:

```typescript
import {
  filterPendingForSession,
  groupPendingNotifications,
  selectPendingNotificationRows,
} from "./pendingNotificationView";

describe("selectPendingNotificationRows", () => {
  const network = [
    {
      sessionId: "session-a",
      sessionShortId: "aaaaaa",
      createdAtMs: 100,
      verb: "GET",
      summary: "a.example:443",
    },
    {
      sessionId: "session-b",
      sessionShortId: "bbbbbb",
      createdAtMs: 200,
      verb: "POST",
      summary: "b.example:443",
    },
  ];
  const hostexec = [
    {
      sessionId: "session-a",
      sessionShortId: "aaaaaa",
      createdAtMs: 300,
      command: "bun test",
    },
    {
      sessionId: "session-c",
      sessionShortId: "cccccc",
      createdAtMs: 400,
      command: "bun run check",
    },
  ];

  test("selects every approval while the pane is collapsed", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: true,
        activeSessionId: "session-a",
        showAllSessions: false,
      }),
    ).toEqual({ network, hostexec });
  });

  test("selects only other sessions while the pane shows the active session", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: false,
        activeSessionId: "session-a",
        showAllSessions: false,
      }),
    ).toEqual({ network: [network[1]], hostexec: [hostexec[1]] });
  });

  test("selects nothing while the open pane shows All", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: false,
        activeSessionId: "session-a",
        showAllSessions: true,
      }),
    ).toEqual({ network: [], hostexec: [] });
  });

  test("selects nothing when the open pane has no active session", () => {
    expect(
      selectPendingNotificationRows(network, hostexec, {
        collapsed: false,
        activeSessionId: null,
        showAllSessions: false,
      }),
    ).toEqual({ network: [], hostexec: [] });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test src/ui/frontend/src/components/pendingNotificationView_test.ts
```

Expected: FAIL because `pendingNotificationView.ts` does not export `selectPendingNotificationRows`.

- [ ] **Step 3: Implement the pure selector**

Add these types and function to `src/ui/frontend/src/components/pendingNotificationView.ts`, reusing the existing notification row types:

```typescript
type PendingNotificationPaneState = {
  collapsed: boolean;
  activeSessionId: string | null;
  showAllSessions: boolean;
};

type PendingNotificationRows = {
  network: readonly NetworkNotificationRow[];
  hostexec: readonly HostExecNotificationRow[];
};

export function selectPendingNotificationRows(
  network: readonly NetworkNotificationRow[],
  hostexec: readonly HostExecNotificationRow[],
  pane: PendingNotificationPaneState,
): PendingNotificationRows {
  if (pane.collapsed) return { network, hostexec };
  if (pane.showAllSessions || pane.activeSessionId === null) {
    return { network: [], hostexec: [] };
  }
  return {
    network: network.filter((row) => row.sessionId !== pane.activeSessionId),
    hostexec: hostexec.filter((row) => row.sessionId !== pane.activeSessionId),
  };
}
```

- [ ] **Step 4: Wire the selector into the notification component**

Replace `src/ui/frontend/src/components/PendingNotifications.tsx` with:

```tsx
import { For, Show } from "solid-js";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";
import { sessionLabel } from "./pendingCardView";
import {
  groupPendingNotifications,
  selectPendingNotificationRows,
} from "./pendingNotificationView";

type Props = {
  network: () => NetworkPendingRow[];
  hostexec: () => HostExecPendingRow[];
  sessionNameFor: (sessionId: string) => string | undefined;
  collapsed: () => boolean;
  activeSessionId: () => string | null;
  showAllSessions: () => boolean;
  onReview: (sessionId: string) => void;
};

export function PendingNotifications(props: Props) {
  const notificationRows = () =>
    selectPendingNotificationRows(props.network(), props.hostexec(), {
      collapsed: props.collapsed(),
      activeSessionId: props.activeSessionId(),
      showAllSessions: props.showAllSessions(),
    });
  const groups = () => {
    const rows = notificationRows();
    return groupPendingNotifications(rows.network, rows.hostexec);
  };

  const total = () =>
    groups().reduce((sum, group) => sum + group.network + group.hostexec, 0);

  return (
    <>
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">
        {total() > 0
          ? `${total()} approvals waiting across ${groups().length} sessions`
          : ""}
      </div>
      <Show when={total() > 0}>
        <aside class="pending-notifications">
          <div class="pending-notifications-head">
            <span>Approval requested</span>
            <span class="pending-notifications-total">{total()}</span>
          </div>
          <div class="pending-notifications-list">
            <For each={groups()}>
              {(group) => {
                const label = () =>
                  sessionLabel(
                    { sessionShortId: group.sessionShortId },
                    props.sessionNameFor(group.sessionId),
                  );
                return (
                  <div class="pending-notification">
                    <div class="pending-notification-copy">
                      <strong>{label()}</strong>
                      <span class="pending-notification-counts">
                        <Show when={group.network > 0}>
                          {group.network} network
                        </Show>
                        <Show when={group.network > 0 && group.hostexec > 0}>
                          {" · "}
                        </Show>
                        <Show when={group.hostexec > 0}>
                          {group.hostexec} host exec
                        </Show>
                      </span>
                      <span class="pending-notification-summary">
                        {group.latestSummary}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="pending-notification-review"
                      aria-label={`Review approvals for ${label()}`}
                      onClick={() => props.onReview(group.sessionId)}
                    >
                      Review
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </aside>
      </Show>
    </>
  );
}
```

- [ ] **Step 5: Pass the existing pane state from App**

Update the `PendingNotifications` call in `src/ui/frontend/src/App.tsx`:

```tsx
<PendingNotifications
  network={pending.network}
  hostexec={pending.hostexec}
  sessionNameFor={sessionNameFor}
  collapsed={ui.rightCollapsed}
  activeSessionId={activeAgentSessionId}
  showAllSessions={pendingShowAll}
  onReview={(sessionId) => {
    terminals.selectSession(sessionId);
    setPendingShowAll(false);
    if (ui.rightCollapsed()) ui.toggleRightCollapsed();
  }}
/>
```

- [ ] **Step 6: Verify GREEN and project checks**

Run the focused test:

```bash
bun test src/ui/frontend/src/components/pendingNotificationView_test.ts
```

Expected: PASS for the grouping, selector, and existing pane-filter suites.

Then run the repository post-change sequence in order, stopping if any command
fails:

```bash
bun run fmt
bun run lint
bun run check
bun run test:unit
```

Expected: all four commands exit 0 with no formatting changes left, lint or
type errors, or unit-test failures. Report integration/e2e tests as not run
because this verification occurs inside NAS.

- [ ] **Step 7: Commit the implementation**

Use the repository `git-commit` skill to inspect and stage only the four files listed in this task, then commit with a message whose subject is:

```text
fix(ui): surface approvals hidden by another session
```
