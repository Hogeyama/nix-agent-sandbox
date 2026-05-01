/**
 * Conversation detail page for the history shell.
 *
 * Mirror of `HistoryListPage`: a thin presentation layer over the
 * SSE-delivered `ConversationDetail` payload owned by `HistoryShell`.
 * Per-row formatting (id shortening, relative time, payload preview)
 * lives in `conversationDetailView.ts` so it can be exercised without
 * a Solid runtime.
 *
 * Display states:
 *   - error: render the connection-error banner above the body so a
 *     transient socket drop does not blank the page.
 *   - not-found: backend said the row does not exist; render a stub
 *     and a back link to the list.
 *   - loading: no payload yet → render a single placeholder.
 *   - populated: header + invocations / traces / spans / turn-events.
 *
 * A `createSignal`-driven 1-minute tick refreshes relative timestamps
 * without a fresh snapshot.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import type { ConversationDetail } from "../../../../../history/types";
import {
  buildConversationHeader,
  buildConversationTurnEventRows,
  buildInvocationLinks,
  buildSpanRows,
  buildTraceRows,
} from "./conversationDetailView";

export interface ConversationDetailPageProps {
  detail: () => ConversationDetail | null;
  notFound: () => boolean;
  loading: () => boolean;
  error: () => string | null;
  /** Hash href to the list page; defaults to `#/history`. */
  backHref?: string;
}

const RELATIVE_TICK_MS = 60_000;

export function ConversationDetailPage(props: ConversationDetailPageProps) {
  const [now, setNow] = createSignal(Date.now());
  const interval = setInterval(() => setNow(Date.now()), RELATIVE_TICK_MS);
  onCleanup(() => clearInterval(interval));

  const backHref = () => props.backHref ?? "#/history";

  const header = () => {
    const d = props.detail();
    return d === null ? null : buildConversationHeader(d, now());
  };
  const invocations = () => {
    const d = props.detail();
    return d === null ? [] : buildInvocationLinks(d, now());
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
    return d === null
      ? []
      : buildConversationTurnEventRows(d.turnEvents, now());
  };

  return (
    <div class="history-detail">
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
        <div class="history-detail-not-found">Conversation not found.</div>
      </Show>

      <Show when={!props.notFound() && props.loading()}>
        <div class="history-placeholder" aria-busy="true">
          Loading…
        </div>
      </Show>

      <Show when={!props.notFound() && header()}>
        {(headerAccessor) => {
          const h = headerAccessor();
          return (
            <>
              <header class="history-detail-header">
                <h1 class="settings-page-heading" title={h.id}>
                  Conversation {h.idLabel}
                </h1>
                <dl class="history-detail-meta">
                  <dt>Agent</dt>
                  <dd>{h.agent}</dd>
                  <dt>First seen</dt>
                  <dd title={h.firstSeenAbsolute}>{h.firstSeen}</dd>
                  <dt>Last seen</dt>
                  <dd title={h.lastSeenAbsolute}>{h.lastSeen}</dd>
                  <dt>Turns</dt>
                  <dd>{h.turnCount}</dd>
                  <dt>Spans</dt>
                  <dd>{h.spanCount}</dd>
                  <dt>Invocations</dt>
                  <dd>{h.invocationCount}</dd>
                  <dt>Tokens (in / out)</dt>
                  <dd>
                    {h.inputTokens} / {h.outputTokens}
                  </dd>
                  <dt>Cache (read / write)</dt>
                  <dd>
                    {h.cacheReadTokens} / {h.cacheWriteTokens}
                  </dd>
                </dl>
              </header>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">Invocations</h2>
                <Show
                  when={invocations().length > 0}
                  fallback={<p class="history-detail-empty">No invocations.</p>}
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Id</th>
                        <th scope="col">Profile</th>
                        <th scope="col">Worktree</th>
                        <th scope="col">Started</th>
                        <th scope="col">Ended</th>
                        <th scope="col">Exit</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={invocations()}>
                        {(row) => (
                          <tr class="history-detail-row">
                            <td class="history-cell-id">
                              <a class="history-row-link" href={row.href}>
                                {row.idLabel}
                              </a>
                            </td>
                            <td>{row.profile}</td>
                            <td>{row.worktreePath}</td>
                            <td title={row.startedAtAbsolute}>
                              {row.startedAt}
                            </td>
                            <td title={row.endedAtAbsolute}>{row.endedAt}</td>
                            <td>{row.exitReason}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">Traces</h2>
                <Show
                  when={traces().length > 0}
                  fallback={<p class="history-detail-empty">No traces.</p>}
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Trace</th>
                        <th scope="col">Invocation</th>
                        <th scope="col">Started</th>
                        <th scope="col">Ended</th>
                        <th scope="col" class="history-num-col">
                          Spans
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={traces()}>
                        {(row) => (
                          <tr class="history-detail-row">
                            <td class="history-cell-id" title={row.traceId}>
                              {row.traceIdLabel}
                            </td>
                            <td class="history-cell-id">
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
                            <td title={row.endedAtAbsolute}>{row.endedAt}</td>
                            <td class="history-cell-num">{row.spanCount}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">Spans</h2>
                <Show
                  when={spans().length > 0}
                  fallback={<p class="history-detail-empty">No spans.</p>}
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Span</th>
                        <th scope="col">Parent</th>
                        <th scope="col">Name</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Model</th>
                        <th scope="col" class="history-num-col">
                          In
                        </th>
                        <th scope="col" class="history-num-col">
                          Out
                        </th>
                        <th scope="col" class="history-num-col">
                          Duration
                        </th>
                        <th scope="col">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={spans()}>
                        {(row) => (
                          <tr class="history-detail-row">
                            <td class="history-cell-id" title={row.spanId}>
                              {row.spanIdLabel}
                            </td>
                            <td class="history-cell-id">
                              {row.parentSpanIdLabel}
                            </td>
                            <td>{row.spanName}</td>
                            <td>{row.kind}</td>
                            <td>{row.model}</td>
                            <td class="history-cell-num">{row.inTok}</td>
                            <td class="history-cell-num">{row.outTok}</td>
                            <td class="history-cell-num">{row.durationMs}</td>
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
                <h2 class="history-detail-section-title">Turn events</h2>
                <Show
                  when={turnEvents().length > 0}
                  fallback={<p class="history-detail-empty">No turn events.</p>}
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Invocation</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Payload</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={turnEvents()}>
                        {(row) => (
                          <tr class="history-detail-row">
                            <td title={row.tsAbsolute}>{row.ts}</td>
                            <td class="history-cell-id">
                              <a class="history-row-link" href={row.linkHref}>
                                {row.linkIdLabel}
                              </a>
                            </td>
                            <td>{row.kind}</td>
                            <td class="history-cell-payload">
                              {row.payloadPreview}
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
