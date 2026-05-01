/**
 * Conversation list page for the history shell.
 *
 * The page is a thin presentation layer over the SSE-delivered list:
 * data fetching is owned by the parent shell (which subscribes via
 * `useHistoryStream` and threads the accessor in). Per-row formatting
 * (short id, relative time, token total) lives in `historyListView.ts`
 * so it can be unit-tested without a Solid runtime.
 *
 * Three display states:
 *   - loading: no payload has arrived yet → render a single placeholder
 *     row so the layout does not pop in.
 *   - empty: payload arrived but contained zero rows → render a stub
 *     message rather than an empty table.
 *   - populated: render one anchor per conversation; clicking the
 *     anchor navigates via `#/history/conversation/:id` (the router
 *     resolves it on the next `hashchange`).
 *
 * A `createSignal`-driven 1-minute tick refreshes the relative-time
 * column without a snapshot from the daemon.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import type { ConversationListRow } from "../../../../../history/types";
import { toHistoryListRowDisplay } from "./historyListView";

export interface HistoryListPageProps {
  /** Reactive accessor for the SSE-delivered list. */
  conversations: () => ConversationListRow[];
  /** True until the first event has arrived (drives the placeholder). */
  loading: () => boolean;
  /** Connection error message, or null while the stream looks healthy. */
  error: () => string | null;
}

const RELATIVE_TICK_MS = 60_000;

export function HistoryListPage(props: HistoryListPageProps) {
  // Tick once a minute so "5m ago" advances on its own without waiting
  // for a fresh SSE snapshot. The interval is bounded by `onCleanup`,
  // so a route change away from the list page tears it down.
  const [now, setNow] = createSignal(Date.now());
  const interval = setInterval(() => setNow(Date.now()), RELATIVE_TICK_MS);
  onCleanup(() => clearInterval(interval));

  const rows = () =>
    props.conversations().map((row) => toHistoryListRowDisplay(row, now()));

  return (
    <div class="history-list-page">
      <h1 class="settings-page-heading">History</h1>
      <p class="settings-page-note">
        Browse recent conversations recorded by the OTLP receiver.
      </p>

      <Show when={props.error()}>
        {(msg) => (
          <div class="history-error" role="alert">
            {msg()}
          </div>
        )}
      </Show>

      <Show
        when={!props.loading()}
        fallback={
          <div class="history-placeholder" aria-busy="true">
            Loading…
          </div>
        }
      >
        <Show
          when={rows().length > 0}
          fallback={<p class="history-empty">No conversations yet.</p>}
        >
          <table class="history-list">
            <thead>
              <tr>
                <th scope="col">Id</th>
                <th scope="col">Agent</th>
                <th scope="col">Last seen</th>
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
              <For each={rows()}>
                {(row) => (
                  <tr class="history-list-row">
                    <td class="history-cell-id">
                      <a class="history-row-link" href={row.href}>
                        {row.shortId}
                      </a>
                    </td>
                    <td class="history-cell-agent">{row.agent}</td>
                    <td class="history-cell-time" title={row.fullTimestamp}>
                      {row.relativeTime}
                    </td>
                    <td class="history-cell-num">{row.turnCount}</td>
                    <td class="history-cell-num">{row.spanCount}</td>
                    <td class="history-cell-num">{row.tokenTotal}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>
    </div>
  );
}
