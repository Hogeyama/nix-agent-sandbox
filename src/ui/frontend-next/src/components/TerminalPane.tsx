import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { TerminalsStore } from "../stores/terminalsStore";
import {
  attachTerminalSession,
  type TerminalHandle,
} from "../terminal/attachTerminalSession";
import { applyTerminalActions } from "./applyTerminalActions";
import { reconcileTerminals } from "./reconcileTerminals";

type Props = {
  /**
   * Store backing the dtach session list and the active selection. The
   * effect below subscribes to both `dtachSessions()` and `activeId()`
   * so handle lifecycle stays in lockstep with the latest snapshot.
   */
  terminals: TerminalsStore;
  /**
   * Resolves the WebSocket bearer token at attach time. Injected (rather
   * than imported) so the host page is the single source of truth for
   * how the token is obtained, and so future tests of this component
   * can stub a deterministic value. May throw if the token meta tag is
   * missing — handled by the attach try/catch below.
   */
  wsToken: () => string;
};

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
      <footer class="term-toolbar"></footer>
    </section>
  );
}
