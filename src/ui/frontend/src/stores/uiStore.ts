/**
 * UI preferences store: pane widths, right-pane collapsed state, and
 * chrome font size.
 *
 * Values are persisted per-key in `localStorage` under the `nas.ui.*`
 * namespace and re-hydrated on construction. Each key is parsed in its
 * own try/catch so a corrupt entry only loses that one preference; the
 * fallback path always surfaces via `console.warn` (or an injected
 * sink) so a silent failure never hides a corrupted value from the
 * developer.
 *
 * Reactivity is provided by Solid `createSignal`; the store is intended
 * to be constructed once near the application root and shared via
 * accessor functions.
 *
 * The font-size signal here drives the chrome (header, sidebar,
 * settings pages, dialogs) via the `--app-font-size` CSS variable. The
 * xterm font size is a separate value owned by `TerminalToolbar` and
 * stored under its own key, so adjusting one does not affect the
 * other.
 */

import { createSignal } from "solid-js";
import {
  clampWidth,
  MAX_PANE,
  MIN_LEFT,
  MIN_RIGHT,
} from "../components/paneResizerLogic";
import {
  clampFontSize,
  DEFAULT_FONT_SIZE_PX,
} from "../components/settings/prefsView";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface UiStoreOptions {
  storage?: StorageLike;
  warn?: (message: string, error?: unknown) => void;
}

export interface UiStore {
  leftWidth: () => number;
  rightWidth: () => number;
  rightCollapsed: () => boolean;
  fontSizePx: () => number;
  setLeftWidth(px: number): void;
  setRightWidth(px: number): void;
  toggleRightCollapsed(): void;
  setFontSizePx(px: number): void;
  /**
   * Restore left / right pane widths and the right-pane collapsed flag
   * to their built-in defaults. Each underlying setter writes through
   * to `localStorage` so the reset survives a reload without an extra
   * call site.
   */
  resetPaneWidths(): void;
}

export const STORAGE_KEY_LEFT_WIDTH = "nas.ui.leftWidth";
export const STORAGE_KEY_RIGHT_WIDTH = "nas.ui.rightWidth";
export const STORAGE_KEY_RIGHT_COLLAPSED = "nas.ui.rightCollapsed";
export const STORAGE_KEY_FONT_SIZE = "nas.ui.fontSize";

export const DEFAULT_LEFT_WIDTH = 288;
export const DEFAULT_RIGHT_WIDTH = 340;
export const DEFAULT_RIGHT_COLLAPSED = false;

function resolveStorage(opts: UiStoreOptions): StorageLike | null {
  if (opts.storage !== undefined) return opts.storage;
  const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
  return ls ?? null;
}

export function createUiStore(opts: UiStoreOptions = {}): UiStore {
  const storage = resolveStorage(opts);
  const warn =
    opts.warn ??
    ((msg: string, e?: unknown) => {
      // Surface storage / parse failures so a silent fallback never hides
      // a corrupted preference.
      if (e === undefined) console.warn(msg);
      else console.warn(msg, e);
    });

  /**
   * Parse a finite number from `localStorage`. Returns `null` on any
   * failure (missing entry, IO error, malformed JSON, non-finite
   * value); the failure modes that warrant developer attention are
   * surfaced through `warn` before returning. The caller picks its
   * own default and clamping policy from the returned value.
   */
  function readNumberRaw(key: string): number | null {
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch (e) {
      warn(`uiStore: failed to read ${key} from storage`, e);
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      warn(`uiStore: failed to parse ${key} from storage`, e);
      return null;
    }
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      warn(`uiStore: ${key} is not a finite number, falling back to default`);
      return null;
    }
    return parsed;
  }

  function readNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = readNumberRaw(key);
    if (parsed === null) return fallback;
    return clampWidth(parsed, min, max);
  }

  function readBoolean(key: string, fallback: boolean): boolean {
    if (!storage) return fallback;
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch (e) {
      warn(`uiStore: failed to read ${key} from storage`, e);
      return fallback;
    }
    if (raw === null) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      warn(`uiStore: failed to parse ${key} from storage`, e);
      return fallback;
    }
    if (typeof parsed !== "boolean") {
      warn(`uiStore: ${key} is not a boolean, falling back to default`);
      return fallback;
    }
    return parsed;
  }

  function writeStorage(key: string, value: unknown): void {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      warn(`uiStore: failed to write ${key} to storage`, e);
    }
  }

  const initialLeft = readNumber(
    STORAGE_KEY_LEFT_WIDTH,
    DEFAULT_LEFT_WIDTH,
    MIN_LEFT,
    MAX_PANE,
  );
  const initialRight = readNumber(
    STORAGE_KEY_RIGHT_WIDTH,
    DEFAULT_RIGHT_WIDTH,
    MIN_RIGHT,
    MAX_PANE,
  );
  const initialCollapsed = readBoolean(
    STORAGE_KEY_RIGHT_COLLAPSED,
    DEFAULT_RIGHT_COLLAPSED,
  );

  function readFontSize(): number {
    const raw = readNumberRaw(STORAGE_KEY_FONT_SIZE);
    if (raw === null) return DEFAULT_FONT_SIZE_PX;
    return clampFontSize(raw);
  }

  const [leftWidth, setLeftWidthSig] = createSignal(initialLeft);
  const [rightWidth, setRightWidthSig] = createSignal(initialRight);
  const [rightCollapsed, setRightCollapsedSig] = createSignal(initialCollapsed);
  const [fontSizePx, setFontSizePxSig] = createSignal(readFontSize());

  function setLeftWidth(px: number): void {
    const clamped = clampWidth(px, MIN_LEFT, MAX_PANE);
    setLeftWidthSig(clamped);
    writeStorage(STORAGE_KEY_LEFT_WIDTH, clamped);
  }

  function setRightWidth(px: number): void {
    const clamped = clampWidth(px, MIN_RIGHT, MAX_PANE);
    setRightWidthSig(clamped);
    writeStorage(STORAGE_KEY_RIGHT_WIDTH, clamped);
  }

  function setRightCollapsed(value: boolean): void {
    setRightCollapsedSig(value);
    writeStorage(STORAGE_KEY_RIGHT_COLLAPSED, value);
  }

  function setFontSizePx(px: number): void {
    const clamped = clampFontSize(px);
    setFontSizePxSig(clamped);
    writeStorage(STORAGE_KEY_FONT_SIZE, clamped);
  }

  return {
    leftWidth,
    rightWidth,
    rightCollapsed,
    fontSizePx,
    setLeftWidth,
    setRightWidth,
    toggleRightCollapsed() {
      setRightCollapsed(!rightCollapsed());
    },
    setFontSizePx,
    resetPaneWidths() {
      // Route through the local setters so each value writes through to
      // storage and shares the same clamping that interactive changes use.
      setLeftWidth(DEFAULT_LEFT_WIDTH);
      setRightWidth(DEFAULT_RIGHT_WIDTH);
      setRightCollapsed(DEFAULT_RIGHT_COLLAPSED);
    },
  };
}
