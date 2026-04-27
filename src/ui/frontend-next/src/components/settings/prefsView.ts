/**
 * Pure helpers and constants for the Preferences settings page.
 *
 * `clampFontSize` is split out from the component so the validation
 * contract can be unit-tested without a Solid runtime, and so the
 * `uiStore` can reuse it when it normalises a value read from
 * `localStorage`.
 *
 * Scope: these helpers govern the chrome font size around terminals
 * (header, sidebar, settings pages, dialogs). The per-terminal xterm
 * font size is owned by `TerminalToolbar` and stays independent of
 * this value.
 */

/**
 * Font sizes (in pixels) the preferences page exposes as a radio
 * group. The list is ordered from smallest to largest so the radio
 * group renders top-to-bottom in ascending order without sorting.
 */
export const FONT_SIZE_CHOICES: readonly number[] = [
  12, 13, 14, 15, 16,
] as const;

export const DEFAULT_FONT_SIZE_PX = 13;

const MIN_FONT_SIZE_PX = 12;
const MAX_FONT_SIZE_PX = 16;

/**
 * Coerce an arbitrary number into the supported font-size range.
 *
 *   - `NaN` and `±Infinity` collapse to `DEFAULT_FONT_SIZE_PX` so a
 *     corrupted `localStorage` entry never paints with a missing or
 *     unbounded size.
 *   - Values below `MIN_FONT_SIZE_PX` clamp up to the minimum and
 *     values above `MAX_FONT_SIZE_PX` clamp down to the maximum, so
 *     a user who edits storage by hand still lands on a renderable
 *     size on the next read.
 *
 * Note: this is the chrome font size (Settings shell, sidebar,
 * pending pane). The xterm font size is governed independently by
 * `TerminalToolbar`.
 */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE_PX;
  if (n < MIN_FONT_SIZE_PX) return MIN_FONT_SIZE_PX;
  if (n > MAX_FONT_SIZE_PX) return MAX_FONT_SIZE_PX;
  return n;
}
