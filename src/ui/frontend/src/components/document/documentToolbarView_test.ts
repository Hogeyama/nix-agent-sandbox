import { describe, expect, test } from "bun:test";
import type { DocumentReviewState } from "../../stores/documentReviewStore";
import { describeDocumentToolbar } from "./documentToolbarView";

const closed: DocumentReviewState = {
  item: null,
  sessionId: null,
  clipboardText: null,
  mode: "rendered",
  loading: false,
  stale: false,
  error: null,
};

const open: DocumentReviewState = {
  ...closed,
  item: {
    path: "docs/review.md",
    content: "# Review",
    line: 4,
    column: 2,
  },
  sessionId: "session-1",
  clipboardText: "docs/review.md:4:2",
};

describe("describeDocumentToolbar", () => {
  test("enables opening from the clipboard when a session is selected", () => {
    const view = describeDocumentToolbar({
      selectedSessionId: "session-1",
      review: closed,
    });

    expect(view.open).toEqual({
      visible: true,
      label: "Open doc from clipboard",
      disabled: false,
    });
    expect(view.documentOpen).toBe(false);
  });

  test("disables opening when no session is selected", () => {
    const view = describeDocumentToolbar({
      selectedSessionId: null,
      review: closed,
    });

    expect(view.open.disabled).toBe(true);
  });

  test("describes all document controls while a document is open", () => {
    const view = describeDocumentToolbar({
      selectedSessionId: "session-1",
      review: open,
    });

    expect(view.documentOpen).toBe(true);
    expect(view.open).toEqual({
      visible: true,
      label: "Open another",
      disabled: false,
    });
    expect(view.back).toEqual({
      visible: true,
      label: "Back to terminal",
      disabled: false,
    });
    expect(view.refresh).toEqual({
      visible: true,
      label: "Refresh",
      disabled: false,
    });
    expect(view.modes).toEqual({
      visible: true,
      selected: "rendered",
      disabled: false,
    });
  });

  test("disables requests and distinguishes opening from refreshing", () => {
    const opening = describeDocumentToolbar({
      selectedSessionId: "session-1",
      review: { ...closed, loading: true },
    });
    const refreshing = describeDocumentToolbar({
      selectedSessionId: "session-1",
      review: { ...open, loading: true },
    });

    expect(opening.open).toEqual({
      visible: true,
      label: "Opening…",
      disabled: true,
    });
    expect(refreshing.open).toEqual({
      visible: true,
      label: "Open another",
      disabled: true,
    });
    expect(refreshing.refresh).toEqual({
      visible: true,
      label: "Refreshing…",
      disabled: true,
    });
    expect(refreshing.modes.disabled).toBe(true);
  });

  test("surfaces stale and error state to the toolbar", () => {
    const stale = describeDocumentToolbar({
      selectedSessionId: "session-1",
      review: { ...open, stale: true },
    });
    const failed = describeDocumentToolbar({
      selectedSessionId: "session-1",
      review: { ...closed, error: "Document is no longer readable" },
    });

    expect(stale.staleVisible).toBe(true);
    expect(failed.errorMessage).toBe("Document is no longer readable");
  });
});
