import { PendingPane } from "./components/PendingPane";
import { SessionsPane } from "./components/SessionsPane";
import { StatusBar } from "./components/StatusBar";
import { TerminalPane } from "./components/TerminalPane";
import { Topbar } from "./components/Topbar";

export function App() {
  return (
    <div class="app">
      <Topbar />
      <main class="workspace">
        <SessionsPane />
        <TerminalPane />
        <PendingPane />
      </main>
      <StatusBar />
    </div>
  );
}
