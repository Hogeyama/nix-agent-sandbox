/**
 * Integration tests for the three history SSE endpoints.
 *
 * The Router is exercised end-to-end via `Router.request()` so the path
 * compilation, `:id` extraction and `isSafeId` guard are all covered.
 * The poll interval is shrunk to a few ms so each test asserts at least
 * two poll cycles in well under a second.
 */

import { expect, test } from "bun:test";
import type {
  ConversationDetail,
  ConversationListRow,
  InvocationDetail,
} from "../../history/store.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import type { SessionRuntimePaths } from "../../sessions/store.ts";
import type { UiDataContext, UiHistoryReader } from "../data.ts";
import { Router } from "../router.ts";
import {
  createHistorySseRoutes,
  DEFAULT_POLL_INTERVAL_MS,
} from "./history_sse.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeListRow(id: string): ConversationListRow {
  return {
    id,
    agent: "claude",
    firstSeenAt: "2025-01-01T00:00:00Z",
    lastSeenAt: "2025-01-01T00:00:01Z",
    turnEventCount: 1,
    spanCount: 1,
    invocationCount: 1,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    cacheReadTotal: 0,
    cacheWriteTotal: 0,
    summary: null,
  };
}

function makeConversationDetail(id: string): ConversationDetail {
  return {
    conversation: makeListRow(id),
    traces: [],
    spans: [],
    turnEvents: [],
    invocations: [],
  };
}

function makeInvocationDetail(id: string): InvocationDetail {
  return {
    invocation: {
      id,
      profile: null,
      agent: "claude",
      worktreePath: null,
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    },
    traces: [],
    spans: [],
    turnEvents: [],
    conversations: [],
  };
}

interface MockReader extends UiHistoryReader {
  setList(rows: ConversationListRow[]): void;
  setConversation(id: string, d: ConversationDetail | null): void;
  setInvocation(id: string, d: InvocationDetail | null): void;
  listCalls: number;
  conversationCalls: Array<string>;
  invocationCalls: Array<string>;
}

function makeMockReader(): MockReader {
  let list: ConversationListRow[] = [];
  const conversations = new Map<string, ConversationDetail | null>();
  const invocations = new Map<string, InvocationDetail | null>();
  const reader: MockReader = {
    listCalls: 0,
    conversationCalls: [],
    invocationCalls: [],
    readConversationList: () => {
      reader.listCalls++;
      return list;
    },
    readConversationDetail: (id) => {
      reader.conversationCalls.push(id);
      return conversations.get(id) ?? null;
    },
    readInvocationDetail: (id) => {
      reader.invocationCalls.push(id);
      return invocations.get(id) ?? null;
    },
    setList: (rows) => {
      list = rows;
    },
    setConversation: (id, d) => {
      conversations.set(id, d);
    },
    setInvocation: (id, d) => {
      invocations.set(id, d);
    },
  };
  return reader;
}

function makeCtx(reader: UiHistoryReader): UiDataContext {
  const networkPaths: NetworkRuntimePaths = {
    runtimeDir: "/tmp/network",
    sessionsDir: "/tmp/network/sessions",
    pendingDir: "/tmp/network/pending",
    brokersDir: "/tmp/network/brokers",
    authRouterSocket: "/tmp/network/router.sock",
    authRouterPidFile: "/tmp/network/router.pid",
    envoyConfigFile: "/tmp/network/envoy.yaml",
  };
  const hostExecPaths: HostExecRuntimePaths = {
    runtimeDir: "/tmp/hostexec",
    sessionsDir: "/tmp/hostexec/sessions",
    pendingDir: "/tmp/hostexec/pending",
    brokersDir: "/tmp/hostexec/brokers",
    wrappersDir: "/tmp/hostexec/wrappers",
  };
  const sessionPaths: SessionRuntimePaths = {
    runtimeDir: "/tmp/sessions",
    sessionsDir: "/tmp/sessions/sessions",
  };
  return {
    networkPaths,
    hostExecPaths,
    sessionPaths,
    auditDir: "/tmp/audit",
    terminalRuntimeDir: "/tmp/dtach",
    historyDbPath: "/tmp/history.db",
    history: reader,
  };
}

interface ParsedSseEvent {
  event: string;
  data: unknown;
}

/**
 * Read the SSE stream for `windowMs` milliseconds, then cancel the reader
 * (which triggers the `cancel()` hook on our ReadableStream) and return
 * every parsed event.
 */
async function readEventsFor(
  res: Response,
  windowMs: number,
): Promise<ParsedSseEvent[]> {
  const body = res.body;
  if (!body) throw new Error("response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + windowMs;

  function drainBuffer(): void {
    // SSE event boundary is the blank line "\n\n".
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let dataLine = "";
      let hasField = false;
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // SSE comment — server keepalive
        if (line.startsWith("event: ")) {
          event = line.slice(7);
          hasField = true;
        } else if (line.startsWith("data: ")) {
          dataLine = line.slice(6);
          hasField = true;
        }
      }
      // Comment-only blocks carry no event payload — skip them.
      if (!hasField) continue;
      events.push({ event, data: dataLine ? JSON.parse(dataLine) : null });
    }
  }

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const t = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(
        () => resolve({ done: true, value: undefined }),
        Math.max(remaining, 0),
      ),
    );
    const r = reader.read();
    const result = await Promise.race([
      r,
      t.then(() => ({ done: false, value: undefined as unknown })),
    ]);
    // Only the real reader.read() result has `value` as Uint8Array.
    if (result instanceof Object && "value" in result && result.value) {
      buffer += decoder.decode(result.value as Uint8Array, { stream: true });
      drainBuffer();
    }
    if ((result as { done: boolean }).done && Date.now() >= deadline) break;
    if (Date.now() >= deadline) break;
  }
  buffer += decoder.decode();
  drainBuffer();
  await reader.cancel();
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const POLL_MS = 20;
const WINDOW_MS = 120;

test("conversations stream emits initial snapshot then a diff after a write", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/conversations/events");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  expect(res.headers.get("Cache-Control")).toBe("no-store");

  // Schedule a state change after the first poll fires.
  setTimeout(() => reader.setList([makeListRow("c1")]), POLL_MS + 5);

  const events = await readEventsFor(res, WINDOW_MS);
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events[0].event).toBe("history:list");
  expect(events[0].data).toEqual({ conversations: [] });
  // At least one later event reflects the new row.
  expect(
    events
      .slice(1)
      .some(
        (e) =>
          e.event === "history:list" &&
          Array.isArray((e.data as { conversations?: unknown }).conversations),
      ),
  ).toBe(true);
  const last = events[events.length - 1];
  expect(
    (last.data as { conversations: ConversationListRow[] }).conversations.map(
      (r) => r.id,
    ),
  ).toEqual(["c1"]);
});

test("conversations stream stays silent across polls when payload is unchanged", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/conversations/events");
  const events = await readEventsFor(res, WINDOW_MS);
  // Only the initial snapshot. The reader was polled multiple times.
  expect(events.length).toBe(1);
  expect(events[0].event).toBe("history:list");
  expect(reader.listCalls).toBeGreaterThanOrEqual(2);
});

test("conversation detail emits not-found event when id is missing", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/conversation/c1/events");
  const events = await readEventsFor(res, WINDOW_MS);
  expect(events[0].event).toBe("history:not-found");
  expect(events[0].data).toEqual({ id: "c1" });
});

test("conversation detail transitions from not-found to conversation", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/conversation/c1/events");
  setTimeout(
    () => reader.setConversation("c1", makeConversationDetail("c1")),
    POLL_MS + 5,
  );
  const events = await readEventsFor(res, WINDOW_MS);

  expect(events[0].event).toBe("history:not-found");
  const found = events.find((e) => e.event === "history:conversation");
  expect(found).toBeDefined();
  expect((found?.data as ConversationDetail).conversation.id).toBe("c1");
});

test("invocation detail emits history:invocation when present", async () => {
  const reader = makeMockReader();
  reader.setInvocation("i1", makeInvocationDetail("i1"));
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/invocation/i1/events");
  const events = await readEventsFor(res, WINDOW_MS);
  expect(events[0].event).toBe("history:invocation");
  expect((events[0].data as InvocationDetail).invocation.id).toBe("i1");
});

test("unsafe :id is rejected with 400 and never reaches the reader", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  // path traversal attempt — `..` is encoded into a single segment by the
  // router but `isSafeId` rejects the literal substring.
  const res = await app.request("/api/history/conversation/..%2Fetc/events");
  expect(res.status).toBe(400);
  expect(reader.conversationCalls.length).toBe(0);
});

test("two concurrent connections keep independent per-connection state", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const r1 = await app.request("/api/history/conversations/events");
  // Set state before opening r2 — r2's first emit must reflect this row,
  // independently of r1's already-streaming state.
  reader.setList([makeListRow("c1")]);
  const r2 = await app.request("/api/history/conversations/events");

  const [e1, e2] = await Promise.all([
    readEventsFor(r1, WINDOW_MS),
    readEventsFor(r2, WINDOW_MS),
  ]);

  // r1 saw an initial empty list, r2 saw an initial 1-row list.
  expect(e1[0].data).toEqual({ conversations: [] });
  expect(
    (e2[0].data as { conversations: ConversationListRow[] }).conversations.map(
      (r) => r.id,
    ),
  ).toEqual(["c1"]);
});

test("pollLoop swallows reader exceptions and the next successful poll still emits", async () => {
  const reader = makeMockReader();
  // First call throws to simulate a transient db failure; later calls
  // return a non-empty list so a successful emit can be observed.
  let callCount = 0;
  reader.readConversationList = () => {
    callCount++;
    if (callCount === 1) {
      throw new Error("transient db failure");
    }
    return [makeListRow("c1")];
  };
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/conversations/events");
  expect(res.status).toBe(200);
  const events = await readEventsFor(res, WINDOW_MS);

  // The first poll threw, the connection stayed open, and a later poll
  // produced a real emit.
  expect(callCount).toBeGreaterThanOrEqual(2);
  expect(events.length).toBeGreaterThanOrEqual(1);
  const list = events.find((e) => e.event === "history:list");
  expect(list).toBeDefined();
  expect(
    (list?.data as { conversations: ConversationListRow[] }).conversations.map(
      (r) => r.id,
    ),
  ).toEqual(["c1"]);
});

test("DEFAULT_POLL_INTERVAL_MS is 5000ms (matches OTEL batch flush cadence)", () => {
  expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000);
});

test("conversations stream emits keepalive comments on every poll", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/conversations/events");
  const body = res.body;
  if (!body) throw new Error("response has no body");
  const decoder = new TextDecoder();
  const streamReader = body.getReader();
  let raw = "";
  const deadline = Date.now() + WINDOW_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      streamReader.read(),
      new Promise<{ done: true }>((resolve) =>
        setTimeout(() => resolve({ done: true }), remaining),
      ),
    ]);
    if (result.done) break;
    raw += decoder.decode(result.value, { stream: true });
  }
  await streamReader.cancel().catch(() => {});

  // At least one keepalive line must appear over the read window. Several
  // polls fire within WINDOW_MS / POLL_MS; each should emit a keepalive.
  const keepalives = raw.split("\n").filter((l) => l.startsWith(":")).length;
  expect(keepalives).toBeGreaterThanOrEqual(1);
});

test("cancelling the stream stops further polling", async () => {
  const reader = makeMockReader();
  const ctx = makeCtx(reader);
  const app = new Router();
  app.route("/api", createHistorySseRoutes(ctx, { pollIntervalMs: POLL_MS }));

  const res = await app.request("/api/history/conversations/events");
  // Drive at least one poll then cancel via readEventsFor()'s reader.cancel().
  await readEventsFor(res, POLL_MS * 2);
  const callsAfterCancel = reader.listCalls;
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
  // No further reader calls after cancel — within scheduling tolerance,
  // exactly equal.
  expect(reader.listCalls).toBe(callsAfterCancel);
});
