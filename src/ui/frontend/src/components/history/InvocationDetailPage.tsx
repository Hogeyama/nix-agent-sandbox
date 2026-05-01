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
        <div class="history-detail-not-found">Invocation not found.</div>
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
                  Invocation {h.idLabel}
                </h1>
                <dl class="history-detail-meta">
                  <dt>Profile</dt>
                  <dd>{h.profile}</dd>
                  <dt>Agent</dt>
                  <dd>{h.agent}</dd>
                  <dt>Worktree</dt>
                  <dd>{h.worktreePath}</dd>
                  <dt>Started</dt>
                  <dd title={h.startedAtAbsolute}>{h.startedAt}</dd>
                  <dt>Ended</dt>
                  <dd title={h.endedAtAbsolute}>{h.endedAt}</dd>
                  <dt>Exit</dt>
                  <dd>{h.exitReason}</dd>
                  <dt>Turns</dt>
                  <dd>{h.turnCount}</dd>
                  <dt>Traces</dt>
                  <dd>{h.traceCount}</dd>
                  <dt>Spans</dt>
                  <dd>{h.spanCount}</dd>
                  <dt>Conversations</dt>
                  <dd>{h.conversationCount}</dd>
                  <dt>Tokens</dt>
                  <dd>{h.tokenTotal}</dd>
                </dl>
              </header>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">Conversations</h2>
                <Show
                  when={conversations().length > 0}
                  fallback={
                    <p class="history-detail-empty">No conversations.</p>
                  }
                >
                  <table class="history-detail-table">
                    <thead>
                      <tr>
                        <th scope="col">Id</th>
                        <th scope="col">Agent</th>
                        <th scope="col" class="history-num-col">
                          Turns
                        </th>
                        <th scope="col" class="history-num-col">
                          Spans
                        </th>
                        <th scope="col" class="history-num-col">
                          Tokens
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={conversations()}>
                        {(row) => (
                          <tr class="history-detail-row">
                            <td class="history-cell-id">
                              <a class="history-row-link" href={row.href}>
                                {row.idLabel}
                              </a>
                            </td>
                            <td>{row.agent}</td>
                            <td class="history-cell-num">{row.turnCount}</td>
                            <td class="history-cell-num">{row.spanCount}</td>
                            <td class="history-cell-num">{row.tokenTotal}</td>
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
                        <th scope="col">Conversation</th>
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
