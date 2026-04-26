import { createSignal, Show } from "solid-js";
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
import { createTerminalsStore } from "./stores/terminalsStore";
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
          onSelect={(id) => terminals.selectSession(id)}
        />
        <PaneResizer
          side="left"
          width={ui.leftWidth}
          setWidth={ui.setLeftWidth}
        />
        <TerminalPane terminals={terminals} wsToken={() => getWsToken()} />
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
