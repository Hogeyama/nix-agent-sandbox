import { createSignal, For, onCleanup, Show } from "solid-js";
import {
  DEFAULT_HOSTEXEC_SCOPE,
  DEFAULT_NETWORK_SCOPE,
} from "../handlers/createPendingActionHandlers";
import type { AuditLogEntryRow } from "../stores/auditStore";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";
import { formatAuditEntry, summaryFor } from "./auditEntryView";
import { formatRelativeTime, sessionLabel } from "./pendingCardView";

// Network scope chips. The label is what the user reads; the hint is the
// `title` tooltip. `host` and `host:port` promise less than their names
// suggest: the broker consults its approval / denial caches only while
// resolving a rule whose action is `review` (`src/network/broker.ts`
// `authorize`), so denying a host does not stop a later request that an
// explicit `allow` rule matches first. The hint says so, because the
// label cannot.
const NETWORK_SCOPES = [
  {
    id: "once",
    label: "once",
    hint: "Applies to this request only. Nothing is remembered.",
  },
  {
    id: "host-port",
    label: "host:port",
    hint: "Remembered for this session, for this host and port. Requests that an explicit allow or deny rule matches first are unaffected.",
  },
  {
    id: "host",
    label: "host",
    hint: "Remembered for this session, for this host on any port. Requests that an explicit allow or deny rule matches first are unaffected.",
  },
] as const;

const HOSTEXEC_SCOPES = ["once", "capability"] as const;

type Props = {
  network: () => NetworkPendingRow[];
  hostexec: () => HostExecPendingRow[];
  collapsed: () => boolean;
  onToggleCollapse: () => void;
  // Per-card state accessors. The store owns the underlying signals;
  // PendingPane only reads through these getters.
  scopeFor: (key: string) => string | undefined;
  busyFor: (key: string) => boolean;
  errorFor: (key: string) => string | null;
  setScope: (key: string, scope: string) => void;
  // Action callbacks. `scope` is the value shown selected in the UI at
  // the moment the user pressed the button; the deny path on hostexec
  // ignores its parent scope by design (see
  // `createPendingActionHandlers.onDeny`).
  onApprove: (
    row: NetworkPendingRow | HostExecPendingRow,
    scope: string,
  ) => Promise<void>;
  onDeny: (row: NetworkPendingRow | HostExecPendingRow) => Promise<void>;
  // Audit log feed accessor. The store owns the recent-50 trim; the
  // accordion only reads the rows here and renders them newest-first.
  auditEntries: () => AuditLogEntryRow[];
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
    <aside class="pane pane-right" classList={{ collapsed: props.collapsed() }}>
      <Show
        when={!props.collapsed()}
        fallback={
          <button
            type="button"
            class="collapsed-rail"
            aria-label="Expand pending pane"
            aria-expanded={!props.collapsed()}
            aria-controls="pending-pane-content"
            onClick={props.onToggleCollapse}
          />
        }
      >
        <div class="pane-header">
          <div class="pane-title">
            <span class="label">Pending</span>
          </div>
          <button
            class="pane-collapse"
            type="button"
            aria-label="Collapse pending pane"
            aria-expanded={!props.collapsed()}
            aria-controls="pending-pane-content"
            onClick={props.onToggleCollapse}
          >
            ⟩⟩
          </button>
        </div>
        <div class="content" id="pending-pane-content">
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
            {(row) => {
              const scope = () =>
                props.scopeFor(row.key) ?? DEFAULT_NETWORK_SCOPE;
              const busy = () => props.busyFor(row.key);
              const error = () => props.errorFor(row.key);
              return (
                <article class="card" data-pending-key={row.key} tabindex="-1">
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
                  <Show when={row.reviewContext}>
                    {(ctx) => (
                      <div class="card-review-context">
                        <div class="card-review-meta">
                          <span>{ctx().path}</span>
                          <Show when={ctx().contentType}>
                            {(ct) => <span class="card-review-ct">{ct()}</span>}
                          </Show>
                          <span class="card-review-size">
                            {ctx().bodySize}B
                          </span>
                        </div>
                        <Show when={ctx().bodyPreview}>
                          {(body) => (
                            <pre class="card-review-body">{body()}</pre>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <div class="scope-row">
                    <For each={NETWORK_SCOPES}>
                      {(opt) => (
                        <button
                          type="button"
                          class="scope"
                          classList={{ selected: scope() === opt.id }}
                          title={opt.hint}
                          disabled={busy()}
                          onClick={() => props.setScope(row.key, opt.id)}
                        >
                          {opt.label}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="action-row">
                    <button
                      type="button"
                      class="action approve"
                      disabled={busy()}
                      onClick={() => props.onApprove(row, scope())}
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      class="action deny"
                      disabled={busy()}
                      onClick={() => props.onDeny(row)}
                    >
                      Deny
                    </button>
                  </div>
                  <Show when={error()}>
                    {(msg) => <p class="card-error">{msg()}</p>}
                  </Show>
                </article>
              );
            }}
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
            {(row) => {
              const scope = () =>
                props.scopeFor(row.key) ?? DEFAULT_HOSTEXEC_SCOPE;
              const busy = () => props.busyFor(row.key);
              const error = () => props.errorFor(row.key);
              return (
                <article class="card" data-pending-key={row.key} tabindex="-1">
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
                  <Show when={row.integrityChanged}>
                    <p class="card-warning">
                      ⚠ 実行対象ファイルがセッション開始時から変化しています
                    </p>
                  </Show>
                  <div class="scope-row">
                    <For each={HOSTEXEC_SCOPES}>
                      {(opt) => (
                        <button
                          type="button"
                          class="scope"
                          classList={{ selected: scope() === opt }}
                          disabled={busy()}
                          onClick={() => props.setScope(row.key, opt)}
                        >
                          {opt}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="action-row">
                    <button
                      type="button"
                      class="action approve"
                      disabled={busy()}
                      onClick={() => props.onApprove(row, scope())}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      class="action deny"
                      disabled={busy()}
                      onClick={() => props.onDeny(row)}
                    >
                      Deny
                    </button>
                  </div>
                  <Show when={error()}>
                    {(msg) => <p class="card-error">{msg()}</p>}
                  </Show>
                </article>
              );
            }}
          </For>

          <details class="audit-accordion">
            <summary class="audit-summary">
              <span>Audit · recent</span>
              <span class="section-sub">
                {formatSectionCount(props.auditEntries().length)}
              </span>
            </summary>
            <For
              each={props.auditEntries()}
              fallback={<div class="audit-empty">no audit entries</div>}
            >
              {(row) => (
                <div class="audit-row">
                  <span class="audit-time">{formatAuditEntry(row)}</span>
                  <span class="audit-body">
                    {row.domain} · {row.decision}
                  </span>
                  <span class="audit-detail">{summaryFor(row)}</span>
                </div>
              )}
            </For>
          </details>
        </div>
      </Show>
    </aside>
  );
}
