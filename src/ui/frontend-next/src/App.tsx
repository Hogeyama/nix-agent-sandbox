import { createSignal } from "solid-js";
import { getWsToken } from "./api/wsToken";
import { PendingPane } from "./components/PendingPane";
import { SessionsPane } from "./components/SessionsPane";
import { StatusBar } from "./components/StatusBar";
import { TerminalPane } from "./components/TerminalPane";
import { Topbar } from "./components/Topbar";
import { NewSessionDialog } from "./dialogs/NewSessionDialog";
import { createSseDispatch, SSE_EVENT_NAMES } from "./hooks/createSseDispatch";
import { useConnection } from "./hooks/useConnection";
import { createPendingStore } from "./stores/pendingStore";
import { createSessionsStore } from "./stores/sessionsStore";
import { createTerminalsStore } from "./stores/terminalsStore";

export function App() {
  const sessions = createSessionsStore();
  const pending = createPendingStore();
  const terminals = createTerminalsStore();
  const dispatch = createSseDispatch({ sessions, pending, terminals });
  const { connected } = useConnection("/api/events", dispatch, {
    eventNames: SSE_EVENT_NAMES,
  });
  const [dialogOpen, setDialogOpen] = createSignal(false);
  return (
    <div class="app">
      <Topbar
        connected={connected()}
        onNewSession={() => setDialogOpen(true)}
      />
      <main class="workspace">
        <SessionsPane sessions={sessions.rows} />
        <TerminalPane terminals={terminals} wsToken={() => getWsToken()} />
        <PendingPane network={pending.network} hostexec={pending.hostexec} />
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
