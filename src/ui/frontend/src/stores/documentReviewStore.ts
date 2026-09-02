import { createSignal } from "solid-js";
import type { DocumentItem } from "../api/client";

export type DocumentMode = "rendered" | "source";

export interface DocumentReviewState {
  readonly item: DocumentItem | null;
  readonly sessionId: string | null;
  readonly clipboardText: string | null;
  readonly mode: DocumentMode;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly error: string | null;
}

export interface DocumentReviewDeps {
  readClipboard(): Promise<string>;
  openDocument(sessionId: string, clipboardText: string): Promise<DocumentItem>;
}

export function createDocumentReviewStore(deps: DocumentReviewDeps) {
  const initial: DocumentReviewState = {
    item: null,
    sessionId: null,
    clipboardText: null,
    mode: "rendered",
    loading: false,
    stale: false,
    error: null,
  };
  const [state, setState] = createSignal(initial);
  let generation = 0;
  let selectedSessionId: string | null = null;

  async function request(
    sessionId: string,
    clipboardText: string,
    refresh: boolean,
    requestGeneration = ++generation,
  ) {
    if (requestGeneration !== generation) return;
    const previous = state();
    setState({
      ...(refresh ? previous : { ...previous, mode: "rendered" as const }),
      sessionId,
      clipboardText,
      loading: true,
      error: null,
    });
    try {
      const item = await deps.openDocument(sessionId, clipboardText);
      if (requestGeneration !== generation) return;
      const current = state();
      setState({
        item,
        sessionId,
        clipboardText,
        mode: refresh ? current.mode : "rendered",
        loading: false,
        stale: false,
        error: null,
      });
    } catch (error) {
      if (requestGeneration !== generation) return;
      const current = state();
      setState({
        ...previous,
        mode: refresh ? current.mode : previous.mode,
        loading: false,
        stale: refresh ? previous.item !== null : previous.stale,
        error:
          error instanceof Error ? error.message : "Failed to open document",
      });
    }
  }

  return {
    state,
    async openFromClipboard(sessionId: string) {
      selectedSessionId = sessionId;
      const requestGeneration = ++generation;
      try {
        const clipboardText = await deps.readClipboard();
        if (requestGeneration !== generation) return;
        await request(sessionId, clipboardText, false, requestGeneration);
      } catch {
        if (requestGeneration !== generation) return;
        setState({
          ...state(),
          loading: false,
          error: "Clipboard access was denied",
        });
      }
    },
    refresh() {
      const current = state();
      return current.sessionId !== null && current.clipboardText !== null
        ? request(current.sessionId, current.clipboardText, true)
        : Promise.resolve();
    },
    close() {
      generation++;
      setState(initial);
    },
    selectSession(id: string | null) {
      const sessionChanged =
        selectedSessionId !== null && selectedSessionId !== id;
      selectedSessionId = id;
      if (sessionChanged) {
        generation++;
        setState(initial);
      }
    },
    setMode(mode: DocumentMode) {
      setState({ ...state(), mode });
    },
  };
}
