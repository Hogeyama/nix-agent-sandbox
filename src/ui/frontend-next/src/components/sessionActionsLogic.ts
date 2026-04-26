/**
 * Pure helpers for the inline session-row actions (Stop / Rename / Shell).
 *
 * `validateName` is the UI-side gate that mirrors the backend sanitization
 * rules in `src/ui/routes/api.ts` (`/api/sessions/:id/name` strips ASCII
 * control characters, trims, and rejects empty / over-cap inputs). The
 * gate exists for instant feedback; the backend is still authoritative
 * and re-applies its own sanitization on every PATCH.
 */

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

/**
 * Validates and normalizes a session name input.
 *
 * Strips ASCII control characters (U+0000-U+001F and U+007F), trims
 * surrounding whitespace, and rejects results that are empty after
 * normalization or exceed `NAME_MAX_LENGTH`. Non-string inputs return
 * a structured error rather than throwing so callers can branch on the
 * `ok` discriminant uniformly.
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
