import { createSignal, Show } from "solid-js";
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
import { TerminalPane } from "./components/TerminalPane";
import { Topbar } from "./components/Topbar";
import { NewSessionDialog } from "./dialogs/NewSessionDialog";
import { createSseDispatch, SSE_EVENT_NAMES } from "./hooks/createSseDispatch";
import { useConnection } from "./hooks/useConnection";
import { useGlobalKeyboard } from "./hooks/useGlobalKeyboard";
import { createPendingStore } from "./stores/pendingStore";
import { createSessionsStore } from "./stores/sessionsStore";
import { findShellForAgent } from "./stores/shellMapping";
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
  const pending = createPendingStore();
  const terminals = createTerminalsStore();
  const ui = createUiStore();
  const dispatch = createSseDispatch({ sessions, pending, terminals });
  const { connected } = useConnection("/api/events", dispatch, {
    eventNames: SSE_EVENT_NAMES,
  });
  const [dialogOpen, setDialogOpen] = createSignal(false);
  useGlobalKeyboard({ onToggleRightCollapse: ui.toggleRightCollapsed });

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
        style={{ "grid-template-columns": gridTemplateColumns() }}
      >
        <SessionsPane
          sessions={sessions.rows}
          activeId={terminals.activeId}
          viewFor={(id) => terminals.getViewFor(id)}
          shellSpawnInFlight={(id) => terminals.isShellSpawnInFlight(id)}
          onSelect={(id) => terminals.selectSession(id)}
          onStop={async (containerName) => {
            await stopContainer(containerName);
          }}
          onRename={async (sessionId, name) => {
            await renameSession(sessionId, name);
          }}
          onShellToggle={handleShellToggle}
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
        />
      </main>
      <StatusBar />
      <NewSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onLaunched={(id) => terminals.requestActivate(id)}
      />
    </div>
  );
}
