/**
 * Tests for the static keybinds catalog.
 *
 * The catalog drives the settings page, so the tests pin every
 * visible field (id / display / label / group) and the structural
 * invariants the page relies on (id uniqueness, group coverage,
 * row ordering).
 */

import { describe, expect, test } from "bun:test";
import {
  SHORTCUT_GROUP_ORDER,
  SHORTCUTS,
  type ShortcutEntry,
  type ShortcutGroup,
  shortcutsByGroup,
} from "./keybindsCatalog";

describe("SHORTCUTS", () => {
  test("contains exactly the seven rows of docs/ui-redesign.md §8", () => {
    expect(SHORTCUTS.length).toBe(7);
  });

  test("preserves the docs/ui-redesign.md §8 row order", () => {
    expect(SHORTCUTS.map((s) => s.id)).toEqual([
      "session.new",
      "session.switch",
      "action.approve",
      "action.deny",
      "pane.toggleCollapse",
      "settings.open",
      "settings.shortcuts",
    ]);
  });

  test("entries pin display / label / group verbatim from §8", () => {
    const projection = SHORTCUTS.map((s) => ({
      id: s.id,
      display: s.display,
      label: s.label,
      group: s.group,
    }));
    expect(projection).toEqual([
      {
        id: "session.new",
        display: "Ctrl+N",
        label: "New Session",
        group: "session",
      },
      {
        id: "session.switch",
        display: "Ctrl+1..9",
        label: "セッション切替（左 pane の順）",
        group: "session",
      },
      {
        id: "action.approve",
        display: "Ctrl+Shift+A",
        label: "選択中 Pending を Approve (once)",
        group: "action",
      },
      {
        id: "action.deny",
        display: "Ctrl+Shift+D",
        label: "選択中 Pending を Deny",
        group: "action",
      },
      {
        id: "pane.toggleCollapse",
        display: "Ctrl+Shift+[ / ]",
        label: "左 / 右 pane 折りたたみ",
        group: "pane",
      },
      {
        id: "settings.open",
        display: "Ctrl+,",
        label: "Settings",
        group: "settings",
      },
      {
        id: "settings.shortcuts",
        display: "Ctrl+?",
        label: "ショートカット一覧",
        group: "settings",
      },
    ]);
  });

  test("ids are unique", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("range and pair entries carry spec=null; single-key entries carry a spec", () => {
    const specByid = new Map<string, ShortcutEntry["spec"]>(
      SHORTCUTS.map((s) => [s.id, s.spec]),
    );
    expect(specByid.get("session.switch")).toBeNull();
    expect(specByid.get("pane.toggleCollapse")).toBeNull();
    for (const id of [
      "session.new",
      "action.approve",
      "action.deny",
      "settings.open",
      "settings.shortcuts",
    ]) {
      expect(specByid.get(id)).not.toBeNull();
    }
  });
});

describe("shortcutsByGroup", () => {
  test("returns every ShortcutGroup key, including empty groups", () => {
    const grouped = shortcutsByGroup();
    const expectedKeys: ShortcutGroup[] = [
      "session",
      "pane",
      "action",
      "settings",
    ];
    expect(Object.keys(grouped).sort()).toEqual([...expectedKeys].sort());
  });

  test("preserves every entry exactly once across all groups", () => {
    const grouped = shortcutsByGroup();
    const flattened = SHORTCUT_GROUP_ORDER.flatMap((g) => grouped[g]);
    expect(flattened.length).toBe(SHORTCUTS.length);
    expect(new Set(flattened.map((e) => e.id))).toEqual(
      new Set(SHORTCUTS.map((e) => e.id)),
    );
  });

  test("classifies entries into the four groups exactly as catalog declares", () => {
    const grouped = shortcutsByGroup();
    expect(grouped.session.map((e) => e.id)).toEqual([
      "session.new",
      "session.switch",
    ]);
    expect(grouped.pane.map((e) => e.id)).toEqual(["pane.toggleCollapse"]);
    expect(grouped.action.map((e) => e.id)).toEqual([
      "action.approve",
      "action.deny",
    ]);
    expect(grouped.settings.map((e) => e.id)).toEqual([
      "settings.open",
      "settings.shortcuts",
    ]);
  });
});

describe("SHORTCUT_GROUP_ORDER", () => {
  test("lists every ShortcutGroup once in the documented display order", () => {
    expect(SHORTCUT_GROUP_ORDER).toEqual([
      "session",
      "action",
      "pane",
      "settings",
    ]);
    expect(new Set(SHORTCUT_GROUP_ORDER).size).toBe(
      SHORTCUT_GROUP_ORDER.length,
    );
  });
});
