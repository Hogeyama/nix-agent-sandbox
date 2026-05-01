/**
 * Invocation detail page for the history shell.
 *
 * Mirrors `ConversationDetailPage`, swapping the header for the
 * invocation summary and replacing the invocation list with a
 * conversation list (a single invocation can drive multiple
 * conversations when subagents are involved). Trace and span tables
 * are rendered with the same row shapes; only the turn-event table
 * uses the invocation-side projection so each row can link off-page
 * to its conversation.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import type { InvocationDetail } from "../../../../../history/types";
import { buildSpanRows, buildTraceRows } from "./conversationDetailView";
import { formatCompactNumber } from "./historyListView";
import {
  buildConversationLinks,
  buildInvocationHeader,
  buildInvocationTurnEventRows,
} from "./invocationDetailView";

export interface InvocationDetailPageProps {
  detail: () => InvocationDetail | null;
  notFound: () => boolean;
  loading: () => boolean;
  error: () => string | null;
  /** Hash href to the list page; defaults to `#/history`. */
  backHref?: string;
}

const RELATIVE_TICK_MS = 60_000;

export function InvocationDetailPage(props: InvocationDetailPageProps) {
  const [now, setNow] = createSignal(Date.now());
  const interval = setInterval(() => setNow(Date.now()), RELATIVE_TICK_MS);
  onCleanup(() => clearInterval(interval));

  const backHref = () => props.backHref ?? "#/history";

  const header = () => {
    const d = props.detail();
    return d === null ? null : buildInvocationHeader(d, now());
  };
  const conversations = () => {
    const d = props.detail();
    return d === null ? [] : buildConversationLinks(d);
  };
  const traces = () => {
    const d = props.detail();
    return d === null ? [] : buildTraceRows(d.traces, now());
  };
  const spans = () => {
    const d = props.detail();
    return d === null ? [] : buildSpanRows(d.spans, now());
  };
  const turnEvents = () => {
    const d = props.detail();
    return d === null ? [] : buildInvocationTurnEventRows(d.turnEvents, now());
  };

  return (
    <div class="history-shell-content">
      <a class="history-detail-back-link" href={backHref()}>
        ← Back to history
      </a>

      <Show when={props.error()}>
        {(msg) => (
          <div class="history-error" role="alert">
            {msg()}
          </div>
        )}
      </Show>

      <Show when={props.notFound()}>
        <div class="history-detail-not-found">Invocation not found</div>
      </Show>

      <Show when={!props.notFound() && props.loading()}>
        <div class="history-empty" aria-busy="true">
          Loading…
        </div>
      </Show>

      <Show when={!props.notFound() && header()}>
        {(headerAccessor) => {
          const h = headerAccessor();
          return (
            <>
              <header class="history-detail-header">
                <div class="history-detail-header-left">
                  <div class="history-detail-id" title={h.id}>
                    {h.idLabel}
                  </div>
                  <div class="history-detail-meta">
                    <Show when={h.profile}>
                      {(profile) => (
                        <div class="history-detail-meta-item">
                          <span class="history-detail-meta-label">Profile</span>
                          <span class="history-detail-meta-value">
                            {profile()}
                          </span>
                        </div>
                      )}
                    </Show>
                    <Show when={h.agent}>
                      {(agent) => (
                        <div class="history-detail-meta-item">
                          <span class="history-detail-meta-label">Agent</span>
                          <span class="history-detail-meta-value">
                            {agent()}
                          </span>
                        </div>
                      )}
                    </Show>
                    <Show when={h.worktreePath}>
                      {(wt) => (
                        <div class="history-detail-meta-item">
                          <span class="history-detail-meta-label">
                            Worktree
                          </span>
                          <span class="history-detail-meta-value">{wt()}</span>
                        </div>
                      )}
                    </Show>
                    <div class="history-detail-meta-item">
                      <span class="history-detail-meta-label">Started</span>
                      <span
                        class="history-detail-meta-value"
                        title={h.startedAtAbsolute}
                      >
                        {h.startedAt}
                      </span>
                    </div>
                    <Show when={h.endedAt}>
                      {(endedAt) => (
                        <div class="history-detail-meta-item">
                          <span class="history-detail-meta-label">Ended</span>
                          <span
                            class="history-detail-meta-value"
                            title={h.endedAtAbsolute ?? undefined}
                          >
                            {endedAt()}
                          </span>
                        </div>
                      )}
                    </Show>
                    <Show when={h.exitReason}>
                      {(exit) => (
                        <div class="history-detail-meta-item">
                          <span class="history-detail-meta-label">Exit</span>
                          <span class="history-detail-meta-value">
                            {exit()}
                          </span>
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
                <div class="history-detail-stats">
                  <div>
                    <div class="history-detail-stat-label">Turns</div>
                    <div class="history-detail-stat-value">
                      {formatCompactNumber(h.turnCount)}
                    </div>
                  </div>
                  <div>
                    <div class="history-detail-stat-label">Traces</div>
                    <div class="history-detail-stat-value">
                      {formatCompactNumber(h.traceCount)}
                    </div>
                  </div>
                  <div>
                    <div class="history-detail-stat-label">Spans</div>
                    <div class="history-detail-stat-value">
                      {formatCompactNumber(h.spanCount)}
                    </div>
                  </div>
                  <div>
                    <div class="history-detail-stat-label">Tokens</div>
                    <div class="history-detail-stat-value">
                      {formatCompactNumber(h.tokenTotal)}
                    </div>
                  </div>
                </div>
              </header>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">
                  Conversations
                  <span class="history-detail-section-count">
                    {conversations().length} rows
                  </span>
                </h2>
                <Show
                  when={conversations().length > 0}
                  fallback={
                    <div class="history-detail-section-empty">
                      No conversations
                    </div>
                  }
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Id</th>
                        <th scope="col">Agent</th>
                        <th scope="col" class="is-numeric">
                          Turns
                        </th>
                        <th scope="col" class="is-numeric">
                          Spans
                        </th>
                        <th scope="col" class="is-numeric">
                          Tokens
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={conversations()}>
                        {(row) => (
                          <tr>
                            <td class="is-id">
                              <a class="history-row-link" href={row.href}>
                                {row.idLabel}
                              </a>
                            </td>
                            <td>{row.agent ?? ""}</td>
                            <td class="is-numeric">{row.turnCount}</td>
                            <td class="is-numeric">{row.spanCount}</td>
                            <td class="is-numeric">
                              {formatCompactNumber(row.tokenTotal)}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">
                  Traces
                  <span class="history-detail-section-count">
                    {traces().length} rows
                  </span>
                </h2>
                <Show
                  when={traces().length > 0}
                  fallback={
                    <div class="history-detail-section-empty">No traces</div>
                  }
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Trace</th>
                        <th scope="col">Invocation</th>
                        <th scope="col">Started</th>
                        <th scope="col">Ended</th>
                        <th scope="col" class="is-numeric">
                          Spans
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={traces()}>
                        {(row) => (
                          <tr>
                            <td class="is-id" title={row.traceId}>
                              {row.traceIdLabel}
                            </td>
                            <td class="is-id">
                              <a
                                class="history-row-link"
                                href={row.invocationHref}
                              >
                                {row.invocationIdLabel}
                              </a>
                            </td>
                            <td title={row.startedAtAbsolute}>
                              {row.startedAt}
                            </td>
                            <td title={row.endedAtAbsolute ?? undefined}>
                              {row.endedAt ?? ""}
                            </td>
                            <td class="is-numeric">{row.spanCount}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">
                  Spans
                  <span class="history-detail-section-count">
                    {spans().length} rows
                  </span>
                </h2>
                <Show
                  when={spans().length > 0}
                  fallback={
                    <div class="history-detail-section-empty">No spans</div>
                  }
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Span</th>
                        <th scope="col">Parent</th>
                        <th scope="col">Name</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Model</th>
                        <th scope="col" class="is-numeric">
                          In
                        </th>
                        <th scope="col" class="is-numeric">
                          Out
                        </th>
                        <th scope="col" class="is-numeric">
                          Duration
                        </th>
                        <th scope="col">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={spans()}>
                        {(row) => (
                          <tr>
                            <td class="is-id" title={row.spanId}>
                              {row.spanIdLabel}
                            </td>
                            <td class="is-id">{row.parentSpanIdLabel ?? ""}</td>
                            <td>{row.spanName}</td>
                            <td>
                              <span
                                class={
                                  row.kindClass === ""
                                    ? "history-detail-kind"
                                    : `history-detail-kind ${row.kindClass}`
                                }
                              >
                                {row.kindLabel}
                              </span>
                            </td>
                            <td>{row.model ?? ""}</td>
                            <td class="is-numeric">{row.inTok ?? ""}</td>
                            <td class="is-numeric">{row.outTok ?? ""}</td>
                            <td class="is-numeric">
                              {row.durationLabel ?? ""}
                            </td>
                            <td title={row.startedAtAbsolute}>
                              {row.startedAt}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">
                  Turn events
                  <span class="history-detail-section-count">
                    {turnEvents().length} rows
                  </span>
                </h2>
                <Show
                  when={turnEvents().length > 0}
                  fallback={
                    <div class="history-detail-section-empty">
                      No turn events
                    </div>
                  }
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Conversation</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Payload</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={turnEvents()}>
                        {(row) => (
                          <tr>
                            <td title={row.tsAbsolute}>{row.ts}</td>
                            <td class="is-id">
                              <Show
                                when={row.linkHref !== ""}
                                fallback={row.linkIdLabel}
                              >
                                <a class="history-row-link" href={row.linkHref}>
                                  {row.linkIdLabel}
                                </a>
                              </Show>
                            </td>
                            <td>{row.kind}</td>
                            <td>
                              <code class="history-detail-payload-preview">
                                {row.payloadPreview}
                              </code>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>
            </>
          );
        }}
      </Show>
    </div>
  );
}
