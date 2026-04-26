import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { TerminalsStore } from "../stores/terminalsStore";
import {
  attachTerminalSession,
  type TerminalHandle,
} from "../terminal/attachTerminalSession";
import { pickTerminalAction } from "./terminalPaneTransition";

type Props = {
  /**
   * Store backing the active dtach session this pane attaches to.
   * Held on props so the effect below can subscribe to `activeId()` and
   * mount/dispose xterm in lockstep with the selection.
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
 * Center-pane terminal host.
 *
 * Owns no terminal logic itself — `attachTerminalSession` is the
 * Solid-agnostic factory that constructs the xterm instance and the
 * dtach WebSocket. This component is purely the bridge between Solid's
 * reactivity and that imperative handle:
 *
 *   - `onMount` runs once after the initial render so `containerRef` is
 *     guaranteed to point at a real DOM node before any attach attempt.
 *     If `activeId()` is already set at that point, an initial mount
 *     fires here.
 *   - `createEffect` then takes over to track every subsequent change,
 *     diffing previous and next id via `pickTerminalAction` so the body
 *     reduces to a single `switch`.
 *   - `onCleanup` disposes the live handle when the component itself
 *     unmounts, preventing a WebSocket leak on hot reload or pane
 *     teardown.
 *
 * The toolbar slot is rendered empty: ack / shell / search affordances
 * live in a different layer and are wired in elsewhere.
 */
export function TerminalPane(props: Props) {
  let containerRef!: HTMLDivElement;
  let handleRef: TerminalHandle | null = null;
  let prevActiveId: string | null = null;
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  const mount = (sessionId: string) => {
    setErrorMessage(null);
    try {
      const token = props.wsToken();
      handleRef = attachTerminalSession({
        sessionId,
        container: containerRef,
        wsToken: token,
        onError: (msg) => setErrorMessage(msg),
      });
    } catch (e) {
      handleRef = null;
      setErrorMessage(
        e instanceof Error ? e.message : "Failed to attach terminal session",
      );
    }
  };

  const unmount = () => {
    handleRef?.dispose();
    handleRef = null;
    // Clear any prior attach error so a stale `.terminal-error` does not
    // linger on top of `.terminal-empty` once `activeId` returns to null.
    setErrorMessage(null);
  };

  // Registration order matters: Solid invokes `onMount` and `createEffect`
  // in the order they are registered. We register `onMount` first so it
  // sets `prevActiveId = initialId` before the effect's initial run; the
  // effect then sees `nextId === prevActiveId` and resolves to `noop`,
  // avoiding a duplicate mount. Swapping the order would cause the first
  // attach to fire twice.
  onMount(() => {
    const initialId = props.terminals.activeId();
    if (initialId !== null) {
      mount(initialId);
    }
    prevActiveId = initialId;
  });

  createEffect(() => {
    const nextId = props.terminals.activeId();
    const action = pickTerminalAction(prevActiveId, nextId);
    switch (action) {
      case "noop":
        break;
      case "mount":
        // nextId is non-null by construction of pickTerminalAction.
        mount(nextId as string);
        break;
      case "remount":
        unmount();
        mount(nextId as string);
        break;
      case "unmount":
        unmount();
        break;
    }
    prevActiveId = nextId;
  });

  onCleanup(() => {
    handleRef?.dispose();
    handleRef = null;
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
