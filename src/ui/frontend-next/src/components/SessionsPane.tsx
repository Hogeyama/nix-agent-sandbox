import { For, Show } from "solid-js";
import type { SessionRow } from "../stores/types";
import { EditableSessionName } from "./EditableSessionName";
import type { PendingCount } from "./sessionPendingSummary";
import { describeSessionRow, formatSessionTree } from "./sessionRowView";

type Props = {
  sessions: () => SessionRow[];
  activeId: () => string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, name: string) => Promise<void>;
  // Accessor for the per-session pending counts. Mirrors the `scopeFor`
  // / `busyFor` accessor pattern used by `PendingPane` so the parent
  // owns the underlying memo and SessionsPane only reads through here.
  pendingFor: (sessionId: string) => PendingCount;
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
            const counts = () => props.pendingFor(row.id);
            const display = () => describeSessionRow(row, counts());
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
                  // Ignore clicks that originate inside .rename-edit so the
                  // inline editor owns its own event handling.
                  if (
                    (e.target as HTMLElement).closest(".rename-edit") === null
                  ) {
                    props.onSelect(row.id);
                  }
                }}
                onKeyDown={(e) => {
                  // Match the closest-check guard on onClick: keystrokes
                  // that originate inside .rename-edit belong to inner
                  // inputs and must not bubble up as row activation.
                  if (
                    (e.target as HTMLElement).closest(".rename-edit") !== null
                  ) {
                    return;
                  }
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onSelect(row.id);
                  }
                }}
              >
                <span class={display().dotClass} aria-hidden="true" />
                <div class="session-title-slot">
                  <EditableSessionName
                    currentName={row.name}
                    onSubmit={(next) => props.onRename(row.id, next)}
                    renderIdle={({ start, currentName }) => (
                      <button
                        type="button"
                        class="session-title"
                        aria-label={`Rename session ${currentName}. Press Enter or Space, or double-click, to rename`}
                        onClick={(e) => {
                          if (e.detail === 0) e.stopPropagation();
                        }}
                        onDblClick={(e) => {
                          e.stopPropagation();
                          start();
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          e.stopPropagation();
                          start();
                        }}
                        title="Double-click or press Enter or Space to rename"
                      >
                        {currentName}
                      </button>
                    )}
                  />
                  <Show when={counts().network > 0}>
                    <span
                      class="row-pending-chip network"
                      // role="img" upgrades the span from the implicit
                      // `generic` role so `aria-label` is honoured (biome's
                      // useAriaPropsSupportedByRole flags aria-label on a
                      // bare <span>); the chip becomes a labelled
                      // graphic with the visible "N net" text replaced
                      // for assistive tech by the full form.
                      role="img"
                      aria-label={`${counts().network} network ${
                        counts().network === 1 ? "approval" : "approvals"
                      } waiting`}
                    >
                      {counts().network} net
                    </span>
                  </Show>
                  <Show when={counts().hostexec > 0}>
                    <span
                      class="row-pending-chip hostexec"
                      // See sibling chip above for the role="img"
                      // rationale.
                      role="img"
                      aria-label={`${counts().hostexec} host-exec ${
                        counts().hostexec === 1 ? "approval" : "approvals"
                      } waiting`}
                    >
                      {counts().hostexec} host
                    </span>
                  </Show>
                </div>
                <Show when={display().badge}>
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
