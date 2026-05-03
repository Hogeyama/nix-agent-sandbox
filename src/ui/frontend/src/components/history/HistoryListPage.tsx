/**
 * Conversation list page for the history shell.
 *
 * Thin presentation layer over the SSE-delivered list. Per-row
 * formatting (short id, relative time, summary fallback, compact token
 * total, agent variant) lives in `historyListView.ts` so it can be
 * unit-tested without a Solid runtime. The page renders one anchor per
 * row — clicking the anchor navigates via `#/history/conversation/:id`,
 * which the router resolves on the next `hashchange`.
 *
 * Three display states:
 *   - loading: no payload has arrived yet → render a single placeholder
 *     so the layout does not pop in.
 *   - empty: payload arrived but contained zero rows → render a stub
 *     message rather than an empty table.
 *   - populated: render one anchor row per conversation.
 *
 * A `createSignal`-driven 1-minute tick refreshes the relative-time
 * column without a fresh snapshot from the daemon.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import type {
  ConversationListRow,
  ModelTokenTotalsRow,
} from "../../../../../history/types";
import type { PricingSnapshot } from "../../api/client";
import { CostPanel } from "./CostPanel";
import { toConversationListRowView } from "./historyListView";

export interface HistoryListPageProps {
  /** Reactive accessor for the SSE-delivered list. */
  conversations: () => ConversationListRow[];
  /** True until the first event has arrived (drives the placeholder). */
  loading: () => boolean;
  /** Connection error message, or null while the stream looks healthy. */
  error: () => string | null;
  /** Pricing snapshot accessor; `undefined` while the resource is pending. */
  pricingSnapshot: () => PricingSnapshot | undefined;
  /** Per-model token totals accessor from the SSE list payload. */
  modelTokenTotals: () => ModelTokenTotalsRow[];
  /** ISO-8601 boundary the daemon used when computing `modelTokenTotals`. */
  since: () => string;
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
    props.conversations().map((row) => toConversationListRowView(row, now()));

  return (
    <div class="history-shell-content">
      <h1 class="history-shell-title">History</h1>

      <CostPanel
        snapshot={props.pricingSnapshot()}
        totals={props.modelTokenTotals()}
        since={props.since()}
      />

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
          <div class="history-empty" aria-busy="true">
            Loading…
          </div>
        }
      >
        <Show
          when={rows().length > 0}
          fallback={<div class="history-empty">No conversations yet</div>}
        >
          <div class="history-list">
            <For each={rows()}>
              {(row) => (
                <a class="history-list-row" href={row.href}>
                  <div class="history-list-primary">
                    <div
                      class={
                        row.summaryIsEmpty
                          ? "history-list-summary is-empty"
                          : "history-list-summary"
                      }
                      title={row.summary}
                    >
                      {row.summary}
                    </div>
                    <Show when={row.directory !== ""}>
                      <div class="history-list-directory" title={row.directory}>
                        <span
                          class="history-list-directory-glyph"
                          aria-hidden="true"
                        >
                          ↳
                        </span>
                        <Show when={row.directoryParent !== ""}>
                          <span class="history-list-directory-parent">
                            {row.directoryParent}
                          </span>
                        </Show>
                        <span class="history-list-directory-base">
                          {row.directoryBase}
                        </span>
                      </div>
                    </Show>
                    <Show when={row.metaLine !== ""}>
                      <div class="history-list-meta">{row.metaLine}</div>
                    </Show>
                  </div>
                  <div
                    class={
                      row.agentClass === ""
                        ? "history-list-agent"
                        : `history-list-agent ${row.agentClass}`
                    }
                  >
                    {row.agentLabel === "" ? "—" : row.agentLabel}
                  </div>
                  <div class="history-list-time" title={row.fullTimestamp}>
                    {row.lastSeen}
                  </div>
                  <div
                    class="history-list-stats"
                    title={
                      row.tokenBreakdownTitle === ""
                        ? undefined
                        : row.tokenBreakdownTitle
                    }
                  >
                    {row.tokenTotal}
                  </div>
                </a>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
