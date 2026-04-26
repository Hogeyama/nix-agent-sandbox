import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import type { SessionsStore } from "../stores/sessionsStore";
import { resolveContextAgentRow } from "../stores/shellMapping";
import type { TerminalsStore } from "../stores/terminalsStore";
import type { SessionRow } from "../stores/types";
import {
  attachTerminalSession,
  type TerminalHandle,
} from "../terminal/attachTerminalSession";
import { applyTerminalActions } from "./applyTerminalActions";
import { reconcileTerminals } from "./reconcileTerminals";
import { TerminalToolbar } from "./TerminalToolbar";

type Props = {
  /**
   * Store backing the dtach session list and the active selection. The
   * effect below subscribes to both `dtachSessions()` and `activeId()`
   * so handle lifecycle stays in lockstep with the latest snapshot.
   */
  terminals: TerminalsStore;
  /**
   * Sessions store consulted by the toolbar to resolve the active row's
   * display name, short id, and turn. Kept separate from `terminals`
   * because the agent-metadata snapshot lives there.
   */
  sessions: SessionsStore;
  /**
   * Resolves the WebSocket bearer token at attach time. Injected (rather
   * than imported) so the host page is the single source of truth for
   * how the token is obtained, and so future tests of this component
   * can stub a deterministic value. May throw if the token meta tag is
   * missing — handled by the attach try/catch below.
   */
  wsToken: () => string;
  /**
   * Acknowledge the active session's turn. The toolbar disables its
   * button while this promise is in flight and silently absorbs a
   * 409 response (raced snapshot — SSE catches up).
   */
  onAck: (sessionId: string) => Promise<void>;
  /**
   * Disconnect every dtach client currently attached to a session,
   * leaving the session itself running. The toolbar disables its
   * button while this promise is in flight and surfaces non-success.
   */
  onKillClients: (sessionId: string) => Promise<void>;
  onRename: (sessionId: string, name: string) => Promise<void>;
  /**
   * Switch the center pane between the agent terminal and a shell on
   * the same container. The handler is shared with the left-pane Shell
   * button so both surfaces drive a single toggle path; the toolbar
   * delegates state to it without owning any of its own.
   */
  onShellToggle: (row: SessionRow) => void | Promise<void>;
};

export interface TerminalToolbarContext {
  contextAgentRow: SessionRow | null;
  ackTargetSessionId: string | null;
  activeTerminalId: string | null;
}

/**
 * Describes the toolbar's current display context and action targets.
 * Shell terminals keep the parent agent row for display and agent-scoped
 * actions, while terminal-scoped actions continue to target the active
 * terminal session id.
 */
export function describeTerminalToolbarContext(
  activeTerminalId: string | null,
  rows: readonly SessionRow[],
): TerminalToolbarContext {
  const contextAgentRow = resolveContextAgentRow(activeTerminalId, rows);
  return {
    contextAgentRow,
    ackTargetSessionId: contextAgentRow?.id ?? null,
    activeTerminalId,
  };
}

/**
 * Center-pane terminal host with keep-alive semantics.
 *
 * Each session the user has visited keeps its own xterm handle and
 * absolutely-positioned DOM slot inside `containerRef`. Switching the
 * active session toggles `hidden` on the slots rather than tearing down
 * and reconstructing xterm, so scrollback, dtach state, and the
 * WebSocket all survive a round-trip away from the session.
 *
 * The lifecycle splits into three layers:
 *
 *   - `reconcileTerminals` (pure) reduces the previous active id, the
 *     next active id, the live snapshot, and the currently-mounted set
 *     into discrete actions.
 *   - `applyTerminalActions` (Solid-free) dispatches those actions to
 *     the per-action callbacks below and schedules the post-show refit
 *     on the next animation frame.
 *   - The Solid effect feeds the reducer with current state and clears
 *     `prevActiveId` after dispatch so the next reconciliation sees a
 *     consistent snapshot.
 *
 * `onCleanup` walks every mounted handle on unmount so a hot reload or
 * pane teardown cannot leak a WebSocket. `errorMessage` is a single
 * signal shared across sessions; per-session error surfacing is out of
 * scope for this layer.
 */
export function TerminalPane(props: Props) {
  let containerRef!: HTMLDivElement;
  // Map preserves insertion order, which both `mountedSessionIds` and
  // the dispose-all path on cleanup rely on for deterministic ordering.
  const handles = new Map<
    string,
    { handle: TerminalHandle; node: HTMLDivElement }
  >();
  let prevActiveId: string | null = null;
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  // Bumps when handles map mutates so memos that read the map invalidate.
  const [handlesVersion, setHandlesVersion] = createSignal(0);

  const mount = (sessionId: string) => {
    if (handles.has(sessionId)) return;
    setErrorMessage(null);
    const slot = document.createElement("div");
    slot.className = "terminal-slot";
    // Start hidden; the show action flips this back on after rAF.
    slot.hidden = true;
    containerRef.appendChild(slot);
    let handle: TerminalHandle;
    try {
      const token = props.wsToken();
      handle = attachTerminalSession({
        sessionId,
        container: slot,
        wsToken: token,
        onError: (msg) => setErrorMessage(msg),
      });
    } catch (e) {
      slot.remove();
      setErrorMessage(
        e instanceof Error ? e.message : "Failed to attach terminal session",
      );
      return;
    }
    handles.set(sessionId, { handle, node: slot });
    setHandlesVersion((v) => v + 1);
  };

  const dispose = (sessionId: string) => {
    const entry = handles.get(sessionId);
    if (!entry) return;
    // Dispose the handle first so the addon's ResizeObserver detaches
    // before the node is removed; observing a removed node fires a
    // benign-but-noisy error in some browsers.
    entry.handle.dispose();
    entry.node.remove();
    handles.delete(sessionId);
    setHandlesVersion((v) => v + 1);
  };

  const show = (sessionId: string) => {
    const entry = handles.get(sessionId);
    if (!entry) return;
    entry.node.hidden = false;
  };

  const hide = (sessionId: string) => {
    const entry = handles.get(sessionId);
    if (!entry) return;
    entry.node.hidden = true;
  };

  createEffect(() => {
    const nextActive = props.terminals.activeId();
    const liveIds = new Set(
      props.terminals.dtachSessions().map((s) => s.sessionId),
    );
    const mountedIds = new Set(handles.keys());
    const actions = reconcileTerminals(
      prevActiveId,
      nextActive,
      liveIds,
      mountedIds,
    );
    applyTerminalActions(actions, {
      mount,
      dispose,
      show,
      hide,
      requestAnimationFrame: (cb) => globalThis.requestAnimationFrame(cb),
      getHandle: (id) => handles.get(id)?.handle,
    });
    prevActiveId = nextActive;
  });

  onCleanup(() => {
    for (const sessionId of Array.from(handles.keys())) {
      dispose(sessionId);
    }
  });

  const activeTerminalId = createMemo(() => props.terminals.activeId());
  // The toolbar reads handles through a memo so it re-evaluates whenever
  // the active terminal changes or the handles map mutates. `activeId` is
  // a signal already, and `handlesVersion` is bumped on every mount/dispose
  // so a handle attached after the activeId change is also observable.
  const activeTerminalHandle = createMemo<TerminalHandle | null>(() => {
    handlesVersion();
    const id = activeTerminalId();
    if (!id) return null;
    return handles.get(id)?.handle ?? null;
  });
  const toolbarContext = createMemo(() =>
    describeTerminalToolbarContext(activeTerminalId(), props.sessions.rows()),
  );

  return (
    <section class="pane pane-center">
      <div
        class="terminal"
        data-active-id={props.terminals.activeId() ?? ""}
        ref={containerRef}
      >
        <Show when={!props.terminals.activeId()}>
          <div class="terminal-empty">
            Launch a session to attach a terminal
          </div>
        </Show>
        <Show when={errorMessage()}>
          {(msg) => <div class="terminal-error">{msg()}</div>}
        </Show>
      </div>
      <TerminalToolbar
        contextAgentRow={() => toolbarContext().contextAgentRow}
        ackTargetSessionId={() => toolbarContext().ackTargetSessionId}
        activeTerminalHandle={activeTerminalHandle}
        activeTerminalId={() => toolbarContext().activeTerminalId}
        viewFor={(id) => props.terminals.getViewFor(id)}
        shellSpawnInFlight={(id) => props.terminals.isShellSpawnInFlight(id)}
        onAck={props.onAck}
        onKillClients={props.onKillClients}
        onRename={props.onRename}
        onShellToggle={props.onShellToggle}
      />
    </section>
  );
}
