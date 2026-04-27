/**
 * Pure helpers and constants shared by `PaneResizer` and `uiStore`.
 *
 * `clampWidth` is intentionally defensive against `NaN`, `Infinity`,
 * `-Infinity`, and non-number inputs that may arrive from a corrupted
 * `localStorage` value. Anything that fails the `Number.isFinite` test
 * collapses to the lower bound so the layout never receives a garbage
 * grid template column.
 */

export const MIN_LEFT = 200;
export const MIN_RIGHT = 240;
export const MAX_PANE = 600;

export function clampWidth(px: number, min: number, max: number): number {
  if (!Number.isFinite(px)) return min;
  if (px < min) return min;
  if (px > max) return max;
  return px;
}
