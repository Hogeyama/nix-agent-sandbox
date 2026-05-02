/**
 * Cost panel for the history list page.
 *
 * Thin presentation layer over `computeCostPanel` — the projection
 * logic, sort order, and formatting all live in `costPanelView.ts` so
 * the component renders no business decisions of its own. Rendered as
 * the first child below the page title; the conversation list sits
 * directly underneath.
 *
 * Three display states:
 *   - pending: `snapshot === undefined` (the resource is still loading).
 *     Renders a single placeholder so the list does not pop in below it.
 *   - unavailable: `source === "unavailable"`. Renders the unavailable
 *     header band with no table; row USD columns would all be "—" and
 *     would not add information.
 *   - populated: header + per-model table. Header surfaces source,
 *     fetched-at relative time, total USD, and the daemon's "since"
 *     boundary; the stale badge appears when the cached snapshot has
 *     passed its 24h freshness window.
 */

import { For, Show } from "solid-js";
import type { ModelTokenTotalsRow } from "../../../../../history/types";
import type { PricingSnapshot } from "../../api/client";
import { computeCostPanel, formatTokenCount, formatUsd } from "./costPanelView";

export interface CostPanelProps {
  /** Latest pricing snapshot, or `undefined` while the resource is pending. */
  snapshot: PricingSnapshot | undefined;
  /** Per-model token totals from the SSE list payload. */
  totals: ModelTokenTotalsRow[];
  /** ISO-8601 boundary used by the daemon when computing `totals`. */
  since: string;
}

export function CostPanel(props: CostPanelProps) {
  return (
    <Show
      when={props.snapshot}
      fallback={
        <div class="history-cost-panel-loading" aria-busy="true">
          Loading pricing…
        </div>
      }
    >
      {(snap) => {
        const view = () =>
          computeCostPanel(props.totals, snap(), props.since, Date.now());
        return (
          <div
            class={
              view().source === "unavailable"
                ? "history-cost-panel history-cost-panel-unavailable"
                : "history-cost-panel"
            }
          >
            <div class="history-cost-panel-header">
              <span class="history-cost-source-badge">
                Source: {view().source}
                {view().fetchedAtRelative === ""
                  ? ""
                  : ` (${view().fetchedAtRelative})`}
              </span>
              <Show when={view().source === "unavailable"}>
                <span class="history-cost-source-badge">
                  Pricing unavailable
                </span>
              </Show>
              <Show when={view().stale === true}>
                <span class="history-cost-stale-badge">stale</span>
              </Show>
              <span class="history-cost-total">
                Total: {formatUsd(view().totalUsd)}
              </span>
              <span class="history-cost-since">
                Last 30 days (since {props.since.slice(0, 10)})
              </span>
            </div>

            <Show
              when={view().source !== "unavailable" && view().rows.length > 0}
            >
              <table class="history-cost-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th class="history-cost-num">Input</th>
                    <th class="history-cost-num">Output</th>
                    <th class="history-cost-num">Cache W</th>
                    <th class="history-cost-num">Cache R</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={view().rows}>
                    {(row) => (
                      <tr
                        class={
                          row.isUnknown
                            ? "history-cost-row-unknown"
                            : "history-cost-row-known"
                        }
                      >
                        <td title={row.rawModel}>{row.model}</td>
                        <td class="history-cost-num">
                          {formatTokenCount(row.inputTokens)} tok ·{" "}
                          {formatUsd(row.inputUsd)}
                        </td>
                        <td class="history-cost-num">
                          {formatTokenCount(row.outputTokens)} tok ·{" "}
                          {formatUsd(row.outputUsd)}
                        </td>
                        <td class="history-cost-num">
                          {formatTokenCount(row.cacheWrite)} tok ·{" "}
                          {formatUsd(row.cacheWriteUsd)}
                        </td>
                        <td class="history-cost-num">
                          {formatTokenCount(row.cacheRead)} tok ·{" "}
                          {formatUsd(row.cacheReadUsd)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
