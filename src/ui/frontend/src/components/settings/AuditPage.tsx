/**
 * Audit settings page.
 *
 * Renders the merged view of the live audit window (delivered over
 * SSE through `auditStore.entries()`) and the older-history pool
 * managed by `auditPageStore`. The page itself is a thin presentation
 * layer:
 *
 *   - The display filter lives in three local signals so the
 *     controls stay reactive without round-tripping through the
 *     store on every keystroke. The signals are seeded from
 *     `props.store.state().displayFilter` on mount so a route change
 *     that re-mounts the page rehydrates the controls from the
 *     long-lived store rather than snapping back to defaults.
 *   - A `createEffect` translates filter changes into
 *     `store.setFilter`, which clears the older-history pool and
 *     invalidates any in-flight loader. The effect uses `defer: true`
 *     so the initial run on mount does not fire a `reset` that would
 *     wipe the older pool the user already loaded; subsequent runs
 *     also pass through `shouldResetFilter` so SSE-driven `activeIds`
 *     changes that do not alter the wire-format server filter leave
 *     the older pool intact.
 *   - An `IntersectionObserver` watches the bottom sentinel and
 *     calls `store.loadOlder` when the sentinel scrolls into view;
 *     the observer is torn down on cleanup so it cannot outlive the
 *     page.
 *
 * The page intentionally does not touch `auditStore`. The pending
 * pane's recent-50 accordion and the settings page consume disjoint
 * data paths: they share only the wire shape, never the state
 * machine or the SSE subscription.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import type { getAuditLogs } from "../../api/client";
import type { AuditPageStore } from "../../stores/auditPageStore";
import type { AuditLogEntryLike } from "../../stores/types";
import { formatAuditEntry } from "../auditEntryView";
import {
  type AuditDisplayFilter,
  applyDisplayFilter,
  mergeAuditEntries,
  shouldResetFilter,
} from "./auditPaginationLogic";

export interface AuditPageProps {
  /** Reactive accessor for the live SSE-driven audit window. */
  liveRows: () => AuditLogEntryLike[];
  /**
   * Reactive accessor for the set of session ids considered "active"
   * (running container + pending approvals). The page subscribes to
   * the accessor so toggling `activeOnly` filters against the latest
   * snapshot.
   */
  activeIds: () => ReadonlySet<string>;
  store: AuditPageStore;
  /** Injected for testability; defaults to the real client. */
  fetchAuditLogs: typeof getAuditLogs;
}

/**
 * Render the summary cell for a row. Network entries carry `target`,
 * host-exec entries carry `command`; the empty string is a safe
 * fallback when both are absent (the daemon is supposed to populate
 * one or the other).
 */
function summaryFor(row: AuditLogEntryLike): string {
  return row.target ?? row.command ?? "";
}

export function AuditPage(props: AuditPageProps) {
  // Seed the controls from the long-lived store so a remount (e.g.
  // route change Settings → Workspace → Settings) restores the user's
  // last selection rather than snapping back to defaults. The page
  // store's lifetime is tied to `App`, not to this component, so its
  // `displayFilter` is the durable source of truth.
  const initialDisplayFilter = props.store.state().displayFilter;
  const [domain, setDomain] = createSignal<AuditDisplayFilter["domain"]>(
    initialDisplayFilter.domain,
  );
  const [sessionContains, setSessionContains] = createSignal(
    initialDisplayFilter.sessionContains,
  );
  const [activeOnly, setActiveOnly] = createSignal(
    initialDisplayFilter.activeOnly,
  );

  const displayFilter = createMemo<AuditDisplayFilter>(() => ({
    domain: domain(),
    sessionContains: sessionContains(),
    activeOnly: activeOnly(),
  }));

  // Push the filter into the store when it actually changes. Two
  // important properties:
  //
  //   - `defer: true` skips the initial run on mount. The signals are
  //     already hydrated from `store.state().displayFilter` above, so
  //     firing `setFilter` once on mount would dispatch a `reset`
  //     that wipes the older pool the user just loaded — exactly the
  //     state we want survive across remounts.
  //   - The `shouldResetFilter` guard suppresses runs that arrive from
  //     `props.activeIds` mutating without changing the wire-format
  //     server filter (e.g. an SSE update toggling a session in /
  //     out of `activeIds` while `activeOnly` is off). Without this
  //     guard, every SSE event would clear the older pool.
  createEffect(
    on(
      [displayFilter, props.activeIds],
      ([filter, activeIds]) => {
        if (
          !shouldResetFilter(
            filter,
            activeIds,
            props.store.state().serverFilter,
          )
        ) {
          return;
        }
        props.store.setFilter(filter, activeIds);
      },
      { defer: true },
    ),
  );

  const merged = createMemo(() =>
    mergeAuditEntries(props.liveRows(), props.store.state().olderItems),
  );
  const visible = createMemo(() =>
    applyDisplayFilter(merged(), displayFilter(), props.activeIds()),
  );

  const triggerLoadOlder = () => {
    void props.store.loadOlder({
      fetchAuditLogs: props.fetchAuditLogs,
      live: props.liveRows,
    });
  };

  // Sentinel + IntersectionObserver. The observer is created lazily
  // when the sentinel mounts and is torn down on cleanup; the
  // `onCleanup` runs both on component unmount and when Solid tears
  // down the surrounding `Show` block, so the lifecycle is bounded
  // strictly to the sentinel's DOM presence.
  let observer: IntersectionObserver | null = null;
  const attachSentinel = (el: HTMLDivElement) => {
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          triggerLoadOlder();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
  };
  onCleanup(() => {
    observer?.disconnect();
    observer = null;
  });

  const showSentinel = () => {
    const s = props.store.state();
    return merged().length > 0 && (s.hasMore || s.loadError !== null);
  };

  return (
    <div class="audit-page">
      <h1 class="settings-page-heading">Audit</h1>
      <p class="settings-page-note">
        Browse the durable audit log of approvals and denials.
      </p>
      <fieldset class="audit-filter-bar">
        <legend class="audit-filter-legend">Audit filters</legend>
        <label class="audit-filter-field">
          <span class="audit-filter-label">Domain</span>
          <select
            class="audit-filter-select"
            value={domain()}
            onChange={(e) =>
              setDomain(
                (e.target as HTMLSelectElement)
                  .value as AuditDisplayFilter["domain"],
              )
            }
          >
            <option value="all">All</option>
            <option value="network">network</option>
            <option value="hostexec">hostexec</option>
          </select>
        </label>
        <label class="audit-filter-field">
          <span class="audit-filter-label">Session contains</span>
          <input
            type="text"
            class="audit-filter-input"
            placeholder="filter by id…"
            value={sessionContains()}
            onInput={(e) =>
              setSessionContains((e.target as HTMLInputElement).value)
            }
          />
        </label>
        <label class="audit-filter-checkbox">
          <input
            type="checkbox"
            checked={activeOnly()}
            onChange={(e) =>
              setActiveOnly((e.target as HTMLInputElement).checked)
            }
          />
          <span>Active only</span>
        </label>
        <span
          class="audit-filter-counter"
          title={`${visible().length} entries shown\n${merged().length} entries in memory`}
        >
          showing {visible().length}{" "}
          {visible().length === 1 ? "entry" : "entries"}
        </span>
      </fieldset>

      <Show
        when={visible().length > 0}
        fallback={
          <p class="audit-empty-state">
            No audit entries match the current filter.
          </p>
        }
      >
        <table class="audit-table">
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Domain</th>
              <th scope="col">Decision</th>
              <th scope="col">Session</th>
              <th scope="col">Summary</th>
            </tr>
          </thead>
          <tbody>
            <For each={visible()}>
              {(row) => (
                <tr class="audit-row">
                  <td class="audit-cell-time">{formatAuditEntry(row)}</td>
                  <td class="audit-cell-domain">{row.domain}</td>
                  <td
                    class="audit-cell-decision"
                    classList={{
                      "decision-allow": row.decision === "allow",
                      "decision-deny": row.decision === "deny",
                    }}
                  >
                    {row.decision}
                  </td>
                  <td class="audit-cell-session" title={row.sessionId}>
                    {row.sessionId}
                  </td>
                  <td class="audit-cell-summary">{summaryFor(row)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <Show when={showSentinel()}>
        {/*
          The sentinel is mounted whenever there is more to load,
          independent of the visible row count. A narrow filter that
          hides every loaded row can still pull in matches from the
          next batch.
        */}
        <div ref={attachSentinel} class="scroll-sentinel">
          <Show
            when={props.store.state().loadError}
            fallback={
              <Show
                when={props.store.state().loadingMore}
                fallback={
                  <span class="scroll-sentinel-msg">Scroll for more</span>
                }
              >
                <span class="scroll-sentinel-msg">Loading older…</span>
              </Show>
            }
          >
            {(msg) => (
              <button
                type="button"
                class="audit-retry"
                onClick={triggerLoadOlder}
              >
                Retry — {msg()}
              </button>
            )}
          </Show>
        </div>
      </Show>
      <Show
        when={
          !props.store.state().hasMore &&
          props.store.state().loadError === null &&
          merged().length > 0
        }
      >
        <div class="scroll-sentinel">
          <span class="scroll-sentinel-msg muted">— end of history —</span>
        </div>
      </Show>
    </div>
  );
}
