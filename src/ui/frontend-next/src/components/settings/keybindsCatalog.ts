/**
 * Static catalog of keyboard shortcuts the control room exposes.
 *
 * The catalog drives the `#/settings/keybinds` page. It is data-only:
 * each entry pairs a stable identifier and a human-readable display
 * string with an optional `ShortcutSpec`.
 *
 * Display strings written into this file are taken verbatim from
 * `docs/ui-redesign.md` §8 so the rendered table mirrors the design
 * doc one-to-one.
 *
 * Every spec carried by this catalog is a §8 shortcut that must keep
 * working while the xterm textarea (or any other text input) holds
 * focus. Each spec therefore opts in via `allowInTextField: true` so
 * `matchShortcut()` does not bail out on INPUT / TEXTAREA /
 * contenteditable targets.
 *
 * The `pane.toggleCollapse` row carries `spec: null` because a single
 * `ShortcutSpec` cannot describe the `Ctrl+Shift+[ / ]` pair. The
 * dispatcher routes those keys via a hard-coded path that lives in
 * the keyboard hook, not in this catalog.
 */

import type { ShortcutSpec } from "../../hooks/matchShortcut";

export type ShortcutGroup = "session" | "pane" | "action" | "settings";

export interface ShortcutEntry {
  /**
   * Stable unique key for catalog rows. Tests pin it; the rendered
   * table uses it as the row key.
   */
  id: string;
  /**
   * Display string used as the row's label in the settings table.
   * Pre-formatted so range entries (`Ctrl+1..9`) and pair entries
   * (`Ctrl+Shift+[` / `]`) read naturally without extra logic.
   */
  display: string;
  /**
   * Concrete shortcut spec for entries that map to a single
   * keystroke. A single `ShortcutSpec` cannot encode key ranges
   * (e.g. `Ctrl+1..9`) or key pairs (e.g. `Ctrl+Shift+[ / ]`); those
   * rows carry `null` and are rendered from `display` alone.
   */
  spec: ShortcutSpec | null;
  /** Human-readable description of the action. */
  label: string;
  /** Group the entry belongs to in the settings table. */
  group: ShortcutGroup;
  /**
   * Optional supplementary note rendered under the row label on the
   * settings page. Used to surface caveats that the display string
   * alone cannot convey (e.g. an asymmetric pair where only one half
   * is wired up).
   */
  note?: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: "session.new",
    display: "Ctrl+N",
    spec: { ctrl: true, key: "n", allowInTextField: true },
    label: "New Session",
    group: "session",
  },
  {
    id: "session.switch",
    display: "Ctrl+1..9",
    spec: null,
    label: "セッション切替（左 pane の順）",
    group: "session",
  },
  {
    id: "action.approve",
    display: "Ctrl+Shift+A",
    spec: { ctrl: true, shift: true, key: "A", allowInTextField: true },
    label: "選択中 Pending を Approve (once)",
    group: "action",
  },
  {
    id: "action.deny",
    display: "Ctrl+Shift+D",
    spec: { ctrl: true, shift: true, key: "D", allowInTextField: true },
    label: "選択中 Pending を Deny",
    group: "action",
  },
  {
    id: "pane.toggleCollapse",
    display: "Ctrl+Shift+[ / ]",
    spec: null,
    label: "左 / 右 pane 折りたたみ",
    group: "pane",
    note: "左 pane は折りたたみ非対応のため Ctrl+Shift+] のみ反応する",
  },
  {
    id: "settings.open",
    display: "Ctrl+,",
    spec: { ctrl: true, key: ",", allowInTextField: true },
    label: "Settings",
    group: "settings",
  },
  {
    id: "settings.shortcuts",
    display: "Ctrl+?",
    spec: { ctrl: true, key: "?", allowInTextField: true },
    label: "ショートカット一覧",
    group: "settings",
  },
] as const;

/** Display order for `shortcutsByGroup` and the rendered table. */
export const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = [
  "session",
  "action",
  "pane",
  "settings",
] as const;

/**
 * Group `SHORTCUTS` by `group`. The returned record contains every
 * `ShortcutGroup` key, even if the group has no entries, so callers
 * can iterate `SHORTCUT_GROUP_ORDER` without nullish checks.
 */
export function shortcutsByGroup(): Record<ShortcutGroup, ShortcutEntry[]> {
  const out: Record<ShortcutGroup, ShortcutEntry[]> = {
    session: [],
    pane: [],
    action: [],
    settings: [],
  };
  for (const entry of SHORTCUTS) {
    out[entry.group].push(entry);
  }
  return out;
}
