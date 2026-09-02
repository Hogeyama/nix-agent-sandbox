import { makeSessionUiClient } from "../../domain/session.ts";
import type {
  SessionRecord,
  SessionRuntimePaths,
} from "../../sessions/store.ts";
import type { UiDataContext } from "../data.ts";
import { json, Router } from "../router.ts";
import { type DocumentErrorCode, DocumentOpenError } from "./document_path.ts";
import {
  type DocumentReader,
  makeDocumentReader,
} from "./document_reader_service.ts";
import { isSafeId } from "./validate_ids.ts";

export interface DocumentRouteDeps {
  readonly findSession: (
    paths: SessionRuntimePaths,
    id: string,
  ) => Promise<SessionRecord | null>;
  readonly reader: DocumentReader;
}

const sessionClient = makeSessionUiClient();
const LIVE_DEPS: DocumentRouteDeps = {
  findSession: async (paths, id) =>
    (await sessionClient.list(paths)).find(
      (record) => record.sessionId === id,
    ) ?? null,
  reader: makeDocumentReader(),
};

const STATUS: Record<DocumentErrorCode, number> = {
  "invalid-path": 400,
  "unsupported-type": 400,
  "outside-worktree": 403,
  "not-found": 404,
  "not-regular-file": 422,
  "too-large": 413,
  unreadable: 422,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDocumentRoutes(
  ctx: UiDataContext,
  deps: DocumentRouteDeps = LIVE_DEPS,
): Router {
  const routes = new Router();

  routes.post("/documents/open", async ({ req }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (
      !isPlainObject(body) ||
      Object.keys(body).some(
        (key) => key !== "sessionId" && key !== "clipboardText",
      )
    ) {
      return json({ error: "Invalid document request" }, 400);
    }

    const { sessionId, clipboardText } = body;
    if (typeof sessionId !== "string" || !isSafeId(sessionId)) {
      return json({ error: "Invalid sessionId format" }, 400);
    }
    if (
      typeof clipboardText !== "string" ||
      clipboardText.length < 1 ||
      clipboardText.length > 4096
    ) {
      return json(
        { error: "clipboardText must be between 1 and 4096 characters" },
        400,
      );
    }

    try {
      const session = await deps.findSession(ctx.sessionPaths, sessionId);
      if (!session?.worktree) {
        return json({ error: "Document not found", code: "not-found" }, 404);
      }
      return json(await deps.reader.open(session.worktree, clipboardText));
    } catch (error) {
      if (error instanceof DocumentOpenError) {
        return json(
          { error: error.message, code: error.code },
          STATUS[error.code],
        );
      }
      return json({ error: "Failed to open document" }, 500);
    }
  });

  return routes;
}
