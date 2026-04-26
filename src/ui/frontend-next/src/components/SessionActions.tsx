/**
 * Inline row actions for a session: Stop, Rename, and Shell.
 *
 * The component mounts inside the `.session-actions` slot of each
 * SessionsPane row. The parent row's click handler ignores events that
 * originate from this slot (closest-check guard), so individual buttons
 * own their own click handling without `stopPropagation`.
 *
 * Stop carries two distinct signals so the row reflects the right state
 * at every step:
 *   - `stopInFlight` is true while the POST is awaiting a response and
 *     debounces double-clicks.
 *   - `stopOptimisticBusy` is true once the POST resolves and stays
 *     true until the SSE snapshot drops the row, which unmounts this
 *     component and discards the signal naturally.
 *
 * Errors surface in an `aria-live="polite"` chip that auto-clears after
 * `ERROR_TIMEOUT_MS`. The timer reset invariant follows the Toolbar
 * pattern: `errorTimer !== null` iff a live timer is pending; the
 * callback nulls the field when it fires.
 *
 * Shell is wired as a callback delegation only; the toggle behaviour is
 * implemented elsewhere.
 */

import { createSignal, onCleanup, Show } from "solid-js";
import type { SessionRow } from "../stores/types";
import { EditableSessionName } from "./EditableSessionName";

export interface SessionActionsProps {
  row: SessionRow;
  onStop: (containerName: string) => Promise<void>;
  onRename: (sessionId: string, name: string) => Promise<void>;
  onShellToggle: (row: SessionRow) => void;
}

const ERROR_TIMEOUT_MS = 5000;

export function SessionActions(props: SessionActionsProps) {
  const [stopInFlight, setStopInFlight] = createSignal(false);
  const [stopOptimisticBusy, setStopOptimisticBusy] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  const surfaceError = (msg: string) => {
    setErrorMessage(msg);
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      setErrorMessage(null);
      errorTimer = null;
    }, ERROR_TIMEOUT_MS);
  };
  onCleanup(() => {
    if (errorTimer !== null) clearTimeout(errorTimer);
  });

  const stopDisabled = () => stopInFlight() || stopOptimisticBusy();

  const handleStop = async () => {
    if (stopDisabled()) return;
    setStopInFlight(true);
    try {
      await props.onStop(props.row.containerName);
      setStopOptimisticBusy(true);
    } catch (e) {
      surfaceError(e instanceof Error ? e.message : "Failed to stop");
    } finally {
      setStopInFlight(false);
    }
  };

  const handleRename = (next: string) => props.onRename(props.row.id, next);

  return (
    <div class="session-actions-content">
      <button
        type="button"
        class="session-action-btn shell-trigger"
        onClick={() => props.onShellToggle(props.row)}
        aria-label="Open shell"
      >
        Shell
      </button>
      <EditableSessionName
        currentName={props.row.name}
        onSubmit={handleRename}
      />
      <button
        type="button"
        class="session-action-btn stop-trigger"
        disabled={stopDisabled()}
        onClick={handleStop}
        aria-label="Stop container"
      >
        {stopOptimisticBusy() ? "Stopping…" : "Stop"}
      </button>
      <Show when={errorMessage()}>
        {(msg) => (
          <span class="session-stop-chip" role="status" aria-live="polite">
            {msg()}
          </span>
        )}
      </Show>
    </div>
  );
}
