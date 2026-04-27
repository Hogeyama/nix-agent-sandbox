/**
 * Keyboard shortcuts settings page.
 *
 * Renders the static catalog from `keybindsCatalog` as one table per
 * group, in the order declared by `SHORTCUT_GROUP_ORDER`. The page is
 * presentation-only: it does not subscribe to any store, so the
 * settings shell can mount it without wiring data.
 */

import { For, Show } from "solid-js";
import {
  SHORTCUT_GROUP_ORDER,
  type ShortcutGroup,
  shortcutsByGroup,
} from "./keybindsCatalog";

const GROUP_HEADINGS: Record<ShortcutGroup, string> = {
  session: "Sessions",
  pane: "Panes",
  action: "Approvals",
  settings: "Settings",
};

export function KeybindsPage() {
  const grouped = shortcutsByGroup();
  return (
    <div class="keybinds-page">
      <h1 class="settings-page-heading">Keybinds</h1>
      <p class="settings-page-note">
        Keyboard shortcuts the control room responds to.
      </p>
      <For each={SHORTCUT_GROUP_ORDER}>
        {(group) => (
          <Show when={grouped[group].length > 0}>
            <section class="keybinds-group" aria-label={GROUP_HEADINGS[group]}>
              <h2 class="keybinds-group-heading">{GROUP_HEADINGS[group]}</h2>
              <table class="keybinds-table">
                <thead>
                  <tr>
                    <th scope="col" class="keybinds-key-col">
                      Key
                    </th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={grouped[group]}>
                    {(entry) => (
                      <tr class="keybinds-row">
                        <td class="keybinds-key-col">
                          <kbd class="keybinds-key">{entry.display}</kbd>
                        </td>
                        <td class="keybinds-label">{entry.label}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>
          </Show>
        )}
      </For>
    </div>
  );
}
