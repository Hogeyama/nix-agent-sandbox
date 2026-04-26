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
 * Shell is a toggle: clicking it switches the center pane between the
 * agent terminal and the spawned shell. The label and disabled state
 * are derived from `describeShellToggle` so the button surfaces the
 * destination view ("Open shell" while viewing the agent, "Return to
 * agent" while viewing the shell, "Spawning…" while a spawn request is
 * in flight).
 */

import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { describeShellToggle, type ShellView } from "../stores/shellMapping";
import type { SessionRow } from "../stores/types";
import { EditableSessionName } from "./EditableSessionName";

export interface SessionActionsProps {
  row: SessionRow;
  view: () => ShellView | undefined;
  shellInFlight: () => boolean;
  onStop: (containerName: string) => Promise<void>;
  onRename: (sessionId: string, name: string) => Promise<void>;
  onShellToggle: (row: SessionRow) => void | Promise<void>;
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

  const shellToggle = createMemo(() =>
    describeShellToggle(props.view() ?? "agent", props.shellInFlight()),
  );

  const handleShellToggleClick = async () => {
    if (shellToggle().disabled) return;
    try {
      await props.onShellToggle(props.row);
    } catch (e) {
      surfaceError(e instanceof Error ? e.message : "Failed to toggle shell");
    }
  };

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
        disabled={shellToggle().disabled}
        onClick={handleShellToggleClick}
        aria-label={`${shellToggle().label} for ${props.row.name}`}
      >
        {shellToggle().label}
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
