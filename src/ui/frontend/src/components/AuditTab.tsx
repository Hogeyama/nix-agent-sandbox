import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { api, type AuditLogEntry, type SessionsData } from "../api.ts";

export interface AuditTabProps {
  /** Latest entries pushed by the SSE stream (most-recent window). */
  liveItems: AuditLogEntry[];
  sessions: SessionsData;
}

/** How many older entries to fetch per infinite-scroll batch. */
const PAGE_SIZE = 200;

export function AuditTab({ liveItems, sessions }: AuditTabProps) {
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [sessionFilter, setSessionFilter] = useState<string>("");
  const [activeOnly, setActiveOnly] = useState<boolean>(true);

  // Older history fetched on demand via GET /api/audit. These entries are
  // already filter-matched server-side, so they never need to be trimmed
  // client-side (but passing them through the display filter is harmless).
  const [olderItems, setOlderItems] = useState<AuditLogEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sessions.network) ids.add(s.sessionId);
    for (const s of sessions.hostexec) ids.add(s.sessionId);
    return ids;
  }, [sessions]);

  // Merge live + older, dedupe by id, newest first.
  const allItems = useMemo(() => {
    const byId = new Map<string, AuditLogEntry>();
    for (const e of olderItems) byId.set(e.id, e);
    for (const e of liveItems) byId.set(e.id, e);
    const merged = Array.from(byId.values());
    merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return merged;
  }, [liveItems, olderItems]);

  // Display filter. Live entries arrive unfiltered from SSE so we apply the
  // same criteria client-side here. Older entries come in already matching
  // and pass through unchanged.
  const filtered = useMemo(() => {
    let result = allItems;
    if (activeOnly) {
      result = result.filter((e) => activeSessionIds.has(e.sessionId));
    }
    if (domainFilter !== "all") {
      result = result.filter((e) => e.domain === domainFilter);
    }
    if (sessionFilter.trim()) {
      const q = sessionFilter.trim().toLowerCase();
      result = result.filter((e) => e.sessionId.toLowerCase().includes(q));
    }
    return result;
  }, [allItems, domainFilter, sessionFilter, activeOnly, activeSessionIds]);

  // ─────────────────────────────────────────────────────────────
  // Infinite scroll
  // ─────────────────────────────────────────────────────────────

  // Cursor for the next batch: oldest matching entry currently in view.
  // Using `filtered` (not `allItems`) means the server-side cursor matches
  // the user's filter, so we never ask for entries that would be discarded.
  const oldestTimestamp = filtered.length > 0
    ? filtered[filtered.length - 1].timestamp
    : undefined;

  // Build the server-side filter payload from the current UI state. When
  // `activeOnly` is on we push the live active session set to the server so
  // every loaded batch is pre-matched.
  const currentServerFilter = useMemo(() => {
    const f: {
      domain?: string;
      sessionIds?: string[];
      sessionContains?: string;
    } = {};
    if (domainFilter !== "all") f.domain = domainFilter;
    if (sessionFilter.trim()) f.sessionContains = sessionFilter.trim();
    if (activeOnly) f.sessionIds = Array.from(activeSessionIds).sort();
    return f;
  }, [domainFilter, sessionFilter, activeOnly, activeSessionIds]);

  // Stable string that changes iff the server filter changes. Drives the
  // reset effect below.
  const filterKey = useMemo(
    () => JSON.stringify(currentServerFilter),
    [currentServerFilter],
  );

  // Mutable state accessed from the IntersectionObserver callback. Refs
  // keep the callback free of stale closures.
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const loadingMoreRef = useRef(loadingMore);
  loadingMoreRef.current = loadingMore;
  const oldestRef = useRef<string | undefined>(oldestTimestamp);
  oldestRef.current = oldestTimestamp;
  const serverFilterRef = useRef(currentServerFilter);
  serverFilterRef.current = currentServerFilter;

  // Fetch generation counter — bumped on every filter reset and every
  // loadOlder call. Responses for stale generations are discarded.
  const fetchGenRef = useRef(0);

  async function loadOlder(): Promise<void> {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    const before = oldestRef.current;
    if (!before) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadError(null);

    const gen = ++fetchGenRef.current;
    const filterSnapshot = serverFilterRef.current;

    try {
      const res = await api.getAuditLogs({
        ...filterSnapshot,
        before,
        limit: PAGE_SIZE,
      });
      if (gen !== fetchGenRef.current) {
        // A later filter change or newer call has superseded this one.
        return;
      }
      const items = res.items;
      if (items.length === 0) {
        hasMoreRef.current = false;
        setHasMore(false);
      } else {
        setOlderItems((prev) => {
          const byId = new Map<string, AuditLogEntry>();
          for (const e of prev) byId.set(e.id, e);
          for (const e of items) byId.set(e.id, e);
          return Array.from(byId.values());
        });
        if (items.length < PAGE_SIZE) {
          hasMoreRef.current = false;
          setHasMore(false);
        }
      }
    } catch (e) {
      if (gen === fetchGenRef.current) {
        setLoadError((e as Error).message);
      }
    } finally {
      if (gen === fetchGenRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
        // Re-evaluate the sentinel's visibility. If the user is still
        // scrolled to the bottom, this fires the observer again and we
        // naturally chain the next batch. When the server runs out of
        // matches (`hasMore=false`), the early return at the top of
        // `loadOlder` stops the chain. No arbitrary caps needed.
        rearmSentinel();
      }
    }
  }

  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  // Sentinel element + observer: a callback ref attaches the IO once per
  // DOM mount of the sentinel. Lifecycle is DOM-driven, not state-driven,
  // so no effect dependency loops are possible.
  const sentinelElRef = useRef<HTMLDivElement | null>(null);
  const sentinelObserverRef = useRef<IntersectionObserver | null>(null);

  function rearmSentinel(): void {
    const el = sentinelElRef.current;
    const io = sentinelObserverRef.current;
    if (!el || !io) return;
    io.disconnect();
    io.observe(el);
  }

  const sentinelCallbackRef = useCallback((el: HTMLDivElement | null) => {
    // Tear down any previous observer.
    sentinelObserverRef.current?.disconnect();
    sentinelObserverRef.current = null;
    sentinelElRef.current = el;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadOlderRef.current();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    sentinelObserverRef.current = io;
  }, []);

  // Filter change → drop the older-pool, bump the generation (invalidating
  // any in-flight response), and re-arm the sentinel so the next batch
  // fetches against the new filter immediately if the sentinel is visible.
  useEffect(() => {
    fetchGenRef.current++;
    hasMoreRef.current = true;
    loadingMoreRef.current = false;
    setOlderItems([]);
    setHasMore(true);
    setLoadingMore(false);
    setLoadError(null);
    // Wait for the reset to flush before re-observing, so the sentinel is
    // back in its non-loading state when IO fires.
    queueMicrotask(rearmSentinel);
  }, [filterKey]);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      sentinelObserverRef.current?.disconnect();
      sentinelObserverRef.current = null;
    };
  }, []);

  const showSentinel = allItems.length > 0 && (hasMore || loadError != null);

  return (
    <div>
      <div class="filter-bar">
        <label>
          Domain
          <select
            class="select"
            value={domainFilter}
            onChange={(e) =>
              setDomainFilter((e.target as HTMLSelectElement).value)}
          >
            <option value="all">All</option>
            <option value="network">network</option>
            <option value="hostexec">hostexec</option>
          </select>
        </label>
        <label>
          Session
          <input
            type="text"
            class="input"
            placeholder="filter by id…"
            value={sessionFilter}
            onInput={(e) =>
              setSessionFilter((e.target as HTMLInputElement).value)}
            style="width:180px"
          />
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) =>
              setActiveOnly((e.target as HTMLInputElement).checked)}
          />
          Active only
        </label>
        <span
          class="counter"
          title={`${filtered.length} entries shown\n${allItems.length} entries in memory`}
        >
          {filtered.length} shown
        </span>
      </div>

      {allItems.length === 0
        ? (
          <div class="empty">
            <div class="icon">○</div>
            <div class="msg">No audit entries</div>
          </div>
        )
        : filtered.length === 0
        ? (
          <div class="empty">
            <div class="icon">○</div>
            <div class="msg">No matches</div>
            <div class="sub">
              Nothing matches the current filters.
              {hasMore && " Scroll down to load older entries."}
            </div>
          </div>
        )
        : (
          <table class="table">
            <colgroup>
              <col style="width:16%" />
              <col style="width:10%" />
              <col style="width:10%" />
              <col style="width:10%" />
              <col style="width:12%" />
              <col style="width:42%" />
            </colgroup>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Session</th>
                <th>Domain</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>Target / Command</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id}>
                  <td class="time">{formatTimestamp(entry.timestamp)}</td>
                  <td class="session" title={entry.sessionId}>
                    {entry.sessionId.slice(0, 8)}
                  </td>
                  <td>
                    <span class="chip">{entry.domain}</span>
                  </td>
                  <td>
                    <span class={`decision ${entry.decision}`}>
                      {entry.decision}
                    </span>
                  </td>
                  <td title={entry.reason}>{entry.reason}</td>
                  <td class="mono" title={entry.target || entry.command}>
                    {entry.target || entry.command || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {/*
        Sentinel is rendered whenever there's more to load, independent of
        whether the filter leaves any rows visible. When a narrow filter
        hides everything currently loaded, loading the next batch can still
        surface matches.
      */}
      {showSentinel && (
        <div ref={sentinelCallbackRef} class="scroll-sentinel">
          {loadError
            ? (
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => void loadOlder()}
              >
                Retry — {loadError}
              </button>
            )
            : loadingMore
            ? <span class="scroll-sentinel-msg">Loading older…</span>
            : <span class="scroll-sentinel-msg">Scroll for more</span>}
        </div>
      )}
      {!hasMore && !loadError && allItems.length > 0 && (
        <div class="scroll-sentinel">
          <span class="scroll-sentinel-msg muted">— end of history —</span>
        </div>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
  } catch {
    return iso;
  }
}
