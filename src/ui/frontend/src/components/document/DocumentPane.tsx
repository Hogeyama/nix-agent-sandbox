import { createEffect, createMemo, For, on, Show } from "solid-js";
import type { DocumentItem } from "../../api/client";
import type { DocumentMode } from "../../stores/documentReviewStore";
import { MarkdownNodes } from "./MarkdownNodes";
import { buildMarkdownView } from "./markdownView";
import { buildSourceView } from "./sourceView";

export type DocumentTheme = "light" | "dark";

export interface DocumentPaneProps {
  item: () => DocumentItem;
  mode: () => DocumentMode;
  stale: () => boolean;
  theme: () => DocumentTheme;
}

export function DocumentPane(props: DocumentPaneProps) {
  const rendered = createMemo(() => buildMarkdownView(props.item().content));
  const source = createMemo(() =>
    buildSourceView(props.item().content, props.item().line),
  );
  const location = createMemo(() => {
    const { line, column } = props.item();
    if (line === null) return null;
    return column === null ? `line ${line}` : `line ${line}, column ${column}`;
  });
  let sourceElement: HTMLDivElement | undefined;

  createEffect(
    on(
      () => [props.mode(), source().scrollLine] as const,
      ([mode, scrollLine]) => {
        if (mode !== "source" || scrollLine === null) return;
        sourceElement
          ?.querySelector<HTMLElement>(`[data-source-line="${scrollLine}"]`)
          ?.scrollIntoView({ block: "center" });
      },
      { defer: true },
    ),
  );

  return (
    <article
      class="document-pane"
      classList={{
        "document-theme-light": props.theme() === "light",
        "document-theme-dark": props.theme() === "dark",
      }}
      data-document-theme={props.theme()}
      aria-label="Document review"
    >
      <header class="document-header">
        <span class="document-path">{props.item().path}</span>
        <span class="document-location">
          <Show when={location()}>{(value) => value()}</Show>
          <Show when={props.stale()}>
            <span class="document-stale">Stale</span>
          </Show>
        </span>
      </header>
      <Show
        when={props.mode() === "rendered"}
        fallback={
          <div class="document-source" ref={sourceElement}>
            <For each={source().lines}>
              {(line) => (
                <div
                  class="document-source-row"
                  classList={{
                    "document-source-highlighted": line.highlighted,
                  }}
                  data-source-line={line.number}
                >
                  <span class="document-source-number" aria-hidden="true">
                    {line.number}
                  </span>
                  <code>{line.text}</code>
                </div>
              )}
            </For>
          </div>
        }
      >
        <div class="document-markdown">
          <MarkdownNodes nodes={rendered()} />
        </div>
      </Show>
    </article>
  );
}
