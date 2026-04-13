import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type DtachSession } from "../api.ts";
import {
  ensureTerminalFocus,
  setupTerminalInputForwarding,
} from "./terminalInput.ts";

export function TerminalTab() {
  const [sessions, setSessions] = useState<DtachSession[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const DEFAULT_FONT_SIZE = 14;
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Fetch available dtach sessions
  const refreshSessions = useCallback(async () => {
    try {
      const res = await api.getTerminalSessions();
      setSessions(res.items);
    } catch (e) {
      console.error("Failed to fetch terminal sessions:", e);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 5000);
    return () => clearInterval(interval);
  }, [refreshSessions]);

  // Connect to a session (just set the state, xterm init happens in useEffect)
  const connect = useCallback((sessionId: string) => {
    setActiveSession(sessionId);
    setError(null);
  }, []);

  // Initialize xterm and WebSocket when activeSession changes
  useEffect(() => {
    if (!activeSession) return;

    // Cleanup previous connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    // Create and setup xterm
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      rightClickSelectsWord: false,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#0b0f1a",
        foreground: "#f5f8ff",
        cursor: "#9dd2ff",
        selectionBackground: "rgba(157, 210, 255, 0.3)",
        black: "#161e2e",
        red: "#ff8a8a",
        green: "#7ee8a4",
        yellow: "#ffd166",
        blue: "#9dd2ff",
        magenta: "#c9b0ff",
        cyan: "#7ee8e8",
        white: "#f5f8ff",
        brightBlack: "#8897b3",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#c6e5ff",
        brightMagenta: "#d8c4ff",
        brightCyan: "#a5f3f3",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;
    terminalRef.current = term;

    let cleanupInputForwarding = () => {};
    if (termRef.current) {
      term.open(termRef.current);
      cleanupInputForwarding = setupTerminalInputForwarding(
        term,
        termRef.current,
      );
      console.log(`[terminal] xterm opened, DOM:`, termRef.current);
      // Delay fit to ensure container is rendered
      requestAnimationFrame(() => {
        fitAddon.fit();
        term.focus();
        console.log(
          `[terminal] xterm fitted, dimensions:`,
          fitAddon.proposeDimensions(),
        );
      });
    } else {
      console.error(`[terminal] termRef.current is null!`);
      return;
    }

    // WebSocket connection
    const proto = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
    const host = globalThis.location?.host ?? "localhost:3939";
    const wsUrl = `${proto}//${host}/api/terminal/${encodeURIComponent(activeSession)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[terminal] WebSocket opened for ${activeSession}`);
      // Send initial resize
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        console.log(
          `[terminal] Sending initial resize: ${dims.cols}x${dims.rows}`,
        );
        ws.send(
          JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }),
        );
      }
    };

    ws.onmessage = (ev) => {
      console.log(
        `[terminal] Received message:`,
        ev.data.byteLength ?? ev.data.length,
        "bytes",
      );
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
      } else {
        term.write(ev.data);
      }
    };

    ws.onerror = (err) => {
      console.error(`[terminal] WebSocket error:`, err);
      setError("WebSocket connection error");
    };

    ws.onclose = (ev) => {
      console.log(
        `[terminal] WebSocket closed: code=${ev.code}, reason=${ev.reason}`,
      );
      if (ev.code !== 1000) {
        setError(`Disconnected: ${ev.reason || "connection lost"}`);
      }
    };

    // Terminal input → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    // Handle resize
    const onResize = () => {
      fitAddon.fit();
      ensureTerminalFocus(term);
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }),
        );
      }
    };

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    globalThis.addEventListener("resize", onResize);

    return () => {
      globalThis.removeEventListener("resize", onResize);
      cleanupInputForwarding();
    };
  }, [activeSession]);

  // Disconnect
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }
    fitAddonRef.current = null;
    setActiveSession(null);
    setError(null);
  }, []);

  const applyFontSize = useCallback((newSize: number) => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const ws = wsRef.current;
    if (!term || !fitAddon) return;
    term.options.fontSize = newSize;
    fitAddon.fit();
    ensureTerminalFocus(term);
    const dims = fitAddon.proposeDimensions();
    if (dims && ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }),
      );
    }
  }, []);

  const handleFontSizeDecrease = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.max(8, prev - 1);
      applyFontSize(next);
      return next;
    });
  }, [applyFontSize]);

  const handleRefit = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const term = terminalRef.current;
    const ws = wsRef.current;
    if (!fitAddon || !term) return;
    fitAddon.fit();
    ensureTerminalFocus(term);
    const dims = fitAddon.proposeDimensions();
    if (dims && ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }),
      );
    }
  }, []);

  const handleFontSizeIncrease = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.min(32, prev + 1);
      applyFontSize(next);
      return next;
    });
  }, [applyFontSize]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (terminalRef.current) terminalRef.current.dispose();
    };
  }, []);

  if (activeSession) {
    return (
      <div class="terminal-view">
        <div class="terminal-toolbar">
          <span class="terminal-session-label">
            <span class="chip chip-good">connected</span>
            <code>{activeSession}</code>
          </span>
          <div class="font-size-controls">
            <button
              type="button"
              class="btn btn-icon btn-ghost"
              title="Decrease font size"
              onClick={handleFontSizeDecrease}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              type="button"
              class="btn btn-icon btn-ghost"
              title="Refit terminal"
              onClick={handleRefit}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
            <button
              type="button"
              class="btn btn-icon btn-ghost"
              title="Increase font size"
              onClick={handleFontSizeIncrease}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <button type="button" class="btn btn-ghost" onClick={disconnect}>
            Disconnect
          </button>
        </div>
        {error && <div class="terminal-error">{error}</div>}
        <div class="terminal-container" ref={termRef} />
      </div>
    );
  }

  return (
    <div>
      <div class="panel-header">
        <div class="panel-title">
          Terminal Sessions
          <span class="count">{sessions.length}</span>
        </div>
        <button
          type="button"
          class="btn btn-ghost"
          style={{ marginLeft: "auto" }}
          onClick={refreshSessions}
        >
          Refresh
        </button>
      </div>
      {sessions.length === 0 ? (
        <div class="empty">
          <div class="icon">&#9002;</div>
          <div class="msg">No dtach sessions available</div>
          <div class="sub">
            Start a container with <code>nas run</code> to create a session
          </div>
        </div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th style={{ width: "40%" }}>Session ID</th>
              <th style={{ width: "35%" }}>Created</th>
              <th style={{ width: "25%" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sessionId}>
                <td class="session">{s.sessionId}</td>
                <td class="time">
                  {new Date(s.createdAt * 1000).toLocaleString()}
                </td>
                <td>
                  <button
                    type="button"
                    class="btn btn-primary"
                    onClick={() => connect(s.sessionId)}
                  >
                    Attach
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
