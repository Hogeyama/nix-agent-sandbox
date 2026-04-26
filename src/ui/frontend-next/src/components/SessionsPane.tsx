import { For, Show } from "solid-js";
import type { SessionRow } from "../stores/types";
import { SessionActions } from "./SessionActions";
import { describeSessionRow, formatSessionTree } from "./sessionRowView";

type Props = {
  sessions: () => SessionRow[];
  activeId: () => string | null;
  onSelect: (sessionId: string) => void;
  onStop: (containerName: string) => Promise<void>;
  onRename: (sessionId: string, name: string) => Promise<void>;
  onShellToggle: (row: SessionRow) => void;
};

export function SessionsPane(props: Props) {
  return (
    <aside class="pane pane-left">
      <div class="pane-header">
        <div class="pane-title">
          <span class="label">Sessions</span>
        </div>
      </div>
      <ul class="session-list">
        <For
          each={props.sessions()}
          fallback={<li class="empty">No sessions</li>}
        >
          {(row) => {
            const display = describeSessionRow(row);
            const tree = formatSessionTree(row);
            return (
              // biome-ignore lint/a11y/useSemanticElements: <dl> is not phrasing content, so wrapping the row in <button> is invalid HTML; the row uses <li> with role="button" instead.
              // biome-ignore lint/a11y/useFocusableInteractive: tabindex={0} below makes the row focusable; biome does not recognise the lowercase Solid attribute.
              <li
                class="session"
                classList={{ active: row.id === props.activeId() }}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the row delegates selection to onSelect and exposes that intent through role="button"; replacing the <li> breaks the surrounding <ul> session-list semantics.
                role="button"
                tabindex={0}
                onClick={(e) => {
                  // Ignore clicks that originate inside .session-actions so inner action buttons own their own click handlers.
                  if (
                    (e.target as HTMLElement).closest(".session-actions") ===
                    null
                  ) {
                    props.onSelect(row.id);
                  }
                }}
                onKeyDown={(e) => {
                  // Match the closest-check guard on onClick: keystrokes
                  // that originate inside .session-actions belong to inner
                  // inputs/buttons and must not bubble up as row activation.
                  if (
                    (e.target as HTMLElement).closest(".session-actions") !==
                    null
                  ) {
                    return;
                  }
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onSelect(row.id);
                  }
                }}
              >
                <span class={display.dotClass} aria-hidden="true" />
                <div class="session-title">{row.name}</div>
                <Show when={display.badge}>
                  {(badge) => <span class={badge().class}>{badge().text}</span>}
                </Show>
                <dl class="session-meta">
                  <dt>dir</dt>
                  <dd>{row.dir ?? "—"}</dd>
                  <dt>prof</dt>
                  <dd>{row.profile ?? "—"}</dd>
                  <dt>tree</dt>
                  <dd classList={{ dim: tree.dim }}>{tree.text}</dd>
                  <dt>id</dt>
                  <dd class="dim">
                    <span class="id">{row.shortId}</span>
                  </dd>
                </dl>
                <div class="session-actions">
                  <SessionActions
                    row={row}
                    onStop={props.onStop}
                    onRename={props.onRename}
                    onShellToggle={props.onShellToggle}
                  />
                </div>
              </li>
            );
          }}
        </For>
      </ul>
    </aside>
  );
}
