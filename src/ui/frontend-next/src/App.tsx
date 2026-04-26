import { PendingPane } from "./components/PendingPane";
import { SessionsPane } from "./components/SessionsPane";
import { StatusBar } from "./components/StatusBar";
import { TerminalPane } from "./components/TerminalPane";
import { Topbar } from "./components/Topbar";
import { useConnection } from "./hooks/useConnection";

export function App() {
  const { connected } = useConnection("/api/events");
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
