/**
 * Full-width COST band for the conversation detail page.
 *
 * Sits between the page header and the Turns section. Thin presentation
 * layer over `computeConversationCost`: the projection picks the display
 * mode (`empty` / `single` / `multi`), whether the snapshot is stale,
 * and how to label the source — the component renders no business
 * decisions of its own.
 *
 * Display states:
 *   - pending: snapshot accessor returns `undefined`. A fixed-height
 *     skeleton placeholder reserves vertical space so the Turns section
 *     does not jump up and back down once the resource resolves.
 *   - empty: no per-model rows after token=0 drop. The band renders
 *     nothing, leaving the header and Turns table flush against each
 *     other.
 *   - single: one stat strip with the model label, hero USD, and four
 *     token cells (in / out / cache r / cache w).
 *   - multi: per-model table with a TOTAL row that sums the known rows.
 *
 * Unavailable / stale chips lean on the same accent tokens the
 * list-page panel uses so the two surfaces read as one family.
 */

import { For, Show } from "solid-js";
import type { ModelTokenTotalsRow } from "../../../../../history/types";
import type { PricingSnapshot } from "../../api/client";
import {
  type CostRow,
  computeConversationCost,
  formatTokenCount,
  formatUsd,
} from "./costPanelView";

export interface ConversationCostBandProps {
  perModel: ReadonlyArray<ModelTokenTotalsRow>;
  /** Resource accessor; `undefined` while the pricing fetch is pending. */
  pricingSnapshot: () => PricingSnapshot | undefined;
}

export function ConversationCostBand(props: ConversationCostBandProps) {
  return (
    <Show
      when={props.pricingSnapshot()}
      fallback={
        <div class="history-detail-cost-band-loading" aria-busy="true" />
      }
    >
      {(snap) => {
        const view = () =>
          computeConversationCost(props.perModel, snap(), Date.now());
        return (
          <Show when={view().mode !== "empty"}>
            <section
              class={
                view().source === "unavailable"
                  ? "history-detail-cost-band history-detail-cost-band--unavailable"
                  : "history-detail-cost-band"
              }
              aria-label="Conversation cost"
            >
              <div class="history-detail-cost-band-header">
                <span class="history-detail-cost-band-title">Cost</span>
                <span class="history-detail-cost-band-chips">
                  <Show when={view().source === "unavailable"}>
                    <span class="history-detail-cost-band-chip history-detail-cost-band-chip--unavailable">
                      Pricing unavailable
                    </span>
                  </Show>
                  <Show when={view().source === "litellm"}>
                    <span class="history-detail-cost-band-chip">
                      {view().fetchedAtRelative}
                    </span>
                  </Show>
                  <Show when={view().stale && view().source !== "unavailable"}>
                    <span class="history-detail-cost-band-chip history-detail-cost-band-chip--stale">
                      · stale
                    </span>
                  </Show>
                </span>
              </div>

              <Show when={view().mode === "single" && view().single}>
                {(singleAccessor) => {
                  const single = singleAccessor();
                  return (
                    <div class="history-detail-cost-band-strip">
                      <div class="history-detail-cost-band-strip-model">
                        <span
                          class={
                            single.isUnknown
                              ? "history-detail-cost-band-cell--missing"
                              : ""
                          }
                          title={single.rawModel}
                        >
                          {single.isUnknown
                            ? `(unknown: ${
                                single.rawModel === "" ? "—" : single.rawModel
                              })`
                            : single.model}
                        </span>
                      </div>
                      <div
                        class={
                          view().source === "unavailable"
                            ? "history-detail-cost-band-hero history-detail-cost-band-hero--unavailable"
                            : "history-detail-cost-band-hero"
                        }
                      >
                        {view().source === "unavailable"
                          ? "—"
                          : formatUsd(single.row.totalUsd)}
                      </div>
                      <div class="history-detail-cost-band-strip-cells">
                        <TokenUsdCell
                          label="In"
                          tokens={single.row.inputTokens}
                          usd={single.row.inputUsd}
                          isUnknown={single.isUnknown}
                          unavailable={view().source === "unavailable"}
                        />
                        <TokenUsdCell
                          label="Out"
                          tokens={single.row.outputTokens}
                          usd={single.row.outputUsd}
                          isUnknown={single.isUnknown}
                          unavailable={view().source === "unavailable"}
                        />
                        <TokenUsdCell
                          label="Cache R"
                          tokens={single.row.cacheRead}
                          usd={single.row.cacheReadUsd}
                          isUnknown={single.isUnknown}
                          unavailable={view().source === "unavailable"}
                        />
                        <TokenUsdCell
                          label="Cache W"
                          tokens={single.row.cacheWrite}
                          usd={single.row.cacheWriteUsd}
                          isUnknown={single.isUnknown}
                          unavailable={view().source === "unavailable"}
                        />
                      </div>
                    </div>
                  );
                }}
              </Show>

              <Show when={view().mode === "multi"}>
                <div
                  class={
                    view().source === "unavailable"
                      ? "history-detail-cost-band-hero history-detail-cost-band-hero--unavailable"
                      : "history-detail-cost-band-hero"
                  }
                >
                  {view().source === "unavailable"
                    ? "—"
                    : formatUsd(view().totalUsd)}
                </div>
                <table class="history-detail-cost-band-table">
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th
                        scope="col"
                        class="history-detail-cost-band-cell-token"
                      >
                        In
                      </th>
                      <th
                        scope="col"
                        class="history-detail-cost-band-cell-token"
                      >
                        Out
                      </th>
                      <th
                        scope="col"
                        class="history-detail-cost-band-cell-token"
                      >
                        Cache R
                      </th>
                      <th
                        scope="col"
                        class="history-detail-cost-band-cell-token"
                      >
                        Cache W
                      </th>
                      <th scope="col" class="history-detail-cost-band-cell-usd">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={view().rows}>
                      {(row) => (
                        <tr
                          class={
                            row.isUnknown
                              ? "history-detail-cost-band-row-unknown"
                              : "history-detail-cost-band-row-known"
                          }
                        >
                          <td title={row.rawModel}>
                            {row.isUnknown
                              ? `(unknown: ${
                                  row.rawModel === "" ? "—" : row.rawModel
                                })`
                              : row.model}
                          </td>
                          <td class="history-detail-cost-band-cell-token">
                            {formatRowCell(row.inputTokens, row.inputUsd, row)}
                          </td>
                          <td class="history-detail-cost-band-cell-token">
                            {formatRowCell(
                              row.outputTokens,
                              row.outputUsd,
                              row,
                            )}
                          </td>
                          <td class="history-detail-cost-band-cell-token">
                            {formatRowCell(
                              row.cacheRead,
                              row.cacheReadUsd,
                              row,
                            )}
                          </td>
                          <td class="history-detail-cost-band-cell-token">
                            {formatRowCell(
                              row.cacheWrite,
                              row.cacheWriteUsd,
                              row,
                            )}
                          </td>
                          <td class="history-detail-cost-band-cell-usd">
                            {row.isUnknown
                              ? "token only"
                              : formatUsd(row.totalUsd)}
                          </td>
                        </tr>
                      )}
                    </For>
                    <tr class="history-detail-cost-band-row-total">
                      <td>Total</td>
                      <td class="history-detail-cost-band-cell-token" />
                      <td class="history-detail-cost-band-cell-token" />
                      <td class="history-detail-cost-band-cell-token" />
                      <td class="history-detail-cost-band-cell-token" />
                      <td class="history-detail-cost-band-cell-usd">
                        {view().source === "unavailable"
                          ? "—"
                          : formatUsd(view().totalUsd)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </Show>
            </section>
          </Show>
        );
      }}
    </Show>
  );
}

interface TokenUsdCellProps {
  label: string;
  tokens: number;
  usd: number | undefined;
  isUnknown: boolean;
  unavailable: boolean;
}

/**
 * Single-mode strip cell. Shows a `LABEL` head, a token count, and a
 * USD figure. When the row is unknown or the snapshot is unavailable
 * the USD slot collapses to "—" and the cell carries the
 * `--missing` modifier so it renders dim.
 */
function TokenUsdCell(props: TokenUsdCellProps) {
  const usdText = () => {
    if (props.unavailable) return "—";
    if (props.isUnknown) return "—";
    return formatUsd(props.usd);
  };
  const cellClass = () => {
    if (props.unavailable || props.isUnknown) {
      return "history-detail-cost-band-cell history-detail-cost-band-cell--missing";
    }
    return "history-detail-cost-band-cell";
  };
  return (
    <div class={cellClass()}>
      <div class="history-detail-cost-band-cell-label">{props.label}</div>
      <div class="history-detail-cost-band-cell-value">
        <span class="history-detail-cost-band-cell-token">
          {formatTokenCount(props.tokens)} tok
        </span>
        <span class="history-detail-cost-band-cell-usd">{usdText()}</span>
      </div>
    </div>
  );
}

/**
 * Multi-mode token cell renderer. Shows `<count> tok` always and the
 * USD figure when the unit price resolved; missing-rate fields collapse
 * to "—" so a known model with a partial price catalogue keeps its
 * token counts but does not invent a USD figure.
 */
function formatRowCell(
  tokens: number,
  usd: number | undefined,
  row: CostRow,
): string {
  if (row.isUnknown) return `${formatTokenCount(tokens)} tok`;
  return `${formatTokenCount(tokens)} tok · ${formatUsd(usd)}`;
}
