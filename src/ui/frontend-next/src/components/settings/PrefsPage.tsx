/**
 * Preferences settings page.
 *
 * The page exposes two preferences: chrome font size and pane layout.
 *
 * The font-size group drives `--app-font-size`, which scales the
 * chrome (header, sidebar, settings pages, dialogs). The xterm font
 * size is governed independently by `TerminalToolbar`, so adjusting
 * the radio here does not change terminal text.
 *
 * The pane-sizes section reflects the live signal values and exposes a
 * single "Reset to defaults" button. There is no save button: each
 * change writes through `uiStore`'s setters, which persist immediately
 * to `localStorage`.
 */

import { For } from "solid-js";
import type { UiStore } from "../../stores/uiStore";
import { FONT_SIZE_CHOICES } from "./prefsView";

export interface PrefsPageProps {
  ui: UiStore;
}

export function PrefsPage(props: PrefsPageProps) {
  const handleFontSizeChange = (size: number) => {
    props.ui.setFontSizePx(size);
  };

  return (
    <div class="prefs-page">
      <h1 class="settings-page-heading">Preferences</h1>
      <p class="settings-page-note">Preferences for the control room.</p>

      <form class="prefs-form" onSubmit={(e) => e.preventDefault()}>
        <fieldset class="prefs-section">
          <legend class="prefs-section-legend">Font size</legend>
          <div class="prefs-radio-group" role="radiogroup">
            <For each={FONT_SIZE_CHOICES}>
              {(size) => (
                <label class="prefs-radio">
                  <input
                    type="radio"
                    name="prefs-font-size"
                    value={size}
                    checked={props.ui.fontSizePx() === size}
                    onChange={() => handleFontSizeChange(size)}
                  />
                  <span>{size}px</span>
                </label>
              )}
            </For>
          </div>
        </fieldset>

        <fieldset class="prefs-section">
          <legend class="prefs-section-legend">Pane sizes</legend>
          <p class="prefs-pane-status">
            Left: {props.ui.leftWidth()}px / Right: {props.ui.rightWidth()}px /
            Right collapsed: {props.ui.rightCollapsed() ? "yes" : "no"}
          </p>
          <button
            type="button"
            class="prefs-action-button"
            onClick={() => props.ui.resetPaneWidths()}
          >
            Reset to defaults
          </button>
        </fieldset>
      </form>
    </div>
  );
}
