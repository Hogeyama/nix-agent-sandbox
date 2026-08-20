import { createSignal, For, onCleanup, Show } from "solid-js";
import {
  DEFAULT_HOSTEXEC_SCOPE,
  networkScopeFor,
} from "../handlers/createPendingActionHandlers";
import type { AuditLogEntryRow } from "../stores/auditStore";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";
import { formatAuditEntry, summaryFor } from "./auditEntryView";
import {
  askReasonView,
  formatRelativeTime,
  sessionLabel,
} from "./pendingCardView";

// Network scope chips. The label is what the user reads; the hint is the
// `title` tooltip. Which of these a card shows comes from the entry's
// `approvalScopes`, which the broker derives from how specific the matched
// rule is — a card offering `rule` never offers `host` and vice versa.
//
// Every grain is remembered against the rule that raised the confirmation,
// so none of them answers for a different rule pointed at the same host.
// The hints say so, because the labels cannot.
const NETWORK_SCOPE_CHIPS: Record<
  string,
  { readonly label: string; readonly hint: string }
> = {
  once: {
    label: "once",
    hint: "Applies to this request only. Nothing is remembered.",
  },
  rule: {
    label: "this rule",
    hint: "Remembered for this session, for as long as this rule is in effect. The scope pins the host and port, so nothing else is covered.",
  },
  "host-port": {
    label: "host:port",
    hint: "Remembered for this session, for this rule against this host and port. Other rules still ask.",
  },
  host: {
    label: "host",
    hint: "Remembered for this session, for this rule against this host on any port. Other rules still ask.",
  },
  violation: {
    label: "these values",
    hint: "Remembered for this session, for this rule and the values this card is asking about. Any other value, and the same value found by another check, still asks. Violations the rule only records are listed for context and are not remembered.",
  },
};

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
              const scope = () => networkScopeFor(row, props.scopeFor(row.key));
              const busy = () => props.busyFor(row.key);
              const error = () => props.errorFor(row.key);
              return (
                <article class="card" data-pending-key={row.key} tabindex="-1">
                  <div class="card-head">
                    <span class="chip">{sessionLabel(row)}</span>
                    {/* The rule that raised the confirmation is half of what
                        the decision is remembered against, so name it. */}
                    <Show when={row.ruleId}>
                      {(ruleId) => (
                        <span
                          class="chip"
                          title="Rule that raised this confirmation. What you press is remembered for this rule against this target, and for nothing else."
                        >
                          {ruleId()}
                        </span>
                      )}
                    </Show>
                    <span class="card-time">
                      {formatRelativeTime(row.createdAtMs, now())}
                    </span>
                  </div>
                  <p class="card-req">
                    <span class="verb">{row.verb}</span>
                    {row.summary}
                  </p>
                  {/* Why this card exists. Without it the only account the
                      card gives of itself is a rule id, and a `$fallback`
                      pseudo id is not an account. */}
                  <Show when={askReasonView(row.askReason)}>
                    {(reason) => (
                      <p class="card-ask-reason" title={reason().hint}>
                        <span class="card-ask-reason-label">why</span>
                        {reason().label}
                      </p>
                    )}
                  </Show>
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
                      </div>
                    )}
                  </Show>
                  {/* What this confirmation is actually about: the nodes a
                      body inspection refused, each one a thing the approval
                      remembers. The first 1024 bytes of a 100KB body would
                      not show any of them. */}
                  <Show when={row.violations.length > 0}>
                    <div class="card-violations">
                      <For each={row.violations}>
                        {(violation) => (
                          <div class="card-violation">
                            <div class="card-violation-head">
                              <span class="card-violation-value">
                                {violation.value ?? violation.kind}
                              </span>
                              <Show when={violation.count > 1}>
                                <span class="card-violation-count">
                                  ×{violation.count}
                                </span>
                              </Show>
                              <Show when={violation.at}>
                                <span class="card-violation-at">
                                  {violation.at}
                                </span>
                              </Show>
                            </div>
                            <Show when={violation.pointer}>
                              <div class="card-violation-pointer">
                                {violation.pointer}
                              </div>
                            </Show>
                            <Show when={violation.excerpt}>
                              {(excerpt) => (
                                <pre class="card-review-body">{excerpt()}</pre>
                              )}
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  {/* Allowing this request also hands these headers to the
                      host, which is a different grant from letting the bare
                      request through. Header names and secret names only —
                      the value is never on this side of the wire. */}
                  <Show when={row.injectHeaders.length > 0}>
                    <div class="card-inject">
                      <span class="card-inject-label">injects</span>
                      <For each={row.injectHeaders}>
                        {(header) => (
                          <span class="card-inject-header">
                            {header.name}
                            <Show when={header.secrets.length > 0}>
                              {" ← "}
                              {header.secrets.join(", ")}
                            </Show>
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="scope-row">
                    <For each={row.approvalScopes}>
                      {(id) => (
                        <button
                          type="button"
                          class="scope"
                          classList={{ selected: scope() === id }}
                          title={NETWORK_SCOPE_CHIPS[id]?.hint}
                          disabled={busy()}
                          onClick={() => props.setScope(row.key, id)}
                        >
                          {NETWORK_SCOPE_CHIPS[id]?.label ?? id}
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
