import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "preact/hooks";

interface TerminalModalProps {
  sessionId: string;
  visible: boolean;
  onClose: () => void;
  onMinimize: () => void;
}

export function TerminalModal({
  sessionId,
  visible,
  onClose,
  onMinimize,
}: TerminalModalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const errorRef = useRef<string | null>(null);
  const errorElRef = useRef<HTMLDivElement>(null);

  const setError = (msg: string | null) => {
    errorRef.current = msg;
    if (errorElRef.current) {
      errorElRef.current.textContent = msg ?? "";
      errorElRef.current.style.display = msg ? "block" : "none";
    }
  };

  // Initialize xterm + WebSocket on mount (sessionId won't change for a given modal instance)
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
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

    if (termRef.current) {
      term.open(termRef.current);
      requestAnimationFrame(() => fitAddon.fit());
    }

    // WebSocket
    const proto = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
    const host = globalThis.location?.host ?? "localhost:3939";
    const wsUrl = `${proto}//${host}/api/terminal/${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(
          JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }),
        );
      }
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
      } else {
        term.write(ev.data);
      }
    };

    ws.onerror = () => setError("WebSocket connection error");

    ws.onclose = (ev) => {
      if (ev.code !== 1000) {
        setError(`Disconnected: ${ev.reason || "connection lost"}`);
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const onResize = () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }),
        );
      }
    };
    globalThis.addEventListener("resize", onResize);

    return () => {
      globalThis.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
      wsRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  // Re-fit when modal becomes visible (restore from minimized)
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        // Also send resize to sync dtach
        const dims = fitAddonRef.current?.proposeDimensions();
        if (dims && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "resize",
              cols: dims.cols,
              rows: dims.rows,
            }),
          );
        }
      });
      // Focus the terminal
      terminalRef.current?.focus();
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }
    fitAddonRef.current = null;
    onClose();
  }, [onClose]);

  return (
    <div
      class="terminal-modal-overlay"
      style={{ display: visible ? "flex" : "none" }}
    >
      <div class="terminal-modal">
        <div class="terminal-modal-header">
          <span class="terminal-session-label">
            <span class="chip chip-good">connected</span>
            <code>{sessionId}</code>
          </span>
          <div class="terminal-modal-actions">
            <button type="button" class="btn btn-ghost" onClick={onMinimize}>
              Minimize
            </button>
            <button type="button" class="btn btn-deny" onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
        <div
          ref={errorElRef}
          class="terminal-error"
          style={{ display: "none" }}
        />
        <div class="terminal-container" ref={termRef} />
      </div>
    </div>
  );
}
