import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createDocumentReviewStore,
  type DocumentReviewDeps,
} from "./documentReviewStore";

const firstItem = {
  path: "docs/first.md",
  content: "# First",
  line: 1,
  column: null,
};

const secondItem = {
  path: "docs/second.md",
  content: "# Second",
  line: 2,
  column: 4,
};

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeStore(deps: DocumentReviewDeps) {
  let store!: ReturnType<typeof createDocumentReviewStore>;
  let dispose!: () => void;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    store = createDocumentReviewStore(deps);
  });
  return { store, dispose };
}

describe("createDocumentReviewStore", () => {
  test("first open sets loading and then renders the document", async () => {
    const opened = defer<typeof firstItem>();
    const { store, dispose } = makeStore({
      readClipboard: async () => "docs/first.md:1",
      openDocument: () => opened.promise,
    });

    try {
      const opening = store.openFromClipboard("sess-1");
      await Promise.resolve();
      expect(store.state()).toMatchObject({
        sessionId: "sess-1",
        clipboardText: "docs/first.md:1",
        item: null,
        mode: "rendered",
        loading: true,
        stale: false,
        error: null,
      });

      opened.resolve(firstItem);
      await opening;

      expect(store.state()).toEqual({
        sessionId: "sess-1",
        clipboardText: "docs/first.md:1",
        item: firstItem,
        mode: "rendered",
        loading: false,
        stale: false,
        error: null,
      });
    } finally {
      dispose();
    }
  });

  test("clipboard rejection preserves the current document and exposes a short error", async () => {
    let reads = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () => {
        reads += 1;
        if (reads === 1) return "docs/first.md";
        throw new Error("denied");
      },
      openDocument: async () => firstItem,
    });

    try {
      await store.openFromClipboard("sess-1");
      await store.openFromClipboard("sess-1");

      expect(store.state()).toEqual({
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        item: firstItem,
        mode: "rendered",
        loading: false,
        stale: false,
        error: "Clipboard access was denied",
      });
    } finally {
      dispose();
    }
  });

  test("session switch during a delayed clipboard read prevents an old-session open", async () => {
    const clipboard = defer<string>();
    let openCalls = 0;
    const { store, dispose } = makeStore({
      readClipboard: () => clipboard.promise,
      openDocument: async () => {
        openCalls += 1;
        return firstItem;
      },
    });

    try {
      const opening = store.openFromClipboard("sess-old");
      store.selectSession("sess-new");
      clipboard.resolve("docs/first.md");
      await opening;

      expect(openCalls).toBe(0);
      expect(store.state()).toEqual({
        item: null,
        sessionId: null,
        clipboardText: null,
        mode: "rendered",
        loading: false,
        stale: false,
        error: null,
      });
    } finally {
      dispose();
    }
  });

  test("clipboard denial retains mode changed while the clipboard read is pending", async () => {
    const delayedClipboard = defer<string>();
    let reads = 0;
    const { store, dispose } = makeStore({
      readClipboard: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve("docs/first.md")
          : delayedClipboard.promise;
      },
      openDocument: async () => firstItem,
    });

    try {
      await store.openFromClipboard("sess-1");
      const replacement = store.openFromClipboard("sess-1");
      store.setMode("source");
      delayedClipboard.reject(new Error("denied"));
      await replacement;

      expect(store.state()).toEqual({
        item: firstItem,
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        mode: "source",
        loading: false,
        stale: false,
        error: "Clipboard access was denied",
      });
    } finally {
      dispose();
    }
  });

  test("clipboard rejection superseding an open settles loading without old response", async () => {
    const firstOpen = defer<typeof firstItem>();
    let reads = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () => {
        reads += 1;
        if (reads === 1) return "docs/first.md";
        throw new Error("denied");
      },
      openDocument: () => firstOpen.promise,
    });

    try {
      const oldRequest = store.openFromClipboard("sess-1");
      await Promise.resolve();
      await store.openFromClipboard("sess-1");

      expect(store.state()).toEqual({
        item: null,
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        mode: "rendered",
        loading: false,
        stale: false,
        error: "Clipboard access was denied",
      });

      firstOpen.resolve(firstItem);
      await oldRequest;
      expect(store.state().item).toBeNull();
      expect(store.state().loading).toBe(false);
    } finally {
      dispose();
    }
  });

  test("clipboard rejection superseding refresh retains the saved document", async () => {
    const refreshOpen = defer<typeof secondItem>();
    let reads = 0;
    let calls = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () => {
        reads += 1;
        if (reads === 1) return "docs/first.md";
        throw new Error("denied");
      },
      openDocument: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(firstItem) : refreshOpen.promise;
      },
    });

    try {
      await store.openFromClipboard("sess-1");
      store.setMode("source");
      const refreshing = store.refresh();
      await store.openFromClipboard("sess-1");

      expect(store.state()).toEqual({
        item: firstItem,
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        mode: "source",
        loading: false,
        stale: false,
        error: "Clipboard access was denied",
      });

      refreshOpen.resolve(secondItem);
      await refreshing;
      expect(store.state().item).toEqual(firstItem);
      expect(store.state().loading).toBe(false);
    } finally {
      dispose();
    }
  });

  test("opening another document replaces it and resets source mode", async () => {
    let reads = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () =>
        ++reads === 1 ? "docs/first.md" : "docs/second.md",
      openDocument: async (_sessionId, text) =>
        text === "docs/first.md" ? firstItem : secondItem,
    });

    try {
      await store.openFromClipboard("sess-1");
      store.setMode("source");
      await store.openFromClipboard("sess-1");

      expect(store.state()).toMatchObject({
        item: secondItem,
        clipboardText: "docs/second.md",
        mode: "rendered",
        loading: false,
      });
    } finally {
      dispose();
    }
  });

  test("an older slow open cannot overwrite a newer document", async () => {
    const firstOpen = defer<typeof firstItem>();
    const secondOpen = defer<typeof secondItem>();
    let reads = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () =>
        ++reads === 1 ? "docs/first.md" : "docs/second.md",
      openDocument: (_sessionId, text) =>
        text === "docs/first.md" ? firstOpen.promise : secondOpen.promise,
    });

    try {
      const oldRequest = store.openFromClipboard("sess-1");
      await Promise.resolve();
      const newRequest = store.openFromClipboard("sess-1");
      await Promise.resolve();
      secondOpen.resolve(secondItem);
      await newRequest;
      firstOpen.resolve(firstItem);
      await oldRequest;

      expect(store.state().item).toEqual(secondItem);
    } finally {
      dispose();
    }
  });

  test("refresh retains source mode and marks the prior document stale on failure", async () => {
    let attempts = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () => "docs/first.md",
      openDocument: async () => {
        attempts += 1;
        if (attempts === 1) return firstItem;
        throw new Error("File changed");
      },
    });

    try {
      await store.openFromClipboard("sess-1");
      store.setMode("source");
      await store.refresh();

      expect(store.state()).toEqual({
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        item: firstItem,
        mode: "source",
        loading: false,
        stale: true,
        error: "File changed",
      });
    } finally {
      dispose();
    }
  });

  test("refresh success retains mode selected while the request is pending", async () => {
    const refreshed = defer<typeof secondItem>();
    let calls = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () => "docs/first.md",
      openDocument: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(firstItem) : refreshed.promise;
      },
    });

    try {
      await store.openFromClipboard("sess-1");
      const refreshing = store.refresh();
      store.setMode("source");
      refreshed.resolve(secondItem);
      await refreshing;

      expect(store.state()).toEqual({
        item: secondItem,
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        mode: "source",
        loading: false,
        stale: false,
        error: null,
      });
    } finally {
      dispose();
    }
  });

  test("refresh failure retains mode selected while the request is pending", async () => {
    const refreshed = defer<typeof secondItem>();
    let calls = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () => "docs/first.md",
      openDocument: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(firstItem) : refreshed.promise;
      },
    });

    try {
      await store.openFromClipboard("sess-1");
      store.setMode("source");
      const refreshing = store.refresh();
      store.setMode("rendered");
      refreshed.reject(new Error("File changed"));
      await refreshing;

      expect(store.state()).toEqual({
        item: firstItem,
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        mode: "rendered",
        loading: false,
        stale: true,
        error: "File changed",
      });
    } finally {
      dispose();
    }
  });

  test("failed replacement preserves an already-stale document", async () => {
    let calls = 0;
    const { store, dispose } = makeStore({
      readClipboard: async () =>
        calls === 0 ? "docs/first.md" : "docs/second.md",
      openDocument: async () => {
        calls += 1;
        if (calls === 1) return firstItem;
        throw new Error(calls === 2 ? "Refresh failed" : "Replacement failed");
      },
    });

    try {
      await store.openFromClipboard("sess-1");
      await store.refresh();
      expect(store.state().stale).toBe(true);

      await store.openFromClipboard("sess-1");

      expect(store.state()).toEqual({
        item: firstItem,
        sessionId: "sess-1",
        clipboardText: "docs/first.md",
        mode: "rendered",
        loading: false,
        stale: true,
        error: "Replacement failed",
      });
    } finally {
      dispose();
    }
  });

  test("close invalidates an in-flight response", async () => {
    const opened = defer<typeof firstItem>();
    const { store, dispose } = makeStore({
      readClipboard: async () => "docs/first.md",
      openDocument: () => opened.promise,
    });

    try {
      const opening = store.openFromClipboard("sess-1");
      await Promise.resolve();
      store.close();
      opened.resolve(firstItem);
      await opening;

      expect(store.state()).toEqual({
        item: null,
        sessionId: null,
        clipboardText: null,
        mode: "rendered",
        loading: false,
        stale: false,
        error: null,
      });
    } finally {
      dispose();
    }
  });

  test("selectSession closes only after its session changes", async () => {
    const opened = defer<typeof firstItem>();
    const { store, dispose } = makeStore({
      readClipboard: async () => "docs/first.md",
      openDocument: () => opened.promise,
    });

    try {
      const opening = store.openFromClipboard("sess-1");
      await Promise.resolve();
      store.selectSession("sess-1");
      expect(store.state().loading).toBe(true);

      store.selectSession("sess-2");
      opened.resolve(firstItem);
      await opening;

      expect(store.state()).toEqual({
        item: null,
        sessionId: null,
        clipboardText: null,
        mode: "rendered",
        loading: false,
        stale: false,
        error: null,
      });
    } finally {
      dispose();
    }
  });
});
