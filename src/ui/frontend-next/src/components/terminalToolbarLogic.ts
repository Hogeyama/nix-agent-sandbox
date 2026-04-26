/**
 * Pure-function helpers backing `TerminalToolbar`.
 *
 * The toolbar exposes four affordances (Ack turn, Search, font-size,
 * Kill clients) and the rendering rules for each are factored out of
 * the Solid component so they stay trivially testable. None of the
 * functions here read DOM or signals.
 */

import { HttpError } from "../api/client";

/**
 * Visibility / disabled / label for the Ack-turn button. The button is
 * only rendered when the active session is in `user-turn`; while an Ack
 * request is in flight the visible button is disabled to prevent the
 * user from issuing a duplicate request before SSE catches up.
 */
export interface AckButtonState {
  visible: boolean;
  disabled: boolean;
  label: string;
}

export function describeAckButton(
  turn: string | null | undefined,
  inFlight: boolean,
): AckButtonState {
  if (turn !== "user-turn") {
    return { visible: false, disabled: true, label: "Ack turn" };
  }
  return { visible: true, disabled: inFlight, label: "Ack turn" };
}

/**
 * Font-size bounds used by the toolbar's `+` / `−` controls. The
 * default is the same as `attachTerminalSession.DEFAULT_FONT_SIZE`;
 * the duplication is intentional — the toolbar must remain operable
 * even when the active terminal handle has not yet attached.
 */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 14;
export const FONT_SIZE_STEP = 1;

/**
 * Clamp a requested pixel size into [`FONT_SIZE_MIN`, `FONT_SIZE_MAX`]
 * and round to an integer. Non-finite inputs (NaN / Infinity) collapse
 * to the default so a single bad call cannot brick the control.
 */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return FONT_SIZE_DEFAULT;
  if (px < FONT_SIZE_MIN) return FONT_SIZE_MIN;
  if (px > FONT_SIZE_MAX) return FONT_SIZE_MAX;
  return Math.round(px);
}

/**
 * Decides which terminal search operation to invoke when the search input
 * is submitted. Empty (or whitespace-only) queries clear the addon's
 * decorations; otherwise the shift modifier picks between next and prev.
 */
export type SearchAction = "next" | "prev" | "clear";

export function decideSearchSubmit(
  query: string,
  shift: boolean,
): SearchAction {
  if (query.trim().length === 0) return "clear";
  return shift ? "prev" : "next";
}

/**
 * Returns true when the error from a turn-acknowledgement request should be
 * shown to the user. A 409 means a stale UI snapshot raced the ack; the SSE
 * stream will reconcile and the user does not need a notification.
 */
export function shouldSurfaceAckError(error: unknown): boolean {
  if (error instanceof HttpError && error.status === 409) return false;
  return true;
}
