/**
 * Reducer for the inline rename affordance on a session row.
 *
 * The state machine deliberately separates `editing` and `saving` so the
 * UI can disable the input while a PATCH is in flight without losing the
 * draft. Validation errors stay UI-local (handled by `validateName` at the
 * call site); the `failure` action is reserved for backend errors that
 * surface only after the request was actually attempted.
 *
 * Invariants
 *   - `change` is ignored when the machine is not in `editing` so a stale
 *     keypress racing a `success` cannot resurrect a dead draft.
 *   - `commit`, `success`, and `failure` are no-ops in incompatible modes
 *     to keep callers from having to track the current mode themselves.
 *   - `cancel` always resets to `idle`; this is the cleanest exit even
 *     when a save is in flight, but call sites are expected to ignore
 *     `cancel` while saving rather than relying on the reducer.
 */

export type RenameState =
  | { mode: "idle" }
  | { mode: "editing"; draft: string; error?: string }
  | { mode: "saving"; draft: string };

export type RenameAction =
  | { type: "start"; current: string }
  | { type: "change"; draft: string }
  | { type: "commit" }
  | { type: "cancel" }
  | { type: "success" }
  | { type: "failure"; error: string };

export const initialRenameState: RenameState = { mode: "idle" };

export function reduceRenameState(
  state: RenameState,
  action: RenameAction,
): RenameState {
  switch (action.type) {
    case "start":
      return { mode: "editing", draft: action.current };
    case "change":
      if (state.mode !== "editing") return state;
      return { mode: "editing", draft: action.draft };
    case "commit":
      if (state.mode !== "editing") return state;
      return { mode: "saving", draft: state.draft };
    case "cancel":
      return { mode: "idle" };
    case "success":
      if (state.mode !== "saving") return state;
      return { mode: "idle" };
    case "failure":
      if (state.mode !== "saving") return state;
      return { mode: "editing", draft: state.draft, error: action.error };
  }
}
