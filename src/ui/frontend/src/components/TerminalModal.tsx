import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ensureTerminalFocus,
  setupTerminalInputForwarding,
} from "./terminalInput.ts";

interface TerminalSessionTab {
  sessionId: string;
  sessionName?: string;
  canAckTurn: boolean;
  turnAcked: boolean;
  isOpen: boolean;
}

interface TerminalModalProps {
  sessions: TerminalSessionTab[];
  activeSessionId: string;
  visible: boolean;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, name: string) => Promise<void> | void;
  onAckTurn: (sessionId: string) => Promise<void> | void;
  onMinimize: () => void;
}

interface TerminalPaneProps extends TerminalSessionTab {
  visible: boolean;
  tabs: TerminalSessionTab[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, name: string) => Promise<void> | void;
  onAckTurn: (sessionId: string) => Promise<void> | void;
  onMinimize: () => void;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

function getTerminalSize(
  fitAddon: Pick<FitAddon, "proposeDimensions"> | null | undefined,
): TerminalSize | null {
  const dims = fitAddon?.proposeDimensions();
  if (
    !dims ||
    !Number.isInteger(dims.cols) ||
    dims.cols <= 0 ||
    !Number.isInteger(dims.rows) ||
    dims.rows <= 0
  ) {
    return null;
  }
  return { cols: dims.cols, rows: dims.rows };
}

function sendTerminalResize(ws: WebSocket, size: TerminalSize): void {
  ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
}

function TerminalTabLabel({
  sessionId,
  sessionName,
  isActive,
  onRenameSession,
  onDone,
}: {
  sessionId: string;
  sessionName?: string;
  isActive: boolean;
  onRenameSession: (sessionId: string, name: string) => Promise<void> | void;
  onDone?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(sessionName ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input explicitly after entering edit mode.
  // autoFocus alone doesn't work because the parent button's
  // onMouseDown={preventFocusSteal} calls preventDefault() on the
  // double-click's mousedown events, suppressing browser focus transfer.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);

  const handleSave = useCallback(async () => {
    const next = value.trim();
    if (!next) return;
    setSaving(true);
    try {
      await onRenameSession(sessionId, next);
      setEditing(false);
      onDone?.();
    } catch (e) {
      console.error("Failed to rename session from terminal:", e);
    } finally {
      setSaving(false);
    }
  }, [onDone, onRenameSession, sessionId, value]);

  if (editing) {
    return (
      <span
        class="terminal-session-name-editor"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          value={value}
          class="terminal-session-name-input"
          ref={inputRef}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
            if (e.key === "Escape") {
              setEditing(false);
              onDone?.();
            }
          }}
          disabled={saving}
        />
        <button
          type="button"
          class="btn btn-ghost terminal-session-name-save"
          disabled={saving || !value.trim()}
          onClick={() => void handleSave()}
        >
          {saving ? "..." : "OK"}
        </button>
        <button
          type="button"
          class="btn btn-ghost terminal-session-name-cancel"
          disabled={saving}
          onClick={() => {
            setEditing(false);
            onDone?.();
          }}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span
      class="terminal-modal-tab-label"
      onDblClick={
        isActive
          ? (e) => {
              e.stopPropagation();
              setValue(sessionName ?? "");
              setEditing(true);
            }
          : undefined
      }
      title={isActive ? "Double-click to rename" : undefined}
    >
      {sessionName || sessionId}
    </span>
  );
}

function TerminalPane({
  sessionId,
  sessionName,
  visible,
  tabs,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  canAckTurn,
  turnAcked,
  onAckTurn,
  onMinimize,
}: TerminalPaneProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const errorRef = useRef<string | null>(null);
  const errorElRef = useRef<HTMLDivElement>(null);
  const [acking, setAcking] = useState(false);
  const [copied, setCopied] = useState(false);
  const DEFAULT_FONT_SIZE = 14;
  const [, setFontSize] = useState(DEFAULT_FONT_SIZE);

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
      if (visible) {
        requestAnimationFrame(() => {
          fitAddon.fit();
          term.focus();
        });
      }
    }

    // Right-click to copy selected text (Windows Terminal style)
    const handleContextMenu = (e: MouseEvent) => {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        navigator.clipboard.writeText(sel);
        term.clearSelection();
      }
    };
    termRef.current?.addEventListener("contextmenu", handleContextMenu);

    // WebSocket
    const proto = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
    const host = globalThis.location?.host ?? "localhost:3939";
    const wsUrl = `${proto}//${host}/api/terminal/${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    let receivedData = false;

    ws.onopen = () => {
      const size = getTerminalSize(fitAddon);
      if (size) {
        sendTerminalResize(ws, size);
      }
      // dtach ignores SIGWINCH when the size hasn't changed.
      // If no data arrives within 1s, force a size change by temporarily
      // shrinking by 1 col, then restoring the real size.
      setTimeout(() => {
        if (!receivedData && ws.readyState === WebSocket.OPEN) {
          const retrySize = getTerminalSize(fitAddon);
          if (retrySize) {
            sendTerminalResize(ws, {
              cols:
                retrySize.cols > 1 ? retrySize.cols - 1 : retrySize.cols + 1,
              rows: retrySize.rows,
            });
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                sendTerminalResize(ws, retrySize);
              }
            }, 200);
          }
        }
      }, 1000);
    };

    ws.onmessage = (ev) => {
      receivedData = true;
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
        sendTerminalResize(ws, { cols, rows });
      }
    });

    const onResize = () => {
      fitAddon.fit();
      ensureTerminalFocus(term);
      const size = getTerminalSize(fitAddon);
      if (size && ws.readyState === WebSocket.OPEN) {
        sendTerminalResize(ws, size);
      }
    };
    globalThis.addEventListener("resize", onResize);

    return () => {
      termRef.current?.removeEventListener("contextmenu", handleContextMenu);
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
        const fitAddon = fitAddonRef.current;
        const term = terminalRef.current;
        fitAddon?.fit();
        if (term) {
          ensureTerminalFocus(term);
        }
        // Also send resize to sync dtach
        const size = getTerminalSize(fitAddon);
        if (size && wsRef.current?.readyState === WebSocket.OPEN) {
          sendTerminalResize(wsRef.current, size);
        }
      });
    }
  }, [visible]);

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

  const applyFontSize = useCallback((newSize: number) => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const ws = wsRef.current;
    if (!term || !fitAddon) return;
    term.options.fontSize = newSize;
    fitAddon.fit();
    ensureTerminalFocus(term);
    const size = getTerminalSize(fitAddon);
    if (size && ws?.readyState === WebSocket.OPEN) {
      sendTerminalResize(ws, size);
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
    if (!fitAddon || !term || !ws || ws.readyState !== WebSocket.OPEN) return;
    fitAddon.fit();
    ensureTerminalFocus(term);
    const size = getTerminalSize(fitAddon);
    if (size) {
      // Send a slightly different size first, then restore, to force
      // dtach to deliver SIGWINCH (it ignores same-size resizes).
      sendTerminalResize(ws, {
        cols: size.cols > 1 ? size.cols - 1 : size.cols + 1,
        rows: size.rows,
      });
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          sendTerminalResize(ws, size);
        }
      }, 200);
    }
  }, []);

  const handleFontSizeIncrease = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.min(32, prev + 1);
      applyFontSize(next);
      return next;
    });
  }, [applyFontSize]);

  // ボタンの mousedown でフォーカス移動を防止
  const preventFocusSteal = useCallback((e: MouseEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div
      class="terminal-modal-pane"
      data-active={visible ? "true" : "false"}
      style={{ display: visible ? "flex" : "none" }}
    >
      <div class="terminal-modal-header">
        <div class="terminal-modal-tabs">
          {tabs.map((tab) => {
            const isActive = tab.sessionId === activeSessionId;
            return (
              <div
                key={tab.sessionId}
                class={`terminal-modal-tab${isActive ? " active" : ""}${
                  tab.isOpen ? "" : " pending-open"
                }`}
              >
                {tab.canAckTurn && (
                  <span class="terminal-modal-tab-badge" title="Your turn" />
                )}
                <button
                  type="button"
                  class="terminal-modal-tab-select"
                  title={
                    tab.isOpen
                      ? tab.sessionName || tab.sessionId
                      : `Attach ${tab.sessionName || tab.sessionId}`
                  }
                  onMouseDown={preventFocusSteal}
                  onClick={() => onSelectSession(tab.sessionId)}
                >
                  <TerminalTabLabel
                    sessionId={tab.sessionId}
                    sessionName={tab.sessionName}
                    isActive={isActive}
                    onRenameSession={onRenameSession}
                    onDone={() => {
                      if (terminalRef.current)
                        ensureTerminalFocus(terminalRef.current);
                    }}
                  />
                </button>
                {tab.isOpen && (
                  <button
                    type="button"
                    class="terminal-modal-tab-close"
                    title="Close terminal tab"
                    onMouseDown={preventFocusSteal}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseSession(tab.sessionId);
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      focusable="false"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div class="terminal-modal-actions">
          <button
            type="button"
            class="btn btn-icon btn-ghost"
            title={copied ? "Copied!" : "Copy attach command"}
            onMouseDown={preventFocusSteal}
            onClick={handleCopyAttach}
          >
            {copied ? (
              <svg
                aria-hidden="true"
                focusable="false"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                focusable="false"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          <div class="font-size-controls">
            <button
              type="button"
              class="btn btn-icon btn-ghost"
              title="Decrease font size"
              onMouseDown={preventFocusSteal}
              onClick={handleFontSizeDecrease}
            >
              <svg
                aria-hidden="true"
                focusable="false"
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
              onMouseDown={preventFocusSteal}
              onClick={handleRefit}
            >
              <svg
                aria-hidden="true"
                focusable="false"
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
              onMouseDown={preventFocusSteal}
              onClick={handleFontSizeIncrease}
            >
              <svg
                aria-hidden="true"
                focusable="false"
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
            class="btn btn-danger"
            onMouseDown={preventFocusSteal}
            onClick={onMinimize}
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
  );
}

export function TerminalModal({
  sessions,
  activeSessionId,
  visible,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  onAckTurn,
  onMinimize,
}: TerminalModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const resolvedActiveSessionId =
    sessions.find((session) => session.sessionId === activeSessionId)
      ?.sessionId ?? sessions[0]?.sessionId;

  const handleOverlayMouseDown = useCallback((e: MouseEvent) => {
    if (
      !(e.target as HTMLElement).classList.contains("terminal-modal-overlay")
    ) {
      return;
    }
    e.preventDefault();
    const helper = document.querySelector(
      '.terminal-modal-pane[data-active="true"] .xterm-helper-textarea',
    );
    if (helper instanceof HTMLTextAreaElement) {
      helper.focus();
    }
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const listener = (e: MouseEvent) => handleOverlayMouseDown(e);
    overlay.addEventListener("mousedown", listener);
    return () => {
      overlay.removeEventListener("mousedown", listener);
    };
  }, [handleOverlayMouseDown]);

  if (!resolvedActiveSessionId) return null;

  return (
    <div
      ref={overlayRef}
      class="terminal-modal-overlay"
      style={{ display: visible ? "flex" : "none" }}
    >
      <div class="terminal-modal" role="dialog" aria-modal="true">
        {sessions
          .filter((session) => session.isOpen)
          .map((session) => (
            <TerminalPane
              key={session.sessionId}
              {...session}
              tabs={sessions}
              activeSessionId={resolvedActiveSessionId}
              visible={visible && session.sessionId === resolvedActiveSessionId}
              onSelectSession={onSelectSession}
              onCloseSession={onCloseSession}
              onRenameSession={onRenameSession}
              onAckTurn={onAckTurn}
              onMinimize={onMinimize}
            />
          ))}
      </div>
    </div>
  );
}
