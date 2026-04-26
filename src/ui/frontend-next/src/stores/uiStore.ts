/**
 * UI preferences store: pane widths and right-pane collapsed state.
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
 */

import { createSignal } from "solid-js";
import {
  clampWidth,
  MAX_PANE,
  MIN_LEFT,
  MIN_RIGHT,
} from "../components/paneResizerLogic";

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
  setLeftWidth(px: number): void;
  setRightWidth(px: number): void;
  toggleRightCollapsed(): void;
}

export const STORAGE_KEY_LEFT_WIDTH = "nas.ui.leftWidth";
export const STORAGE_KEY_RIGHT_WIDTH = "nas.ui.rightWidth";
export const STORAGE_KEY_RIGHT_COLLAPSED = "nas.ui.rightCollapsed";

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

  function readNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
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
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      warn(`uiStore: ${key} is not a finite number, falling back to default`);
      return fallback;
    }
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

  const [leftWidth, setLeftWidthSig] = createSignal(initialLeft);
  const [rightWidth, setRightWidthSig] = createSignal(initialRight);
  const [rightCollapsed, setRightCollapsedSig] = createSignal(initialCollapsed);

  return {
    leftWidth,
    rightWidth,
    rightCollapsed,
    setLeftWidth(px: number) {
      const clamped = clampWidth(px, MIN_LEFT, MAX_PANE);
      setLeftWidthSig(clamped);
      writeStorage(STORAGE_KEY_LEFT_WIDTH, clamped);
    },
    setRightWidth(px: number) {
      const clamped = clampWidth(px, MIN_RIGHT, MAX_PANE);
      setRightWidthSig(clamped);
      writeStorage(STORAGE_KEY_RIGHT_WIDTH, clamped);
    },
    toggleRightCollapsed() {
      const next = !rightCollapsed();
      setRightCollapsedSig(next);
      writeStorage(STORAGE_KEY_RIGHT_COLLAPSED, next);
    },
  };
}
