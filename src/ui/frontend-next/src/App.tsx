import { PendingPane } from "./components/PendingPane";
import { SessionsPane } from "./components/SessionsPane";
import { StatusBar } from "./components/StatusBar";
import { TerminalPane } from "./components/TerminalPane";
import { Topbar } from "./components/Topbar";
import { createSseDispatch, SSE_EVENT_NAMES } from "./hooks/createSseDispatch";
import { useConnection } from "./hooks/useConnection";
import { createPendingStore } from "./stores/pendingStore";
import { createSessionsStore } from "./stores/sessionsStore";

export function App() {
  const sessions = createSessionsStore();
  const pending = createPendingStore();
  const dispatch = createSseDispatch({ sessions, pending });
  const { connected } = useConnection("/api/events", dispatch, {
    eventNames: SSE_EVENT_NAMES,
  });
  return (
    <div class="app">
      <Topbar connected={connected()} />
      <main class="workspace">
        <SessionsPane />
        <TerminalPane />
        <PendingPane />
      </main>
      <StatusBar />
    </div>
  );
}
