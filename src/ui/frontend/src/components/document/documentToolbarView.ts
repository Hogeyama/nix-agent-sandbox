import type {
  DocumentMode,
  DocumentReviewState,
} from "../../stores/documentReviewStore";

export interface DocumentToolbarInput {
  readonly selectedSessionId: string | null;
  readonly review: DocumentReviewState;
}

interface ToolbarButtonView {
  readonly visible: boolean;
  readonly label: string;
  readonly disabled: boolean;
}

export interface DocumentToolbarView {
  readonly documentOpen: boolean;
  readonly open: ToolbarButtonView;
  readonly back: ToolbarButtonView;
  readonly refresh: ToolbarButtonView;
  readonly modes: {
    readonly visible: boolean;
    readonly selected: DocumentMode;
    readonly disabled: boolean;
  };
  readonly staleVisible: boolean;
  readonly errorMessage: string | null;
}

export function describeDocumentToolbar(
  input: DocumentToolbarInput,
): DocumentToolbarView {
  const { review, selectedSessionId } = input;
  const documentOpen = review.item !== null;
  return {
    documentOpen,
    open: {
      visible: true,
      label:
        review.loading && !documentOpen
          ? "Opening…"
          : documentOpen
            ? "Open another"
            : "Open doc from clipboard",
      disabled: review.loading || selectedSessionId === null,
    },
    back: {
      visible: documentOpen,
      label: "Back to terminal",
      disabled: false,
    },
    refresh: {
      visible: documentOpen,
      label: review.loading ? "Refreshing…" : "Refresh",
      disabled: review.loading,
    },
    modes: {
      visible: documentOpen,
      selected: review.mode,
      disabled: review.loading,
    },
    staleVisible: documentOpen && review.stale,
    errorMessage: review.error,
  };
}
