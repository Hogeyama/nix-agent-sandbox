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
