import { createMemo, Show } from "solid-js";
import type {
  DocumentMode,
  DocumentReviewState,
} from "../../stores/documentReviewStore";
import type { DocumentTheme } from "./DocumentPane";
import { describeDocumentToolbar } from "./documentToolbarView";

export interface DocumentToolbarControlsProps {
  selectedSessionId: () => string | null;
  state: () => DocumentReviewState;
  onOpen: (sessionId: string) => void;
  onBack: () => void;
  onRefresh: () => void;
  onMode: (mode: DocumentMode) => void;
  theme: () => DocumentTheme;
  onTheme: (theme: DocumentTheme) => void;
}

export function DocumentToolbarControls(props: DocumentToolbarControlsProps) {
  const view = createMemo(() =>
    describeDocumentToolbar({
      selectedSessionId: props.selectedSessionId(),
      review: props.state(),
    }),
  );
  const open = () => {
    const id = props.selectedSessionId();
    if (id !== null && !view().open.disabled) props.onOpen(id);
  };

  return (
    <div class="document-toolbar-controls">
      <Show when={view().back.visible}>
        <button type="button" class="tool" onClick={() => props.onBack()}>
          {view().back.label}
        </button>
      </Show>
      <button
        type="button"
        class="tool"
        disabled={view().open.disabled}
        onClick={open}
      >
        {view().open.label}
      </button>
      <Show when={view().refresh.visible}>
        <button
          type="button"
          class="tool"
          disabled={view().refresh.disabled}
          onClick={() => props.onRefresh()}
        >
          {view().refresh.label}
        </button>
      </Show>
      <Show when={view().modes.visible}>
        <fieldset class="document-mode-controls">
          <legend class="visually-hidden">Document view mode</legend>
          <button
            type="button"
            class="tool document-mode"
            aria-pressed={view().modes.selected === "rendered"}
            disabled={view().modes.disabled}
            onClick={() => props.onMode("rendered")}
          >
            Rendered
          </button>
          <button
            type="button"
            class="tool document-mode"
            aria-pressed={view().modes.selected === "source"}
            disabled={view().modes.disabled}
            onClick={() => props.onMode("source")}
          >
            Source
          </button>
        </fieldset>
        <button
          type="button"
          class="tool document-theme-toggle"
          aria-pressed={props.theme() === "dark"}
          disabled={view().modes.disabled}
          onClick={() =>
            props.onTheme(props.theme() === "light" ? "dark" : "light")
          }
        >
          Theme: {props.theme() === "light" ? "Light" : "Dark"}
        </button>
      </Show>
      <Show when={view().staleVisible}>
        <span class="document-toolbar-stale">Stale</span>
      </Show>
    </div>
  );
}
