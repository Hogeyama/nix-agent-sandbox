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

export interface ValidateNameOk {
  ok: true;
  value: string;
}
export interface ValidateNameErr {
  ok: false;
  reason: string;
}
export type ValidateNameResult = ValidateNameOk | ValidateNameErr;

/**
 * Maximum number of characters accepted in a session name. Matches the
 * backend cap so the UI never submits a value the server will refuse.
 */
export const NAME_MAX_LENGTH = 200;

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

/**
 * Validates and normalizes a session name input.
 *
 * Strips ASCII control characters (U+0000-U+001F and U+007F), trims
 * surrounding whitespace, and rejects results that are empty after
 * normalization or exceed `NAME_MAX_LENGTH`. Non-string inputs return
 * a structured error rather than throwing so callers can branch on the
 * `ok` discriminant uniformly.
 *
 * The UI-side gate mirrors the backend sanitization rules in
 * `src/ui/routes/api.ts` (`/api/sessions/:id/name` strips ASCII control
 * characters, trims, and rejects empty / over-cap inputs). The backend
 * remains authoritative and re-applies its own sanitization on every PATCH.
 */
export function validateName(raw: string): ValidateNameResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "Name must be a string" };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ASCII control characters is the explicit purpose of this regex; the backend applies the same sanitization in src/ui/routes/api.ts.
  const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, "");
  const trimmed = stripped.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Name cannot be empty" };
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: `Name exceeds ${NAME_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, value: trimmed };
}
