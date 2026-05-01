/**
 * Tests for `useHistoryStream`.
 *
 * The hook calls Solid's `onCleanup` on instantiation, which only works
 * inside a reactive root. Each test wraps `useHistoryStream` in
 * `createRoot` so the cleanup hook is bound to a disposer the test
 * controls. The EventSource is faked via the `createEventSource`
 * injection point — no DOM, no network.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { useHistoryStream } from "./useHistoryStream";

interface FakeEventSource {
  url: string;
  closed: boolean;
  listeners: Map<string, Array<(e: Event) => void>>;
  onerror: ((this: FakeEventSource) => void) | null;
  addEventListener: (name: string, cb: (e: Event) => void) => void;
  close: () => void;
  triggerNamedEvent: (name: string, dataString: string) => void;
  triggerError: () => void;
}

function makeFakeEventSource(url: string): FakeEventSource {
  const listeners = new Map<string, Array<(e: Event) => void>>();
  const es: FakeEventSource = {
    url,
    closed: false,
    listeners,
    onerror: null,
    addEventListener(name, cb) {
      const arr = listeners.get(name) ?? [];
      arr.push(cb);
      listeners.set(name, arr);
    },
    close() {
      this.closed = true;
    },
    triggerNamedEvent(name, dataString) {
      const arr = listeners.get(name) ?? [];
      const evt = { data: dataString } as unknown as Event;
      for (const cb of arr) cb(evt);
    },
    triggerError() {
      this.onerror?.call(this);
    },
  };
  return es;
}

describe("useHistoryStream", () => {
  test("opens an EventSource against the supplied url on mount", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      useHistoryStream({
        url: "/api/history/conversations/events",
        payloadEventName: "history:list",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });
      expect(sources.length).toBe(1);
      expect(sources[0].url).toBe("/api/history/conversations/events");
      dispose();
    });
  });

  test("payload event JSON-parses into the data signal", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      const stream = useHistoryStream<{ items: number[] }>({
        url: "/x",
        payloadEventName: "history:list",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });

      expect(stream.data()).toBeNull();
      sources[0].triggerNamedEvent("history:list", '{"items":[1,2,3]}');
      expect(stream.data()).toEqual({ items: [1, 2, 3] });
      expect(stream.notFound()).toBe(false);
      expect(stream.error()).toBeNull();
      dispose();
    });
  });

  test("not-found event flips the notFound signal and clears any error", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      const stream = useHistoryStream<unknown>({
        url: "/x",
        payloadEventName: "history:conversation",
        notFoundEventName: "history:not-found",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });

      sources[0].triggerError();
      expect(stream.error()).toBe("connection lost");

      sources[0].triggerNamedEvent("history:not-found", '{"id":"x"}');
      expect(stream.notFound()).toBe(true);
      expect(stream.error()).toBeNull();
      dispose();
    });
  });

  test("error after not-found clears notFound (states stay exclusive)", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      const stream = useHistoryStream<unknown>({
        url: "/x",
        payloadEventName: "history:conversation",
        notFoundEventName: "history:not-found",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });

      sources[0].triggerNamedEvent("history:not-found", '{"id":"x"}');
      expect(stream.notFound()).toBe(true);
      expect(stream.error()).toBeNull();

      sources[0].triggerError();
      expect(stream.error()).toBe("connection lost");
      // The previous not-found verdict is dropped: with the connection
      // lost it is no longer a current statement about the entity.
      expect(stream.notFound()).toBe(false);
      dispose();
    });
  });

  test("payload after not-found clears notFound", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      const stream = useHistoryStream<{ ok: boolean }>({
        url: "/x",
        payloadEventName: "history:conversation",
        notFoundEventName: "history:not-found",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });

      sources[0].triggerNamedEvent("history:not-found", '{"id":"x"}');
      expect(stream.notFound()).toBe(true);

      sources[0].triggerNamedEvent("history:conversation", '{"ok":true}');
      expect(stream.notFound()).toBe(false);
      expect(stream.data()).toEqual({ ok: true });
      dispose();
    });
  });

  test("malformed payload JSON does not update data and is logged", () => {
    const sources: FakeEventSource[] = [];
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      createRoot((dispose) => {
        const stream = useHistoryStream<unknown>({
          url: "/x",
          payloadEventName: "history:list",
          createEventSource: (u) => {
            const es = makeFakeEventSource(u);
            sources.push(es);
            return es as unknown as EventSource;
          },
        });

        sources[0].triggerNamedEvent("history:list", "not-json");
        expect(stream.data()).toBeNull();
        expect(warnings.length).toBe(1);

        // A subsequent valid event still flows through.
        sources[0].triggerNamedEvent("history:list", '{"ok":1}');
        expect(stream.data()).toEqual({ ok: 1 });
        dispose();
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("onerror sets the error signal", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      const stream = useHistoryStream<unknown>({
        url: "/x",
        payloadEventName: "history:list",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });

      expect(stream.error()).toBeNull();
      sources[0].triggerError();
      expect(stream.error()).toBe("connection lost");
      dispose();
    });
  });

  test("dispose closes the underlying EventSource", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      useHistoryStream({
        url: "/x",
        payloadEventName: "history:list",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });
      expect(sources[0].closed).toBe(false);
      dispose();
      expect(sources[0].closed).toBe(true);
    });
  });

  test("ignores not-found events when notFoundEventName is omitted", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      const stream = useHistoryStream<unknown>({
        url: "/x",
        payloadEventName: "history:list",
        // no notFoundEventName
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });

      // The hook must not have registered a listener for the not-found
      // event when the option is absent — the wire vocabulary stays a
      // strict subset of what the caller opts into.
      expect(sources[0].listeners.has("history:not-found")).toBe(false);

      // Even if the backend somehow dispatches the event, no listener
      // fires, so notFound stays false.
      sources[0].triggerNamedEvent("history:not-found", '{"id":"x"}');
      expect(stream.notFound()).toBe(false);
      dispose();
    });
  });

  test("payload event after an error clears the error signal", () => {
    const sources: FakeEventSource[] = [];
    createRoot((dispose) => {
      const stream = useHistoryStream<{ ok: boolean }>({
        url: "/x",
        payloadEventName: "history:list",
        createEventSource: (u) => {
          const es = makeFakeEventSource(u);
          sources.push(es);
          return es as unknown as EventSource;
        },
      });

      sources[0].triggerError();
      expect(stream.error()).toBe("connection lost");

      sources[0].triggerNamedEvent("history:list", '{"ok":true}');
      expect(stream.error()).toBeNull();
      expect(stream.data()).toEqual({ ok: true });
      dispose();
    });
  });

  test("re-mounting against a new url closes the old EventSource and opens a new one", () => {
    // Pins the lifecycle guarantee `HistoryShell`'s keyed `<Match>`
    // depends on for id-only navigation: when the keyed value flips,
    // Solid disposes the previous reactive root (closing this hook's
    // EventSource) and constructs a fresh one against the new URL.
    // The hook itself never sees a mid-life URL change — the contract
    // is dispose-and-rebuild — so we exercise the same shape here.
    const sources: FakeEventSource[] = [];
    const factory = (u: string) => {
      const es = makeFakeEventSource(u);
      sources.push(es);
      return es as unknown as EventSource;
    };

    const disposeA = createRoot((dispose) => {
      useHistoryStream({
        url: "/api/history/conversation/A/events",
        payloadEventName: "history:conversation",
        notFoundEventName: "history:not-found",
        createEventSource: factory,
      });
      return dispose;
    });
    expect(sources.length).toBe(1);
    expect(sources[0].url).toBe("/api/history/conversation/A/events");
    expect(sources[0].closed).toBe(false);

    // Dispose the previous owner — equivalent to `keyed` Match
    // re-mount tearing down the old child.
    disposeA();
    expect(sources[0].closed).toBe(true);

    // Fresh mount against the new id opens an independent EventSource.
    createRoot((dispose) => {
      useHistoryStream({
        url: "/api/history/conversation/B/events",
        payloadEventName: "history:conversation",
        notFoundEventName: "history:not-found",
        createEventSource: factory,
      });
      expect(sources.length).toBe(2);
      expect(sources[1].url).toBe("/api/history/conversation/B/events");
      expect(sources[1].closed).toBe(false);
      // The old socket stays closed; the new one is independent.
      expect(sources[0].closed).toBe(true);
      dispose();
      expect(sources[1].closed).toBe(true);
    });
  });

  test("constructor throw is captured into the error signal", () => {
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      createRoot((dispose) => {
        const stream = useHistoryStream<unknown>({
          url: "/x",
          payloadEventName: "history:list",
          createEventSource: () => {
            throw new Error("boom");
          },
        });
        expect(stream.error()).toBe("boom");
        expect(errors.length).toBe(1);
        dispose();
      });
    } finally {
      console.error = originalError;
    }
  });
});
