/**
 * Conversation detail page for the history shell.
 *
 * Mirror of `HistoryListPage`: thin presentation layer over the
 * SSE-delivered `ConversationDetail` payload owned by `HistoryShell`.
 * Per-row formatting (id shortening, relative time, payload preview,
 * compact duration, span-kind classification) lives in
 * `conversationDetailView.ts` so it can be exercised without a Solid
 * runtime.
 *
 * Display states:
 *   - error: render the connection-error banner above the body so a
 *     transient socket drop does not blank the page.
 *   - not-found: backend said the row does not exist; render a stub
 *     and a back link to the list.
 *   - loading: no payload yet → render a single placeholder.
 *   - populated: header + turns / spans + invocations.
 *
 * A `createSignal`-driven 1-minute tick refreshes relative timestamps
 * without a fresh snapshot.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import type { ConversationDetail } from "../../../../../history/types";
import type { PricingSnapshot } from "../../api/client";
import { ConversationCostBand } from "./ConversationCostBand";
import {
  buildConversationHeader,
  buildInvocationLinks,
  buildSpanTreeByTurn,
} from "./conversationDetailView";
import { computeTurnCost, formatUsd } from "./costPanelView";
import { formatCompactNumber } from "./historyListView";

export interface ConversationDetailPageProps {
  detail: () => ConversationDetail | null;
  notFound: () => boolean;
  loading: () => boolean;
  error: () => string | null;
  /** Pricing snapshot accessor owned by `HistoryShell`. */
  pricingSnapshot: () => PricingSnapshot | undefined;
  /** Hash href to the list page; defaults to `#/history`. */
  backHref?: string;
}

const RELATIVE_TICK_MS = 60_000;

/** Total number of columns in the Spans table; used as the colspan for
 * the click-to-expand attrs drawer row so it always spans the full width. */
const SPANS_TABLE_COLSPAN = 10;

export function ConversationDetailPage(props: ConversationDetailPageProps) {
  const [now, setNow] = createSignal(Date.now());
  const interval = setInterval(() => setNow(Date.now()), RELATIVE_TICK_MS);
  onCleanup(() => clearInterval(interval));

  // Single-open accordion state for the Spans table: clicking a row
  // toggles its attrs drawer; clicking another row closes the previous
  // one and opens the new one. Null = no row expanded. Shared across
  // all turn accordions so only one attrs drawer is ever open.
  const [expandedSpanId, setExpandedSpanId] = createSignal<string | null>(null);
  const toggleSpan = (id: string) => {
    setExpandedSpanId((prev) => (prev === id ? null : id));
  };

  // Per-turn accordion open-state: a Set of trace ids whose body is
  // currently rendered. Empty by default — every turn collapses on
  // first render so a long conversation does not flood the page.
  const [openTurns, setOpenTurns] = createSignal<Set<string>>(new Set());
  const toggleTurn = (traceId: string) => {
    setOpenTurns((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  };

  const backHref = () => props.backHref ?? "#/history";

  const header = () => {
    const d = props.detail();
    return d === null ? null : buildConversationHeader(d, now());
  };
  const invocations = () => {
    const d = props.detail();
    return d === null ? [] : buildInvocationLinks(d, now());
  };
  const spanGroups = () => {
    const d = props.detail();
    return d === null ? [] : buildSpanTreeByTurn(d, now());
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
        <div class="history-detail-not-found">Conversation not found</div>
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
                  <Show when={h.summary}>
                    {(summary) => (
                      <div class="history-detail-summary">{summary()}</div>
                    )}
                  </Show>
                  <div class="history-detail-meta">
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
                    <div class="history-detail-meta-item">
                      <span class="history-detail-meta-label">First seen</span>
                      <span
                        class="history-detail-meta-value"
                        title={h.firstSeenAbsolute}
                      >
                        {h.firstSeen}
                      </span>
                    </div>
                    <div class="history-detail-meta-item">
                      <span class="history-detail-meta-label">Last seen</span>
                      <span
                        class="history-detail-meta-value"
                        title={h.lastSeenAbsolute}
                      >
                        {h.lastSeen}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="history-detail-stats">
                  <div class="stats-group">
                    <div class="stats-group-label">Activity</div>
                    <div class="stats-group-row">
                      <div class="history-detail-stat-label">Turns</div>
                      <div class="history-detail-stat-value">
                        {formatCompactNumber(h.turnCount)}
                      </div>
                      <div class="history-detail-stat-label">Spans</div>
                      <div class="history-detail-stat-value">
                        {formatCompactNumber(h.spanCount)}
                      </div>
                      <div class="history-detail-stat-label">Invoc.</div>
                      <div class="history-detail-stat-value">
                        {formatCompactNumber(h.invocationCount)}
                      </div>
                    </div>
                  </div>
                </div>
              </header>

              <ConversationCostBand
                perModel={props.detail()?.modelTokenTotals ?? []}
                pricingSnapshot={props.pricingSnapshot}
              />

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">
                  Turns
                  <span class="history-detail-section-count">
                    {spanGroups().length} turns
                  </span>
                </h2>
                <Show
                  when={spanGroups().length > 0}
                  fallback={
                    <div class="history-detail-section-empty">No turns</div>
                  }
                >
                  {/* Decorative column-header row above the accordions; uses
                   * the same grid template as the buttons below so each
                   * label sits exactly above its column. role="row" carries
                   * tabular semantics without claiming the cells are
                   * interactive. A real <table> would fight the accordion
                   * layout below; biome-ignore exempts the visual-only row
                   * from the semantic-element and focusable-interactive
                   * lints — the focusable elements are the accordion
                   * buttons in the data rows that follow. */}
                  {/* biome-ignore lint/a11y/useSemanticElements: see comment above */}
                  {/* biome-ignore lint/a11y/useFocusableInteractive: see comment above */}
                  <div class="history-detail-turn-acc-headerrow" role="row">
                    <span class="history-detail-turn-acc-cell-caret" />
                    <span class="history-detail-turn-acc-cell-label">Turn</span>
                    <span class="history-detail-turn-acc-cell-duration">
                      Duration
                    </span>
                    <span class="history-detail-turn-acc-cell-llm">LLM</span>
                    <span class="history-detail-turn-acc-cell-tools">
                      Tools
                    </span>
                    <span class="history-detail-turn-acc-cell-spans">
                      Spans
                    </span>
                    <span class="history-detail-turn-acc-cell-token">In</span>
                    <span class="history-detail-turn-acc-cell-token">Out</span>
                    <span class="history-detail-turn-acc-cell-token">
                      Cache R
                    </span>
                    <span class="history-detail-turn-acc-cell-token">
                      Cache W
                    </span>
                    <span class="history-detail-turn-acc-cell-cost">Cost</span>
                  </div>
                  <For each={spanGroups()}>
                    {(group) => {
                      const isOpen = () => openTurns().has(group.traceId);
                      const headerId = `turn-acc-header-${group.traceId}`;
                      const bodyId = `turn-acc-body-${group.traceId}`;
                      // Compute the Cost cell label reactively so a fresh
                      // snapshot poll re-prices without a span-tree rebuild.
                      // Pending snapshot, the unavailable sentinel, and a
                      // turn whose models all resolved to unknown collapse
                      // to the same em-dash placeholder — see
                      // `computeTurnCost.isUnknownOnly` for the rule.
                      const costLabel = () => {
                        const snap = props.pricingSnapshot();
                        if (snap === undefined) return "—";
                        const cost = computeTurnCost(
                          group.perModelTotals,
                          snap,
                        );
                        if (cost.isUnknownOnly) return "—";
                        return formatUsd(cost.totalUsd);
                      };
                      const costCellClass = () =>
                        costLabel() === "—"
                          ? "history-detail-turn-acc-cell-cost history-detail-turn-acc-cell-cost--missing"
                          : "history-detail-turn-acc-cell-cost";
                      return (
                        <div class="history-detail-turn-acc">
                          <button
                            id={headerId}
                            type="button"
                            class="history-detail-turn-acc-header"
                            aria-expanded={isOpen() ? "true" : "false"}
                            aria-controls={bodyId}
                            onClick={() => toggleTurn(group.traceId)}
                          >
                            <span
                              class="history-detail-turn-acc-caret history-detail-turn-acc-cell-caret"
                              aria-hidden="true"
                            >
                              {isOpen() ? "▼" : "▶"}
                            </span>
                            <span class="history-detail-turn-acc-cell-label">
                              Turn {group.turnIndex}
                            </span>
                            <span class="history-detail-turn-acc-cell-duration">
                              {group.durationLabel}
                            </span>
                            <span class="history-detail-turn-acc-cell-llm">
                              {group.llmCount}
                            </span>
                            <span class="history-detail-turn-acc-cell-tools">
                              {group.toolCount}
                            </span>
                            <span class="history-detail-turn-acc-cell-spans">
                              {group.spanCount}
                            </span>
                            <span class="history-detail-turn-acc-cell-token">
                              {group.inputTokensCell}
                            </span>
                            <span class="history-detail-turn-acc-cell-token">
                              {group.outputTokensCell}
                            </span>
                            <span class="history-detail-turn-acc-cell-token">
                              {group.cacheReadTokensCell}
                            </span>
                            <span class="history-detail-turn-acc-cell-token">
                              {group.cacheWriteTokensCell}
                            </span>
                            <span class={costCellClass()}>{costLabel()}</span>
                          </button>
                          <Show when={isOpen()}>
                            <section
                              id={bodyId}
                              aria-labelledby={headerId}
                              class="history-detail-turn-acc-body"
                            >
                              <table class="history-detail-table">
                                <thead>
                                  <tr>
                                    <th scope="col">Span</th>
                                    <th scope="col">Parent</th>
                                    <th scope="col">Name</th>
                                    <th scope="col">Tool</th>
                                    <th scope="col">Kind</th>
                                    <th scope="col">Model</th>
                                    <th
                                      scope="col"
                                      class="is-numeric is-stacked"
                                    >
                                      I/O
                                      <span class="th-sub">in · out</span>
                                    </th>
                                    <th
                                      scope="col"
                                      class="is-numeric is-stacked"
                                    >
                                      Cache
                                      <span class="th-sub">read · write</span>
                                    </th>
                                    <th scope="col" class="is-numeric">
                                      Duration
                                    </th>
                                    <th scope="col">Started</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <For each={group.rows}>
                                    {(row) => {
                                      const isExpanded = () =>
                                        expandedSpanId() === row.spanId;
                                      const attrsRowId = `attrs-${row.spanId}`;
                                      const namePadding = `${(row.depth ?? 0) * 16 + 12}px`;
                                      // Anchor clicks (e.g. nested links inside the row)
                                      // should not double as a row-toggle gesture.
                                      const handleClick = (
                                        e: MouseEvent & {
                                          currentTarget: HTMLTableRowElement;
                                        },
                                      ) => {
                                        const target =
                                          e.target as HTMLElement | null;
                                        if (target?.closest("a") !== null)
                                          return;
                                        toggleSpan(row.spanId);
                                      };
                                      const handleKeyDown = (
                                        e: KeyboardEvent & {
                                          currentTarget: HTMLTableRowElement;
                                        },
                                      ) => {
                                        if (
                                          e.key === "Enter" ||
                                          e.key === " "
                                        ) {
                                          e.preventDefault();
                                          toggleSpan(row.spanId);
                                        }
                                      };
                                      return (
                                        <>
                                          {/* biome-ignore lint/a11y/useSemanticElements: a real <button> cannot wrap a row of <td> cells without breaking the <table> layout; role="button" + tabindex + key handlers expose the same activation intent. */}
                                          <tr
                                            role="button"
                                            tabIndex={0}
                                            aria-expanded={
                                              isExpanded() ? "true" : "false"
                                            }
                                            aria-controls={attrsRowId}
                                            onClick={handleClick}
                                            onKeyDown={handleKeyDown}
                                          >
                                            <td
                                              class="is-id"
                                              title={row.spanId}
                                            >
                                              {row.spanIdLabel}
                                            </td>
                                            <td class="is-id">
                                              {row.parentSpanIdLabel ?? ""}
                                            </td>
                                            <td
                                              style={{
                                                "padding-left": namePadding,
                                              }}
                                            >
                                              {row.spanName}
                                            </td>
                                            <td>{row.toolName ?? ""}</td>
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
                                            <td class="is-numeric">
                                              {row.ioCell}
                                            </td>
                                            <td class="is-numeric">
                                              {row.cacheCell}
                                            </td>
                                            <td class="is-numeric">
                                              {row.durationLabel ?? ""}
                                            </td>
                                            <td title={row.startedAtAbsolute}>
                                              {row.startedAt}
                                            </td>
                                          </tr>
                                          <Show when={isExpanded()}>
                                            {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: this drawer row is structurally a <tr> so the table layout stays intact; role="region" labels it as the expanded panel referenced by aria-controls. */}
                                            {/* biome-ignore lint/a11y/useSemanticElements: a <section> cannot be a child of <tbody>; the row needs to remain a <tr> so the colspan drawer renders inside the same table. */}
                                            <tr
                                              id={attrsRowId}
                                              role="region"
                                              class="history-detail-attrs-row"
                                            >
                                              <td colspan={SPANS_TABLE_COLSPAN}>
                                                <pre class="history-detail-attrs-pre">
                                                  {row.attrsPretty}
                                                </pre>
                                              </td>
                                            </tr>
                                          </Show>
                                        </>
                                      );
                                    }}
                                  </For>
                                </tbody>
                              </table>
                            </section>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </section>

              <section class="history-detail-section">
                <h2 class="history-detail-section-title">
                  Invocations
                  <span class="history-detail-section-count">
                    {invocations().length} rows
                  </span>
                </h2>
                <Show
                  when={invocations().length > 0}
                  fallback={
                    <div class="history-detail-section-empty">
                      No invocations
                    </div>
                  }
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
                          <tr>
                            <td class="is-id">
                              <a class="history-row-link" href={row.href}>
                                {row.idLabel}
                              </a>
                            </td>
                            <td>{row.profile ?? ""}</td>
                            <td class="is-muted">{row.worktreePath ?? ""}</td>
                            <td title={row.startedAtAbsolute}>
                              {row.startedAt}
                            </td>
                            <td title={row.endedAtAbsolute ?? undefined}>
                              {row.endedAt ?? ""}
                            </td>
                            <td>{row.exitReason ?? ""}</td>
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
