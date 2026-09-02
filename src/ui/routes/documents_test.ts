import { describe, expect, test } from "bun:test";
import type {
  SessionRecord,
  SessionRuntimePaths,
} from "../../sessions/store.ts";
import type { UiDataContext } from "../data.ts";
import { type DocumentErrorCode, DocumentOpenError } from "./document_path.ts";
import type { DocumentReader } from "./document_reader_service.ts";
import { createDocumentRoutes, type DocumentRouteDeps } from "./documents.ts";

const SESSION_PATHS: SessionRuntimePaths = {
  runtimeDir: "/runtime",
  sessionsDir: "/runtime/sessions",
};
const CTX = { sessionPaths: SESSION_PATHS } as UiDataContext;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-1",
    agent: "codex",
    profile: "default",
    worktree: "/worktree",
    turn: "user-turn",
    startedAt: "2026-09-02T00:00:00.000Z",
    lastEventAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<DocumentRouteDeps> = {},
): DocumentRouteDeps {
  return {
    findSession: async (_paths, id) =>
      id === "sess-1" ? makeRecord({ sessionId: id }) : null,
    reader: {
      open: async () => ({
        path: "docs/design.md",
        content: "# Design\n",
        line: 4,
        column: null,
      }),
    },
    ...overrides,
  };
}

function post(body: BodyInit): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
}

describe("POST /documents/open", () => {
  test("opens a document from the requested live session", async () => {
    const calls: Array<{
      paths: SessionRuntimePaths;
      id: string;
      worktree: string;
      clipboardText: string;
    }> = [];
    const deps = makeDeps({
      findSession: async (paths, id) => {
        calls.push({ paths, id, worktree: "", clipboardText: "" });
        return makeRecord({ sessionId: id });
      },
      reader: {
        open: async (worktree, clipboardText) => {
          Object.assign(calls[0], { worktree, clipboardText });
          return {
            path: "docs/design.md",
            content: "# Design\n",
            line: 4,
            column: null,
          };
        },
      },
    });
    const routes = createDocumentRoutes(CTX, deps);

    const response = await routes.request(
      "/documents/open",
      post(
        JSON.stringify({
          sessionId: "sess-1",
          clipboardText: "docs/design.md:4",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "docs/design.md",
      content: "# Design\n",
      line: 4,
      column: null,
    });
    expect(calls).toEqual([
      {
        paths: SESSION_PATHS,
        id: "sess-1",
        worktree: "/worktree",
        clipboardText: "docs/design.md:4",
      },
    ]);
  });

  test("rejects malformed JSON", async () => {
    const routes = createDocumentRoutes(CTX, makeDeps());
    const response = await routes.request("/documents/open", post("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });

  test.each([
    [null],
    [[]],
    [["sess-1"]],
  ])("rejects a non-object request body: %p", async (body) => {
    const routes = createDocumentRoutes(CTX, makeDeps());
    const response = await routes.request(
      "/documents/open",
      post(JSON.stringify(body)),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid document request",
    });
  });

  test("rejects unknown request keys", async () => {
    const routes = createDocumentRoutes(CTX, makeDeps());
    const response = await routes.request(
      "/documents/open",
      post(
        JSON.stringify({
          sessionId: "sess-1",
          clipboardText: "docs/design.md",
          worktree: "/secret/root",
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid document request",
    });
  });

  test.each([
    ["missing", { clipboardText: "docs/design.md" }],
    ["non-string", { sessionId: 1, clipboardText: "docs/design.md" }],
    ["unsafe", { sessionId: "../secret", clipboardText: "docs/design.md" }],
  ])("rejects a %s sessionId", async (_label, body) => {
    const routes = createDocumentRoutes(CTX, makeDeps());
    const response = await routes.request(
      "/documents/open",
      post(JSON.stringify(body)),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid sessionId format",
    });
  });

  test.each([
    ["missing", undefined],
    ["non-string", 1],
    ["empty", ""],
    ["over 4,096 characters", "a".repeat(4097)],
  ])("rejects %s clipboardText", async (_label, clipboardText) => {
    const routes = createDocumentRoutes(CTX, makeDeps());
    const body =
      clipboardText === undefined
        ? { sessionId: "sess-1" }
        : { sessionId: "sess-1", clipboardText };
    const response = await routes.request(
      "/documents/open",
      post(JSON.stringify(body)),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "clipboardText must be between 1 and 4096 characters",
    });
  });

  test.each([
    ["missing session", null],
    ["session without a worktree", makeRecord({ worktree: undefined })],
  ])("returns not-found for a %s", async (_label, session) => {
    let readerCalled = false;
    const reader: DocumentReader = {
      open: async () => {
        readerCalled = true;
        throw new Error("reader must not be called");
      },
    };
    const routes = createDocumentRoutes(
      CTX,
      makeDeps({ findSession: async () => session, reader }),
    );

    const response = await routes.request(
      "/documents/open",
      post(
        JSON.stringify({
          sessionId: "sess-1",
          clipboardText: "docs/design.md",
        }),
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Document not found",
      code: "not-found",
    });
    expect(readerCalled).toBe(false);
  });

  const errorCases: ReadonlyArray<
    readonly [DocumentErrorCode, number, string]
  > = [
    ["invalid-path", 400, "Clipboard must contain one path"],
    ["unsupported-type", 400, "Only Markdown documents can be opened"],
    ["outside-worktree", 403, "Document is outside the session worktree"],
    ["not-found", 404, "Document not found"],
    ["not-regular-file", 422, "Document is not a regular file"],
    ["too-large", 413, "Document is larger than 1 MiB"],
    ["unreadable", 422, "Document could not be read"],
  ];

  test.each(errorCases)("maps %s to HTTP %i", async (code, status, message) => {
    const routes = createDocumentRoutes(
      CTX,
      makeDeps({
        reader: {
          open: async () => {
            throw new DocumentOpenError(code, message);
          },
        },
      }),
    );

    const response = await routes.request(
      "/documents/open",
      post(
        JSON.stringify({
          sessionId: "sess-1",
          clipboardText: "docs/design.md",
        }),
      ),
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message, code });
  });

  test("redacts unexpected errors", async () => {
    const routes = createDocumentRoutes(
      CTX,
      makeDeps({
        reader: {
          open: async () => {
            throw new Error("/secret/root");
          },
        },
      }),
    );

    const response = await routes.request(
      "/documents/open",
      post(
        JSON.stringify({
          sessionId: "sess-1",
          clipboardText: "docs/design.md",
        }),
      ),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Failed to open document" });
    expect(text).not.toContain("/secret/root");
  });
});
