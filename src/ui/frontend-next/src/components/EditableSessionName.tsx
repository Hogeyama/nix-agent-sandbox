/**
 * Inline rename affordance for a session row.
 *
 * In `idle` the component is a "Rename" button; clicking enters
 * `editing` with the current name as the draft. The input commits with
 * Enter, cancels with Escape or blur, and stays disabled while a save
 * is in flight. Validation runs locally via `validateName` before the
 * `commit` action is dispatched, so a malformed draft never reaches
 * the network; the resulting message is surfaced inline next to the
 * input. Backend errors flow through the reducer's `failure` action so
 * the input rehydrates with the rejected draft and the error chip.
 */

import { createSignal, Show } from "solid-js";
import {
  initialRenameState,
  type RenameAction,
  type RenameState,
  reduceRenameState,
} from "./editableSessionNameLogic";
import { validateName } from "./sessionActionsLogic";

export interface EditableSessionNameProps {
  currentName: string;
  onSubmit: (next: string) => Promise<void>;
}

export function EditableSessionName(props: EditableSessionNameProps) {
  const [state, setState] = createSignal<RenameState>(initialRenameState);
  const [validationError, setValidationError] = createSignal<string | null>(
    null,
  );

  const dispatch = (action: RenameAction) => {
    setState((s) => reduceRenameState(s, action));
  };

  const startEdit = () => {
    setValidationError(null);
    dispatch({ type: "start", current: props.currentName });
  };

  const cancelEdit = () => {
    setValidationError(null);
    dispatch({ type: "cancel" });
  };

  const handleInput = (e: InputEvent & { currentTarget: HTMLInputElement }) => {
    if (validationError() !== null) setValidationError(null);
    dispatch({ type: "change", draft: e.currentTarget.value });
  };

  const handleKeyDown = async (e: KeyboardEvent) => {
    const s = state();
    if (s.mode !== "editing") return;
    if (e.key === "Enter") {
      e.preventDefault();
      const result = validateName(s.draft);
      if (!result.ok) {
        setValidationError(result.reason);
        return;
      }
      setValidationError(null);
      dispatch({ type: "commit" });
      try {
        await props.onSubmit(result.value);
        dispatch({ type: "success" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to rename";
        dispatch({ type: "failure", error: message });
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const handleBlur = (e: FocusEvent) => {
    // Cancel the edit when focus leaves the rename-edit scope; if focus
    // stays inside (e.g. on the input itself), the draft is preserved.
    const next = e.relatedTarget as HTMLElement | null;
    if (next !== null && next.closest(".rename-edit") !== null) return;
    if (state().mode === "editing") cancelEdit();
  };

  const focusOnMount = (el: HTMLInputElement | undefined) => {
    queueMicrotask(() => el?.focus());
  };

  const inlineError = () => {
    const s = state();
    const local = validationError();
    if (local !== null) return local;
    if (s.mode === "editing" && s.error !== undefined) return s.error;
    return null;
  };

  const draftValue = () => {
    const s = state();
    if (s.mode === "editing" || s.mode === "saving") return s.draft;
    return "";
  };

  const isSaving = () => state().mode === "saving";

  return (
    <Show
      when={state().mode !== "idle"}
      fallback={
        <button
          type="button"
          class="session-action-btn rename-trigger"
          onClick={startEdit}
          aria-label={`Rename session ${props.currentName}`}
        >
          Rename
        </button>
      }
    >
      <span class="rename-edit">
        <input
          type="text"
          class="rename-input"
          value={draftValue()}
          disabled={isSaving()}
          ref={focusOnMount}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          aria-label="Rename session"
        />
        <Show when={inlineError()}>
          {(msg) => (
            <span class="rename-error" role="status" aria-live="polite">
              {msg()}
            </span>
          )}
        </Show>
      </span>
    </Show>
  );
}
