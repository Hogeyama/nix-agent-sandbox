import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import * as client from "./api/client";
import {
  ackSessionTurn,
  killTerminalClients,
  renameSession,
  startShell,
  stopContainer,
} from "./api/client";
import { getWsToken } from "./api/wsToken";
import { PaneResizer } from "./components/PaneResizer";
import { PendingPane } from "./components/PendingPane";
import { SessionsPane } from "./components/SessionsPane";
import { StatusBar } from "./components/StatusBar";
import { maxLamp } from "./components/sessionLamp";
import { summarizePendingBySession } from "./components/sessionPendingSummary";
import { SettingsShell } from "./components/settings/SettingsShell";
import { TerminalPane } from "./components/TerminalPane";
import { Topbar } from "./components/Topbar";
import { NewSessionDialog } from "./dialogs/NewSessionDialog";
import {
  createPendingActionHandlers,
  DEFAULT_HOSTEXEC_SCOPE,
  DEFAULT_NETWORK_SCOPE,
} from "./handlers/createPendingActionHandlers";
import { selectPendingTarget } from "./handlers/selectedPendingKey";
import { createSseDispatch, SSE_EVENT_NAMES } from "./hooks/createSseDispatch";
import { useConnection } from "./hooks/useConnection";
import { useFaviconBadge } from "./hooks/useFaviconBadge";
import { useGlobalKeyboard } from "./hooks/useGlobalKeyboard";
import { createRouter } from "./routes/router";
import { createAuditPageStore } from "./stores/auditPageStore";
import { createAuditStore } from "./stores/auditStore";
import { createPendingActionStore } from "./stores/pendingActionStore";
import { createPendingStore } from "./stores/pendingStore";
import { createSessionsStore } from "./stores/sessionsStore";
import { findShellForAgent } from "./stores/shellMapping";
import { createSidecarsStore } from "./stores/sidecarsStore";
import { createTerminalsStore } from "./stores/terminalsStore";
import type { SessionRow } from "./stores/types";
import { createUiStore } from "./stores/uiStore";

// Width of the collapsed-rail rendered in place of the right pane and
// of the drag-handle separators between panes; both are kept in sync
// with `.collapsed-rail` and `.pane-resizer` in styles.css.
const COLLAPSED_RAIL_PX = 38;
const RESIZER_PX = 4;

export function App() {
  const sessions = createSessionsStore();
  const sidecars = createSidecarsStore();
  const pending = createPendingStore();
  const pendingAction = createPendingActionStore();
  const terminals = createTerminalsStore();
  const audit = createAuditStore();
  // Owns the older-history pool of the Audit settings page. The store
  // is created once for the lifetime of `App`, while the AuditPage
  // component itself is mounted/unmounted by the SettingsShell's
  // `<Switch>/<Match>`. Survival across route changes therefore comes
  // from two cooperating moves: this long-lived store retains the
  // filter selection and the loaded older entries, and AuditPage
  // hydrates its local control signals from `store.state().displayFilter`
  // on every mount (with a `defer: true` filter-effect so the
  // remount itself does not dispatch a `reset` that would discard
  // the pool). See `AuditPage.tsx` for the full lifecycle contract.
  const auditPageStore = createAuditPageStore();
  const ui = createUiStore();
  // Single instantiation: handlers close over the same store and client
  // for the entire app lifetime so a re-render of `PendingPane` cannot
  // produce divergent closures.
  const pendingHandlers = createPendingActionHandlers({
    client,
    pending: pendingAction,
  });
  const dispatch = createSseDispatch({
    sessions,
    sidecars,
    pending,
    pendingAction,
    terminals,
    audit,
  });
  const { connected } = useConnection("/api/events", dispatch, {
    eventNames: SSE_EVENT_NAMES,
  });
  const [dialogOpen, setDialogOpen] = createSignal(false);

  // Routing: parse `window.location.hash` into a `Route`. The router
  // is instantiated once for the lifetime of `App` so the hashchange
  // listener is shared across re-renders. Workspace and SettingsShell
  // both stay mounted at all times — we toggle `display: none` on the
  // hidden side instead. Unmounting the workspace would tear down
  // every xterm instance and its dtach WebSocket on every gear click,
  // which is exactly the lifecycle this design is built to avoid.
  const router = createRouter();

  // Resolves the row that `Ctrl+Shift+A` / `Ctrl+Shift+D` should act
  // on: focused pending card first, then network[0], then hostexec[0],
  // and `null` when the right pane is collapsed (the user cannot see
  // which row would be acted on).
  const resolvePendingTarget = () =>
    selectPendingTarget({
      activeElement: document.activeElement,
      network: pending.network(),
      hostexec: pending.hostexec(),
      collapsed: ui.rightCollapsed(),
    });

  useGlobalKeyboard({
    onNewSession: () => setDialogOpen(true),
    // Index is 1-based and follows the rendered order of SessionsPane,
    // which mirrors the daemon's session-row delivery order.
    onSelectSessionByIndex: (index) => {
      const row = sessions.rows()[index - 1];
      if (row) terminals.selectSession(row.id);
    },
    onApproveSelected: () => {
      const target = resolvePendingTarget();
      if (target === null) return;
      const fallback =
        target.kind === "network"
          ? DEFAULT_NETWORK_SCOPE
          : DEFAULT_HOSTEXEC_SCOPE;
      const scope = pendingAction.scopeFor(target.row.key) ?? fallback;
      void pendingHandlers.onApprove(target.row, scope);
    },
    onDenySelected: () => {
      const target = resolvePendingTarget();
      if (target === null) return;
      void pendingHandlers.onDeny(target.row);
    },
    onToggleRightCollapse: ui.toggleRightCollapsed,
    onOpenSettings: () => router.navigate("#/settings/sidecars"),
    onOpenShortcuts: () => router.navigate("#/settings/keybinds"),
  });

  // Refit trigger for the active terminal. When `display: none` hides
  // the workspace while the Settings shell is open, xterm's fit addon
  // measures a 0x0 viewport and stores garbage dimensions. Bumping
  // this counter on the workspace return causes `TerminalPane` to
  // schedule a refit on the next animation frame, after layout has
  // settled and the viewport reports its real size again.
  const [terminalRefitTrigger, setTerminalRefitTrigger] = createSignal(0);

  // When the route transitions back to the workspace, request a refit
  // so any terminal that was hidden through `display: none` recovers
  // its real viewport dimensions. `on(..., { defer: true })` skips
  // the initial run so the trigger does not fire on first paint, when
  // the show action's own rAF refit already covers the active terminal.
  createEffect(
    on(
      () => router.route().kind,
      (kind) => {
        if (kind === "workspace") {
          setTerminalRefitTrigger((n) => n + 1);
        }
      },
      { defer: true },
    ),
  );

  // Reflect the chrome font size onto `<html>` as `--app-font-size`
  // so the rest of the document tree can scale via CSS variables
  // without subscribing to the store directly. The xterm font size
  // is owned by `TerminalToolbar` and does not read this variable.
  createEffect(() => {
    document.documentElement.style.setProperty(
      "--app-font-size",
      `${ui.fontSizePx()}px`,
    );
  });

  const isSettingsRoute = () => router.route().kind === "settings";
  // While the route is the workspace, the SettingsShell is hidden via
  // `display: none`; its `page` prop still needs a valid value, so we
  // pin it to the default page until the user navigates back into
  // Settings and the route resolves to a real `SettingsPage`.
  const settingsPage = () => {
    const route = router.route();
    return route.kind === "settings" ? route.page : "sidecars";
  };

  // Per-session pending counts, derived once per pending-store change so
  // every SessionsPane row reads from the same memo instead of re-folding
  // both queues on every row reactive read. The accessor below returns a
  // zero record for sessions that have no pending entries.
  const pendingByKey = createMemo(() =>
    summarizePendingBySession(pending.network(), pending.hostexec()),
  );
  const pendingFor = (sessionId: string) =>
    pendingByKey().get(sessionId) ?? { network: 0, hostexec: 0 };

  // Favicon badge: re-rendered only when the aggregate lamp transitions
  // (a `createMemo` with the default `===` equality dedupes per-row
  // mutations that don't change the aggregate). The accessor adapts
  // `SessionRow.id` to `sessionLamp`'s structural shape (`sessionId`).
  const aggregateLamp = createMemo(() =>
    maxLamp(
      sessions.rows().map((row) => ({ sessionId: row.id, turn: row.turn })),
      pendingFor,
    ),
  );
  useFaviconBadge(aggregateLamp);

  // Active session ids are derived from running agent containers and
  // sessions with at least one pending approval. The Audit settings
  // page consumes this set to filter rows when "Active only" is on
  // and to build the server-side `sessions` membership filter.
  const activeIds = createMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const row of sessions.rows()) ids.add(row.id);
    for (const row of pending.network()) ids.add(row.sessionId);
    for (const row of pending.hostexec()) ids.add(row.sessionId);
    return ids;
  });

  const gridTemplateColumns = () =>
    ui.rightCollapsed()
      ? `${ui.leftWidth()}px ${RESIZER_PX}px 1fr ${COLLAPSED_RAIL_PX}px`
      : `${ui.leftWidth()}px ${RESIZER_PX}px 1fr ${RESIZER_PX}px ${ui.rightWidth()}px`;

  // The toggle has three branches:
  //
  //   - Currently viewing the shell → switch back to the agent terminal
  //     by recording the view and pointing activeId at the agent id.
  //   - Currently viewing the agent and a live shell already exists →
  //     attach to the existing shell rather than spawning a new one;
  //     the daemon allows multiple shells per container, but the UI
  //     pins to the highest-seq shell to keep "1 container = 1 visible
  //     shell" from the user's point of view.
  //   - Currently viewing the agent and no live shell exists → start
  //     a new shell. `tryBeginShellSpawn` is the per-agent guard that
  //     turns a double-click into a single POST; the in-flight flag
  //     is cleared in `finally` so a failed spawn does not leave the
  //     button stuck on "Spawning…".
  const handleShellToggle = async (row: SessionRow) => {
    const view = terminals.getViewFor(row.id);
    if (view === "shell") {
      terminals.setViewFor(row.id, "agent");
      terminals.setActive(row.id);
      return;
    }
    const existing = findShellForAgent(row.id, terminals.dtachSessions());
    if (existing !== null) {
      terminals.setViewFor(row.id, "shell");
      terminals.setActive(existing.sessionId);
      return;
    }
    if (!terminals.tryBeginShellSpawn(row.id)) return;
    try {
      const { dtachSessionId } = await startShell(row.containerName);
      terminals.setViewFor(row.id, "shell");
      terminals.requestActivate(dtachSessionId);
    } finally {
      terminals.clearShellSpawnInFlight(row.id);
    }
  };

  return (
    <div class="app" classList={{ "right-collapsed": ui.rightCollapsed() }}>
      <Topbar
        connected={connected()}
        onNewSession={() => setDialogOpen(true)}
      />
      <main
        class="workspace"
        classList={{ "workspace-hidden": isSettingsRoute() }}
        style={{ "grid-template-columns": gridTemplateColumns() }}
      >
        <SessionsPane
          sessions={sessions.rows}
          activeId={terminals.activeId}
          onSelect={(id) => terminals.selectSession(id)}
          onRename={async (sessionId, name) => {
            await renameSession(sessionId, name);
          }}
          pendingFor={pendingFor}
        />
        <PaneResizer
          side="left"
          width={ui.leftWidth}
          setWidth={ui.setLeftWidth}
        />
        <TerminalPane
          terminals={terminals}
          sessions={sessions}
          wsToken={() => getWsToken()}
          onAck={async (id) => {
            await ackSessionTurn(id);
          }}
          onKillClients={async (id) => {
            await killTerminalClients(id);
          }}
          onRename={async (sessionId, name) => {
            await renameSession(sessionId, name);
          }}
          onShellToggle={handleShellToggle}
          refitTrigger={terminalRefitTrigger}
        />
        {/* The right resizer is unmounted while collapsed so that the
            workspace grid track count matches the children count. The
            .pane-right element drives the collapse animation; the
            grid-template-columns transition cannot interpolate when the
            track count changes. */}
        <Show when={!ui.rightCollapsed()}>
          <PaneResizer
            side="right"
            width={ui.rightWidth}
            setWidth={ui.setRightWidth}
          />
        </Show>
        <PendingPane
          network={pending.network}
          hostexec={pending.hostexec}
          collapsed={ui.rightCollapsed}
          onToggleCollapse={ui.toggleRightCollapsed}
          scopeFor={pendingAction.scopeFor}
          busyFor={pendingAction.busyFor}
          errorFor={pendingAction.errorFor}
          setScope={pendingAction.setScope}
          onApprove={pendingHandlers.onApprove}
          onDeny={pendingHandlers.onDeny}
          auditEntries={audit.entries}
        />
      </main>
      {/* SettingsShell stays mounted alongside the workspace and toggles
          via `display: none` so its child state survives route changes
          the same way the workspace's xterm instances do. The `page`
          accessor reads the active settings page; while the route is
          the workspace it falls back to the default page so the shell
          still has a valid props value while it is hidden. */}
      <SettingsShell
        page={settingsPage()}
        hidden={!isSettingsRoute()}
        sidecars={sidecars.rows}
        onStop={(name) => stopContainer(name)}
        auditLiveRows={audit.entries}
        auditActiveIds={activeIds}
        auditPageStore={auditPageStore}
        fetchAuditLogs={client.getAuditLogs}
        ui={ui}
      />
      <StatusBar />
      <NewSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onLaunched={(id) => terminals.requestActivate(id)}
      />
    </div>
  );
}
