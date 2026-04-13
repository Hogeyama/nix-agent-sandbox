import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ensureTerminalFocus,
  setupTerminalInputForwarding,
} from "./terminalInput.ts";

interface TerminalModalProps {
  sessionId: string;
  visible: boolean;
  onClose: () => void;
  onAckTurn: (sessionId: string) => Promise<void> | void;
  canAckTurn: boolean;
  turnAcked: boolean;
  onMinimize: () => void;
}

export function TerminalModal({
  sessionId,
  visible,
  onClose,
  onAckTurn,
  canAckTurn,
  turnAcked,
  onMinimize,
}: TerminalModalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const errorRef = useRef<string | null>(null);
  const errorElRef = useRef<HTMLDivElement>(null);
  const [acking, setAcking] = useState(false);
  const [copied, setCopied] = useState(false);

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
      requestAnimationFrame(() => {
        fitAddon.fit();
        term.focus();
      });
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
      ensureTerminalFocus(term);
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
      cleanupInputForwarding();
      ws.close();
      term.dispose();
      wsRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  // Re-fit when modal becomes visible (restore from minimized)
  useEffect(() => {
    if (visible && fitAddonRef.current && terminalRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        // fit() 後にフォーカスを復帰（fit が DOM を操作するため順序が重要）
        ensureTerminalFocus(terminalRef.current!);
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

  const handleAck = useCallback(async () => {
    if (acking || !canAckTurn || turnAcked) return;
    setAcking(true);
    try {
      await onAckTurn(sessionId);
    } catch (e) {
      console.error("Failed to acknowledge turn from terminal:", e);
    } finally {
      setAcking(false);
      if (terminalRef.current) ensureTerminalFocus(terminalRef.current);
    }
  }, [acking, canAckTurn, onAckTurn, sessionId, turnAcked]);

  const handleCopyAttach = useCallback(() => {
    const cmd = `nas session attach ${sessionId}`;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
    if (terminalRef.current) ensureTerminalFocus(terminalRef.current);
  }, [sessionId]);

  const handleResize = useCallback(() => {
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

  // ボタンの mousedown でフォーカス移動を防止
  const preventFocusSteal = useCallback((e: MouseEvent) => {
    e.preventDefault();
  }, []);

  // オーバーレイ（モーダル外背景）クリックでターミナルにフォーカスを戻す
  const handleOverlayMouseDown = useCallback((e: MouseEvent) => {
    // モーダル自体のクリックは除外（バブルアップ防止）
    if (
      (e.target as HTMLElement).classList.contains("terminal-modal-overlay")
    ) {
      e.preventDefault();
      if (terminalRef.current) ensureTerminalFocus(terminalRef.current);
    }
  }, []);

  return (
    <div
      class="terminal-modal-overlay"
      style={{ display: visible ? "flex" : "none" }}
      onMouseDown={handleOverlayMouseDown}
    >
      <div class="terminal-modal">
        <div class="terminal-modal-header">
          <span class="terminal-session-label">
            <span class="chip chip-good">connected</span>
            <code>{sessionId}</code>
          </span>
          <div class="terminal-modal-actions">
            <button
              type="button"
              class={turnAcked ? "btn btn-ghost" : "btn btn-primary"}
              disabled={acking || turnAcked || !canAckTurn}
              onMouseDown={preventFocusSteal}
              onClick={handleAck}
            >
              {turnAcked ? "ACKed" : acking ? "ACK..." : "ACK turn"}
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              onMouseDown={preventFocusSteal}
              onClick={handleCopyAttach}
            >
              {copied ? "Copied!" : "Copy attach cmd"}
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              onMouseDown={preventFocusSteal}
              onClick={handleResize}
            >
              Resize
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              onMouseDown={preventFocusSteal}
              onClick={onMinimize}
            >
              Minimize
            </button>
            <button
              type="button"
              class="btn btn-deny"
              onMouseDown={preventFocusSteal}
              onClick={handleClose}
            >
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
