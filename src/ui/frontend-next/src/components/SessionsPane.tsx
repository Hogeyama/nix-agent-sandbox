import { For, Show } from "solid-js";
import type { SessionRow } from "../stores/types";
import { describeSessionRow, formatSessionTree } from "./sessionRowView";

type Props = {
  sessions: () => SessionRow[];
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
              <li class="session">
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
              </li>
            );
          }}
        </For>
      </ul>
    </aside>
  );
}
