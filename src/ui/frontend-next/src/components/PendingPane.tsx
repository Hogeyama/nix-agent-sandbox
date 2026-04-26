import { createSignal, For, onCleanup } from "solid-js";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";
import { formatRelativeTime, sessionLabel } from "./pendingCardView";

type Props = {
  network: () => NetworkPendingRow[];
  hostexec: () => HostExecPendingRow[];
};

// One-second tick is fine: the relative-time strings only change at
// whole-second boundaries, and the pane is always mounted so a single
// shared interval is acceptable even when both queues are empty.
const TICK_MS = 1000;

// Pad small counts to two digits ("01", "02", ...) to match the
// section-sub presentation in the design source.
function formatSectionCount(n: number): string {
  return String(n).padStart(2, "0");
}

export function PendingPane(props: Props) {
  const [now, setNow] = createSignal(Date.now());
  const interval = setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => clearInterval(interval));

  return (
    <aside class="pane pane-right">
      <div class="pane-header">
        <div class="pane-title">
          <span class="label">Pending</span>
        </div>
        <button
          class="pane-collapse"
          type="button"
          disabled
          aria-label="collapse"
        >
          ⟩⟩
        </button>
      </div>
      <div class="content">
        <div class="section-label">
          <span>Network · out</span>
          <span class="section-sub">
            {formatSectionCount(props.network().length)}
          </span>
        </div>
        <For
          each={props.network()}
          fallback={<div class="empty">No pending</div>}
        >
          {(row) => (
            <article class="card">
              <div class="card-head">
                <span class="chip">{sessionLabel(row)}</span>
                <span class="card-time">
                  {formatRelativeTime(row.createdAtMs, now())}
                </span>
              </div>
              <p class="card-req">
                <span class="verb">{row.verb}</span>
                {row.summary}
              </p>
              <div class="scope-row">
                <button
                  type="button"
                  class="scope selected"
                  disabled
                  aria-disabled="true"
                >
                  once
                </button>
                <button
                  type="button"
                  class="scope"
                  disabled
                  aria-disabled="true"
                >
                  host:port
                </button>
                <button
                  type="button"
                  class="scope"
                  disabled
                  aria-disabled="true"
                >
                  host
                </button>
              </div>
              <div class="action-row">
                <button
                  type="button"
                  class="action approve"
                  disabled
                  aria-disabled="true"
                >
                  Allow
                </button>
                <button
                  type="button"
                  class="action deny"
                  disabled
                  aria-disabled="true"
                >
                  Deny
                </button>
              </div>
            </article>
          )}
        </For>

        <div class="section-label">
          <span>Host exec · cmd</span>
          <span class="section-sub">
            {formatSectionCount(props.hostexec().length)}
          </span>
        </div>
        <For
          each={props.hostexec()}
          fallback={<div class="empty">No pending</div>}
        >
          {(row) => (
            <article class="card">
              <div class="card-head">
                <span class="chip">{sessionLabel(row)}</span>
                <span class="card-time">
                  {formatRelativeTime(row.createdAtMs, now())}
                </span>
              </div>
              <p class="card-req">
                <span class="verb">run</span>
                {row.command}
              </p>
              <div class="action-row">
                <button
                  type="button"
                  class="action approve"
                  disabled
                  aria-disabled="true"
                >
                  Approve
                </button>
                <button
                  type="button"
                  class="action deny"
                  disabled
                  aria-disabled="true"
                >
                  Deny
                </button>
              </div>
            </article>
          )}
        </For>
      </div>
    </aside>
  );
}
