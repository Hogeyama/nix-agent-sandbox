import { describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createUiStore,
  DEFAULT_LEFT_WIDTH,
  DEFAULT_RIGHT_WIDTH,
  STORAGE_KEY_FONT_SIZE,
  STORAGE_KEY_LEFT_WIDTH,
  STORAGE_KEY_RIGHT_COLLAPSED,
  STORAGE_KEY_RIGHT_WIDTH,
  type StorageLike,
} from "./uiStore";

interface FakeStorage extends StorageLike {
  items: Record<string, string>;
}

function createFakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const items: Record<string, string> = { ...initial };
  return {
    items,
    getItem(key) {
      return Object.hasOwn(items, key) ? items[key]! : null;
    },
    setItem(key, value) {
      items[key] = value;
    },
  };
}

function createThrowingSetStorage(): StorageLike {
  return {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("quota exceeded");
    },
  };
}

describe("createUiStore", () => {
  test("defaults to 288 / 340 / false when storage is empty", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage();
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.leftWidth()).toBe(288);
      expect(store.rightWidth()).toBe(340);
      expect(store.rightCollapsed()).toBe(false);
      dispose();
    });
  });

  test("loads valid widths and collapsed flag from storage", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage({
        [STORAGE_KEY_LEFT_WIDTH]: "300",
        [STORAGE_KEY_RIGHT_WIDTH]: "400",
        [STORAGE_KEY_RIGHT_COLLAPSED]: "true",
      });
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.leftWidth()).toBe(300);
      expect(store.rightWidth()).toBe(400);
      expect(store.rightCollapsed()).toBe(true);
      dispose();
    });
  });

  test("falls back to default and warns when leftWidth is malformed JSON", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage({
        [STORAGE_KEY_LEFT_WIDTH]: "abc",
      });
      const warn = mock((_msg: string, _e?: unknown) => undefined);
      const store = createUiStore({ storage, warn });
      expect(store.leftWidth()).toBe(288);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(STORAGE_KEY_LEFT_WIDTH);
      dispose();
    });
  });

  test("falls back to default and warns when rightWidth is non-finite", () => {
    createRoot((dispose) => {
      // `JSON.stringify(Infinity)` yields `"null"`, which parses fine but
      // is not a number; cover the non-number branch with that exact
      // payload alongside an explicit non-finite-as-string fallback.
      const storage = createFakeStorage({
        [STORAGE_KEY_RIGHT_WIDTH]: "null",
      });
      const warn = mock((_msg: string, _e?: unknown) => undefined);
      const store = createUiStore({ storage, warn });
      expect(store.rightWidth()).toBe(340);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(STORAGE_KEY_RIGHT_WIDTH);
      dispose();
    });
  });

  test("falls back to default and warns when rightCollapsed is non-boolean", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage({
        [STORAGE_KEY_RIGHT_COLLAPSED]: "42",
      });
      const warn = mock((_msg: string, _e?: unknown) => undefined);
      const store = createUiStore({ storage, warn });
      expect(store.rightCollapsed()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(STORAGE_KEY_RIGHT_COLLAPSED);
      dispose();
    });
  });

  test("clamps loaded leftWidth below MIN up to MIN_LEFT (200)", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage({
        [STORAGE_KEY_LEFT_WIDTH]: "100",
      });
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.leftWidth()).toBe(200);
      dispose();
    });
  });

  test("setLeftWidth persists clamped width to storage", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage();
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      store.setLeftWidth(350);
      expect(store.leftWidth()).toBe(350);
      expect(storage.items[STORAGE_KEY_LEFT_WIDTH]).toBe("350");
      dispose();
    });
  });

  test("setLeftWidth warns and ignores when storage.setItem throws", () => {
    createRoot((dispose) => {
      const storage = createThrowingSetStorage();
      const warn = mock((_msg: string, _e?: unknown) => undefined);
      const store = createUiStore({ storage, warn });
      // Initial defaults loaded, no warn yet (getItem returns null).
      expect(warn).not.toHaveBeenCalled();
      store.setLeftWidth(350);
      // Signal still updates so the UI reflects the drag immediately.
      expect(store.leftWidth()).toBe(350);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(STORAGE_KEY_LEFT_WIDTH);
      dispose();
    });
  });

  test("toggleRightCollapsed persists boolean across round-trips", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage();
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.rightCollapsed()).toBe(false);
      store.toggleRightCollapsed();
      expect(store.rightCollapsed()).toBe(true);
      expect(storage.items[STORAGE_KEY_RIGHT_COLLAPSED]).toBe("true");
      store.toggleRightCollapsed();
      expect(store.rightCollapsed()).toBe(false);
      expect(storage.items[STORAGE_KEY_RIGHT_COLLAPSED]).toBe("false");
      dispose();
    });
  });

  test("fontSizePx defaults to 13 when storage is empty", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage();
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.fontSizePx()).toBe(13);
      dispose();
    });
  });

  test("setFontSizePx persists clamped value to storage", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage();
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      store.setFontSizePx(15);
      expect(store.fontSizePx()).toBe(15);
      expect(storage.items[STORAGE_KEY_FONT_SIZE]).toBe("15");
      dispose();
    });
  });

  test("setFontSizePx clamps below-minimum input up to 12", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage();
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      store.setFontSizePx(8);
      expect(store.fontSizePx()).toBe(12);
      expect(storage.items[STORAGE_KEY_FONT_SIZE]).toBe("12");
      dispose();
    });
  });

  test("setFontSizePx clamps above-maximum input down to 16", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage();
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      store.setFontSizePx(99);
      expect(store.fontSizePx()).toBe(16);
      expect(storage.items[STORAGE_KEY_FONT_SIZE]).toBe("16");
      dispose();
    });
  });

  test("fontSizePx loads stored boundary values on construction", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage({
        [STORAGE_KEY_FONT_SIZE]: "12",
      });
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.fontSizePx()).toBe(12);
      dispose();
    });
  });

  test("fontSizePx clamps an out-of-range stored value on read", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage({
        [STORAGE_KEY_FONT_SIZE]: "20",
      });
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.fontSizePx()).toBe(16);
      dispose();
    });
  });

  test("setFontSizePx warns and ignores when storage.setItem throws", () => {
    createRoot((dispose) => {
      const storage = createThrowingSetStorage();
      const warn = mock((_msg: string, _e?: unknown) => undefined);
      const store = createUiStore({ storage, warn });
      expect(warn).not.toHaveBeenCalled();
      store.setFontSizePx(15);
      // Signal still updates so the UI reflects the change immediately.
      expect(store.fontSizePx()).toBe(15);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(STORAGE_KEY_FONT_SIZE);
      dispose();
    });
  });

  test("resetPaneWidths restores defaults and persists them", () => {
    createRoot((dispose) => {
      const storage = createFakeStorage({
        [STORAGE_KEY_LEFT_WIDTH]: "320",
        [STORAGE_KEY_RIGHT_WIDTH]: "420",
        [STORAGE_KEY_RIGHT_COLLAPSED]: "true",
      });
      const store = createUiStore({ storage, warn: mock(() => undefined) });
      expect(store.leftWidth()).toBe(320);
      expect(store.rightWidth()).toBe(420);
      expect(store.rightCollapsed()).toBe(true);

      store.resetPaneWidths();

      expect(store.leftWidth()).toBe(DEFAULT_LEFT_WIDTH);
      expect(store.rightWidth()).toBe(DEFAULT_RIGHT_WIDTH);
      expect(store.rightCollapsed()).toBe(false);
      expect(storage.items[STORAGE_KEY_LEFT_WIDTH]).toBe(
        String(DEFAULT_LEFT_WIDTH),
      );
      expect(storage.items[STORAGE_KEY_RIGHT_WIDTH]).toBe(
        String(DEFAULT_RIGHT_WIDTH),
      );
      expect(storage.items[STORAGE_KEY_RIGHT_COLLAPSED]).toBe("false");
      dispose();
    });
  });
});
