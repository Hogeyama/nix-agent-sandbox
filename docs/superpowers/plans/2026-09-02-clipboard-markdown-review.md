# Clipboard Markdown Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human open a clipboard Markdown path for the selected nas session and review it in the center pane without tearing down the terminal.

**Architecture:** A dedicated UI route parses and reads one session-scoped Markdown file through a pinned file descriptor, then returns UTF-8 text and a normalized relative path. The Solid frontend owns ephemeral document state beside `TerminalPane`; `marked` supplies tokens only, and a closed safe-node model renders those tokens without `innerHTML`, raw HTML, or image requests.

**Tech Stack:** Bun, TypeScript 6, Effect-backed existing session client, Solid 1.9, `marked` 18.0.7 lexer, Bun test, Playwright CLI-backed CSS integration tests.

## Global Constraints

- Support only `.md` and `.markdown`, matched case-insensitively.
- Accept a relative path or an absolute path that resolves inside the selected live session's `SessionRecord.worktree`.
- Accept matching backtick/single-quote/double-quote wrappers and `:line`, `:line:column`, or `#Lline` suffixes; reject multiline input, ranges, `file://`, Windows paths, zero, and unsafe integers.
- Reuse the existing safe session-ID rule and cap `clipboardText` at 4,096 UTF-16 code units.
- Read at most 1 MiB plus one sentinel byte through the same descriptor that was validated; decode UTF-8 with `{ fatal: true }`.
- Never log or persist clipboard text or document bytes, and never send them over SSE, history, audit, or notifications.
- Never expose the canonical worktree root, `/proc` path, or raw filesystem errors in an API response.
- Render raw HTML as text; render image syntax as a non-loading placeholder; create no `img`, SVG, iframe, object, or embed node.
- Only explicit `http:` and `https:` links are interactive, with `target="_blank"` and `rel="noopener noreferrer"`; all other links are inert.
- Keep the current xterm component, handle, and WebSocket mounted while a document is visible.
- Preserve all pre-existing WebGL renderer and package-manager changes. Execute in an isolated worktree or after those changes are committed; never sweep unrelated staged hunks into this feature's commits.
- Follow `test-policy`: all tests in this plan are Docker-free colocated `*_test.ts` unit tests and use `try/finally` for temp-directory cleanup.
- At completion inside nas, run `fmt`, `lint`, `check`, then `test:unit`; do not import the Docker integration lane.

---

## File Map

**Backend**

- Create `src/ui/routes/document_path.ts`: clipboard grammar, error codes, and pure containment helpers.
- Create `src/ui/routes/document_path_test.ts`: grammar and containment unit tests.
- Create `src/ui/routes/document_reader_service.ts`: UI-route-specific, injected filesystem service that pins, validates, bounds, and decodes a Markdown file.
- Create `src/ui/routes/document_reader_service_test.ts`: live tempdir and fake-ops race/error tests.
- Create `src/ui/routes/documents.ts`: strict request validation, existing session lookup, error-to-HTTP mapping, and `/documents/open` route.
- Create `src/ui/routes/documents_test.ts`: Router-level API tests with fake session lookup and reader.
- Modify `src/ui/server.ts`: mount the document routes under `/api`.

**Frontend**

- Modify `src/ui/frontend/src/api/client.ts`: typed document payload, error code propagation, and `openDocument`.
- Modify `src/ui/frontend/src/api/client_test.ts`: document request/response and typed error tests.
- Create `src/ui/frontend/src/stores/documentReviewStore.ts`: ephemeral state plus stale-response protection.
- Create `src/ui/frontend/src/stores/documentReviewStore_test.ts`: open/replace/refresh/session-change state tests.
- Create `src/ui/frontend/src/components/document/markdownView.ts`: `marked` token tree to closed safe-node model.
- Create `src/ui/frontend/src/components/document/markdownView_test.ts`: GFM coverage and hostile Markdown tests.
- Create `src/ui/frontend/src/components/document/sourceView.ts`: source-line and clamped-location view model.
- Create `src/ui/frontend/src/components/document/sourceView_test.ts`: line splitting and location tests.
- Create `src/ui/frontend/src/components/document/MarkdownNodes.tsx`: exhaustive Solid renderer for the safe-node union.
- Create `src/ui/frontend/src/components/document/DocumentPane.tsx`: Rendered/Source center surface.
- Create `src/ui/frontend/src/components/document/DocumentToolbarControls.tsx`: open/back/refresh/mode controls in the existing footer.
- Modify `src/ui/frontend/src/components/TerminalToolbar.tsx`: host document controls and surface document errors.
- Modify `src/ui/frontend/src/components/TerminalPane.tsx`: own the review store, preserve xterm, and switch center surfaces.
- Modify `src/ui/frontend/src/styles.css`: document typography, source lines, toolbar states, and responsive overflow.
- Modify `src/ui/frontend/src/styles_integration_test.ts`: center-pane document layout regression.

**Dependencies and distribution**

- Modify `package.json`, `bun.lock`, and `bun.nix`: add `marked` 18.0.7 without losing existing dependency changes.
- Modify `scripts/build_ui.ts`: bundle Marked's MIT license text.

---

### Task 1: Clipboard path grammar and error contract

**Files:**
- Create: `src/ui/routes/document_path.ts`
- Test: `src/ui/routes/document_path_test.ts`

**Interfaces:**
- Produces: `DocumentErrorCode`, `DocumentOpenError`, `ParsedDocumentPath`, `parseDocumentClipboard(text)`, `isStrictlyInside(root, candidate)`.
- Consumes: only `node:path`; no filesystem access.

- [ ] **Step 1: Write the failing grammar tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  DocumentOpenError,
  isStrictlyInside,
  parseDocumentClipboard,
} from "./document_path";

describe("parseDocumentClipboard", () => {
  test.each([
    ["docs/design.md", { path: "docs/design.md", line: null, column: null }],
    ["`docs/design.md:42`", { path: "docs/design.md", line: 42, column: null }],
    ["'/repo/docs/design.markdown:42:7'", { path: "/repo/docs/design.markdown", line: 42, column: 7 }],
    ['"/repo/docs/design.md#L9"', { path: "/repo/docs/design.md", line: 9, column: null }],
  ])("parses %s", (raw, expected) => {
    expect(parseDocumentClipboard(raw)).toEqual(expected);
  });

  test.each([
    "",
    "a.md\nb.md",
    "`a.md",
    "a.txt",
    "a.md:0",
    "a.md#L1-L2",
    "file:///repo/a.md",
    "C:\\repo\\a.md",
    `a.md:${Number.MAX_SAFE_INTEGER + 1}`,
  ])("rejects %s", (raw) => {
    expect(() => parseDocumentClipboard(raw)).toThrow(DocumentOpenError);
  });
});

test("isStrictlyInside is component-aware", () => {
  expect(isStrictlyInside("/repo/wt", "/repo/wt/docs/a.md")).toBe(true);
  expect(isStrictlyInside("/repo/wt", "/repo/wt")).toBe(false);
  expect(isStrictlyInside("/repo/wt", "/repo/wt-other/a.md")).toBe(false);
  expect(isStrictlyInside("/repo/wt", "/repo/secret.md")).toBe(false);
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `bun test src/ui/routes/document_path_test.ts`

Expected: FAIL because `./document_path` does not exist.

- [ ] **Step 3: Implement the parser and typed errors**

```ts
import * as path from "node:path";

export type DocumentErrorCode =
  | "invalid-path"
  | "unsupported-type"
  | "outside-worktree"
  | "not-found"
  | "not-regular-file"
  | "too-large"
  | "unreadable";

export class DocumentOpenError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DocumentOpenError";
  }
}

export interface ParsedDocumentPath {
  readonly path: string;
  readonly line: number | null;
  readonly column: number | null;
}

const LOCATION_HASH = /#L([1-9]\d*)$/;
const LOCATION_COLON = /:([1-9]\d*)(?::([1-9]\d*))?$/;

function parsePositiveSafe(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DocumentOpenError("invalid-path", "Invalid document location");
  }
  return value;
}

function hasMarkdownExtension(value: string): boolean {
  const ext = path.extname(value).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

export function parseDocumentClipboard(input: string): ParsedDocumentPath {
  let value = input.trim();
  if (value === "" || /[\r\n\0]/.test(value)) {
    throw new DocumentOpenError("invalid-path", "Clipboard must contain one path");
  }
  const wrappers = new Set(["`", "'", '"']);
  if (wrappers.has(value[0] ?? "")) {
    if (value.at(-1) !== value[0] || value.length < 3) {
      throw new DocumentOpenError("invalid-path", "Document path has unmatched quotes");
    }
    value = value.slice(1, -1).trim();
  }
  if (/^file:\/\//i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new DocumentOpenError("invalid-path", "Document path syntax is not supported");
  }

  let line: number | null = null;
  let column: number | null = null;
  const match = LOCATION_HASH.exec(value) ?? LOCATION_COLON.exec(value);
  if (match) {
    const candidate = value.slice(0, match.index);
    if (hasMarkdownExtension(candidate)) {
      value = candidate;
      line = parsePositiveSafe(match[1]!);
      column = match[2] === undefined ? null : parsePositiveSafe(match[2]);
    }
  }
  if (!hasMarkdownExtension(value)) {
    throw new DocumentOpenError("unsupported-type", "Only Markdown documents can be opened");
  }
  return { path: value, line, column };
}

export function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
```

- [ ] **Step 4: Run and refine the unit tests**

Run: `bun test src/ui/routes/document_path_test.ts`

Expected: PASS. Add explicit cases for uppercase extensions, whitespace inside wrappers, colon-containing filenames, and unmatched closing wrappers before moving on.

- [ ] **Step 5: Commit the grammar**

```bash
git add src/ui/routes/document_path.ts src/ui/routes/document_path_test.ts
git commit -m "feat(ui): parse clipboard Markdown paths"
```

---

### Task 2: Descriptor-pinned document reader

**Files:**
- Create: `src/ui/routes/document_reader_service.ts`
- Test: `src/ui/routes/document_reader_service_test.ts`

**Interfaces:**
- Consumes: `parseDocumentClipboard`, `isStrictlyInside`, `DocumentOpenError` from Task 1.
- Produces: `DocumentItem`, `DocumentReader`, `DocumentFileOps`, `makeDocumentReader(ops?)`, `MAX_DOCUMENT_BYTES`.

- [ ] **Step 1: Write failing live-reader tests**

Use `mkdtemp(path.join(tmpdir(), "nas-document-reader-"))`. Create a worktree directory, a UTF-8 Markdown fixture, an outside Markdown file, a final symlink, and an intermediate symlink. Assert:

```ts
const reader = makeDocumentReader();
expect(await reader.open(worktree, "docs/design.md:2")).toEqual({
  path: "docs/design.md",
  content: "# Title\nbody\n",
  line: 2,
  column: null,
});
await expect(reader.open(worktree, outsidePath)).rejects.toMatchObject({
  code: "outside-worktree",
});
await expect(reader.open(worktree, "final-link.md")).rejects.toMatchObject({
  code: "not-regular-file",
});
await expect(reader.open(worktree, "through-link/secret.md")).rejects.toMatchObject({
  code: "outside-worktree",
});
```

Also write fixtures for invalid UTF-8 and `MAX_DOCUMENT_BYTES + 1`. Wrap all filesystem setup in `try/finally` and remove only the generated temp root.

- [ ] **Step 2: Run the reader tests and confirm failure**

Run: `bun test src/ui/routes/document_reader_service_test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement injected file operations and the bounded read**

```ts
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import * as path from "node:path";
import {
  DocumentOpenError,
  isStrictlyInside,
  parseDocumentClipboard,
} from "./document_path";

export const MAX_DOCUMENT_BYTES = 1024 * 1024;

export interface DocumentItem {
  readonly path: string;
  readonly content: string;
  readonly line: number | null;
  readonly column: number | null;
}

export interface DocumentFileHandle {
  readonly fd: number;
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface DocumentFileOps {
  realpath(value: string): Promise<string>;
  open(value: string, flags: number): Promise<DocumentFileHandle>;
}

export interface DocumentReader {
  open(worktree: string, clipboardText: string): Promise<DocumentItem>;
}

const LIVE_OPS: DocumentFileOps = { realpath, open };

async function readBounded(handle: DocumentFileHandle): Promise<Uint8Array> {
  const output = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
  let used = 0;
  while (used < output.length) {
    const { bytesRead } = await handle.read(output, used, output.length - used);
    if (bytesRead === 0) break;
    used += bytesRead;
  }
  if (used > MAX_DOCUMENT_BYTES) {
    throw new DocumentOpenError("too-large", "Document is larger than 1 MiB");
  }
  return output.subarray(0, used);
}

export function makeDocumentReader(ops: DocumentFileOps = LIVE_OPS): DocumentReader {
  return {
    async open(worktree, clipboardText) {
      const parsed = parseDocumentClipboard(clipboardText);
      let root: string;
      try {
        root = await ops.realpath(worktree);
      } catch (cause) {
        throw new DocumentOpenError("not-found", "Session document root is unavailable", { cause });
      }
      const lexicalRoot = path.resolve(worktree);
      const candidate = path.isAbsolute(parsed.path)
        ? path.resolve(parsed.path)
        : path.resolve(lexicalRoot, parsed.path);
      if (!isStrictlyInside(lexicalRoot, candidate) && !isStrictlyInside(root, candidate)) {
        throw new DocumentOpenError("outside-worktree", "Document is outside the session worktree");
      }

      let handle: DocumentFileHandle;
      try {
        handle = await ops.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new DocumentOpenError("not-found", "Document not found", { cause });
        if (code === "ELOOP") throw new DocumentOpenError("not-regular-file", "Document symlinks are not allowed", { cause });
        throw new DocumentOpenError("unreadable", "Document could not be opened", { cause });
      }

      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new DocumentOpenError("not-regular-file", "Document is not a regular file");
        if (stat.size > MAX_DOCUMENT_BYTES) throw new DocumentOpenError("too-large", "Document is larger than 1 MiB");
        const target = await ops.realpath(`/proc/self/fd/${handle.fd}`).catch((cause) => {
          throw new DocumentOpenError("unreadable", "Document identity could not be verified", { cause });
        });
        if (!isStrictlyInside(root, target)) {
          throw new DocumentOpenError("outside-worktree", "Document is outside the session worktree");
        }
        const targetExt = path.extname(target).toLowerCase();
        if (targetExt !== ".md" && targetExt !== ".markdown") {
          throw new DocumentOpenError("unsupported-type", "Only Markdown documents can be opened");
        }
        const bytes = await readBounded(handle);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (cause) {
          throw new DocumentOpenError("unreadable", "Document is not valid UTF-8", { cause });
        }
        return {
          path: path.relative(root, target),
          content,
          line: parsed.line,
          column: parsed.column,
        };
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}
```

Keep error messages closed as above; do not interpolate `candidate`, `root`, `target`, or `cause.message`.

- [ ] **Step 4: Add deterministic race and cleanup tests with fake ops**

Create a fake `DocumentFileOps` whose `open()` returns a handle pinned to known bytes while the later `/proc/self/fd/<fd>` resolution either reports an outside target or fails. Assert outside bytes are never returned, `read` is not called after a failed containment check, and `close` is called exactly once on success, containment failure, size failure, and decoding failure.

- [ ] **Step 5: Run the reader suite**

Run: `bun test src/ui/routes/document_reader_service_test.ts`

Expected: PASS without Docker or hostexec.

- [ ] **Step 6: Commit the secure reader**

```bash
git add src/ui/routes/document_reader_service.ts src/ui/routes/document_reader_service_test.ts
git commit -m "feat(ui): confine Markdown reads to session worktrees"
```

---

### Task 3: Document HTTP route

**Files:**
- Create: `src/ui/routes/documents.ts`
- Test: `src/ui/routes/documents_test.ts`
- Modify: `src/ui/server.ts:211-217`

**Interfaces:**
- Consumes: `DocumentReader` and `makeDocumentReader` from Task 2; `SessionUiService` plain client and `UiDataContext.sessionPaths`.
- Produces: `createDocumentRoutes(ctx, deps?)` mounted at `/api/documents/open`.

- [ ] **Step 1: Write failing Router-level tests**

Build a minimal `UiDataContext` cast containing only `sessionPaths`, and inject:

```ts
const deps = {
  findSession: async (_paths: SessionRuntimePaths, id: string) =>
    id === "sess-1" ? makeRecord({ sessionId: id, worktree: "/worktree" }) : null,
  reader: {
    open: async () => ({
      path: "docs/design.md",
      content: "# Design\n",
      line: 4,
      column: null,
    }),
  },
};
```

Assert 200 and the exact success body. Add cases for invalid JSON, arrays/null, unknown keys, unsafe/missing session IDs, empty or >4,096 clipboard text, missing session/worktree, every `DocumentOpenError.code`, and an unexpected `Error("/secret/root")`. The unexpected response must be `{ error: "Failed to open document" }` and must not contain `/secret/root`.

- [ ] **Step 2: Run the route test and confirm failure**

Run: `bun test src/ui/routes/documents_test.ts`

Expected: FAIL because `createDocumentRoutes` does not exist.

- [ ] **Step 3: Implement strict validation and local error mapping**

```ts
import type { SessionRecord, SessionRuntimePaths } from "../../sessions/store.ts";
import { makeSessionUiClient } from "../../domain/session.ts";
import type { UiDataContext } from "../data.ts";
import { json, Router } from "../router.ts";
import { DocumentOpenError, type DocumentErrorCode } from "./document_path.ts";
import { makeDocumentReader, type DocumentReader } from "./document_reader_service.ts";
import { isSafeId } from "./validate_ids.ts";

export interface DocumentRouteDeps {
  readonly findSession: (paths: SessionRuntimePaths, id: string) => Promise<SessionRecord | null>;
  readonly reader: DocumentReader;
}

const sessionClient = makeSessionUiClient();
const LIVE_DEPS: DocumentRouteDeps = {
  findSession: async (paths, id) =>
    (await sessionClient.list(paths)).find((record) => record.sessionId === id) ?? null,
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
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
    if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "sessionId" && k !== "clipboardText")) {
      return json({ error: "Invalid document request" }, 400);
    }
    const { sessionId, clipboardText } = body;
    if (typeof sessionId !== "string" || !isSafeId(sessionId)) {
      return json({ error: "Invalid sessionId format" }, 400);
    }
    if (typeof clipboardText !== "string" || clipboardText.length < 1 || clipboardText.length > 4096) {
      return json({ error: "clipboardText must be between 1 and 4096 characters" }, 400);
    }
    try {
      const session = await deps.findSession(ctx.sessionPaths, sessionId);
      if (!session?.worktree) return json({ error: "Document not found", code: "not-found" }, 404);
      return json(await deps.reader.open(session.worktree, clipboardText));
    } catch (error) {
      if (error instanceof DocumentOpenError) {
        return json({ error: error.message, code: error.code }, STATUS[error.code]);
      }
      return json({ error: "Failed to open document" }, 500);
    }
  });
  return routes;
}
```

- [ ] **Step 4: Mount the route without changing existing API route behavior**

In `src/ui/server.ts`, import `createDocumentRoutes` and add exactly one sibling mount:

```ts
app.route("/api", createApiRoutes(ctx));
app.route("/api", createDocumentRoutes(ctx));
app.route("/api", createSseRoutes(ctx));
```

- [ ] **Step 5: Run focused backend tests**

Run: `bun test src/ui/routes/document_path_test.ts src/ui/routes/document_reader_service_test.ts src/ui/routes/documents_test.ts src/ui/server_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the endpoint**

```bash
git add src/ui/routes/documents.ts src/ui/routes/documents_test.ts src/ui/server.ts
git commit -m "feat(ui): expose session-scoped document reads"
```

---

### Task 4: Frontend client and ephemeral review state

**Files:**
- Modify: `src/ui/frontend/src/api/client.ts`
- Modify: `src/ui/frontend/src/api/client_test.ts`
- Create: `src/ui/frontend/src/stores/documentReviewStore.ts`
- Test: `src/ui/frontend/src/stores/documentReviewStore_test.ts`

**Interfaces:**
- Produces: `DocumentItem`, `DocumentApiErrorCode`, `openDocument(sessionId, clipboardText)`, and `createDocumentReviewStore(deps)`.
- Consumes: the endpoint from Task 3 and Solid signals only.

- [ ] **Step 1: Write failing client tests**

Extend the existing fetch-stub pattern in `client_test.ts`. Assert `openDocument("sess-1", "docs/a.md:3")` sends:

```ts
expect(init).toMatchObject({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: "sess-1", clipboardText: "docs/a.md:3" }),
});
```

Return a document fixture and assert the typed value. Return `{ error, code: "too-large" }` with status 413 and assert the thrown `HttpError` retains both `status === 413` and `code === "too-large"`.

- [ ] **Step 2: Extend the client error and document API**

Add optional `code` to `HttpError` and have `request()` retain a string `code`
from error JSON:

```ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Inside request(), in the !res.ok branch:
const err = (await res.json().catch(() => ({ error: res.statusText }))) as {
  error?: unknown;
  code?: unknown;
};
const message = typeof err.error === "string" ? err.error : res.statusText;
const code = typeof err.code === "string" ? err.code : undefined;
throw new HttpError(res.status, message, code);
```

Then add:

```ts
export type DocumentApiErrorCode =
  | "invalid-path" | "unsupported-type" | "outside-worktree"
  | "not-found" | "not-regular-file" | "too-large" | "unreadable";

export interface DocumentItem {
  path: string;
  content: string;
  line: number | null;
  column: number | null;
}

export function openDocument(sessionId: string, clipboardText: string): Promise<DocumentItem> {
  return request<DocumentItem>("POST", "/api/documents/open", { sessionId, clipboardText });
}
```

Keep all existing `HttpError` constructor call sites source-compatible by making `code?: string` the third parameter.

- [ ] **Step 3: Write failing store tests**

Under `createRoot`, inject `readClipboard` and `openDocument` promises. Cover:

- first open sets loading then Rendered document;
- clipboard rejection leaves the current terminal/document surface unchanged and exposes a short error;
- opening a second document replaces the first and resets mode to `rendered`;
- an older slow response cannot replace a newer response;
- refresh uses the saved session/text, preserves mode, and marks prior content stale on failure;
- `close()` invalidates in-flight responses;
- `selectSession()` closes only when the agent session ID changes.

- [ ] **Step 4: Implement the review store with request generations**

```ts
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
    item: null, sessionId: null, clipboardText: null,
    mode: "rendered", loading: false, stale: false, error: null,
  };
  const [state, setState] = createSignal(initial);
  let generation = 0;

  async function request(sessionId: string, clipboardText: string, refresh: boolean) {
    const mine = ++generation;
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
      if (mine !== generation) return;
      setState({ item, sessionId, clipboardText, mode: refresh ? previous.mode : "rendered", loading: false, stale: false, error: null });
    } catch (error) {
      if (mine !== generation) return;
      setState({ ...previous, loading: false, stale: refresh && previous.item !== null, error: error instanceof Error ? error.message : "Failed to open document" });
    }
  }

  return {
    state,
    async openFromClipboard(sessionId: string) {
      try { await request(sessionId, await deps.readClipboard(), false); }
      catch { setState({ ...state(), error: "Clipboard access was denied" }); }
    },
    refresh() {
      const current = state();
      return current.sessionId && current.clipboardText
        ? request(current.sessionId, current.clipboardText, true)
        : Promise.resolve();
    },
    close() { generation++; setState(initial); },
    selectSession(id: string | null) {
      const current = state();
      if (current.sessionId !== null && current.sessionId !== id) {
        generation++;
        setState(initial);
      }
    },
    setMode(mode: DocumentMode) { setState({ ...state(), mode }); },
  };
}
```

Keep this state local to `TerminalPane`; do not add persistence or a global store.

- [ ] **Step 5: Run client/store tests**

Run: `bun test src/ui/frontend/src/api/client_test.ts src/ui/frontend/src/stores/documentReviewStore_test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the client and state owner**

```bash
git add src/ui/frontend/src/api/client.ts src/ui/frontend/src/api/client_test.ts src/ui/frontend/src/stores/documentReviewStore.ts src/ui/frontend/src/stores/documentReviewStore_test.ts
git commit -m "feat(ui): manage ephemeral document review state"
```

---

### Task 5: Safe Markdown and source view models

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `bun.nix`
- Modify: `scripts/build_ui.ts`
- Create: `src/ui/frontend/src/components/document/markdownView.ts`
- Test: `src/ui/frontend/src/components/document/markdownView_test.ts`
- Create: `src/ui/frontend/src/components/document/sourceView.ts`
- Test: `src/ui/frontend/src/components/document/sourceView_test.ts`

**Interfaces:**
- Consumes: `marked.lexer()` only; never `marked.parse()` or generated HTML.
- Produces: closed `MarkdownNode` union, `buildMarkdownView(markdown)`, `SourceLine`, and `buildSourceView(content, requestedLine)`.

- [ ] **Step 1: Install the pinned lexer dependency**

Run in an isolated worktree:

```bash
bun add marked@18.0.7
bun run bun2nix
```

Expected: `package.json`, `bun.lock`, and `bun.nix` gain Marked while all pre-existing dependency entries remain. Inspect the diff; if the active tree still contains uncommitted WebGL dependency changes, stop and resolve ownership before staging package files.

- [ ] **Step 2: Bundle Marked's license**

Add this entry to `licenseSources` in `scripts/build_ui.ts`:

```ts
{
  src: path.join(ROOT, "node_modules/marked/LICENSE.md"),
  dst: path.join(licenseDir, "marked-MIT.md"),
  label: "marked",
},
```

The existing license count assertion should increase by one automatically.

- [ ] **Step 3: Write failing safe-node tests**

Test ordinary headings, emphasis, fenced code, blockquotes, ordered/unordered/task lists, and GFM tables. For hostile input:

```ts
const nodes = buildMarkdownView(`
<script>fetch("https://evil.invalid")</script>
![secret](https://evil.invalid/pixel.png)
[safe](https://example.com/x)
[relative](./other.md)
[js](javascript:alert(1))
`);
expect(allElementTags(nodes)).not.toContain("img");
expect(allElementTags(nodes)).not.toContain("script");
expect(findLinks(nodes)).toEqual([
  { href: "https://example.com/x", target: "_blank", rel: "noopener noreferrer" },
]);
expect(allText(nodes)).toContain('<script>fetch("https://evil.invalid")</script>');
expect(allText(nodes)).toContain("Image: secret — https://evil.invalid/pixel.png");
expect(allText(nodes)).toContain("./other.md");
expect(allText(nodes)).toContain("javascript:alert(1)");
```

- [ ] **Step 4: Implement a closed safe-node transformer**

Define a union whose only element tags are:

```ts
export type SafeTag =
  | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "strong" | "em" | "del" | "code" | "pre" | "blockquote"
  | "ul" | "ol" | "li" | "table" | "thead" | "tbody" | "tr" | "th" | "td"
  | "hr" | "br" | "span";

export type MarkdownNode =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "element"; readonly tag: SafeTag; readonly children: readonly MarkdownNode[]; readonly start?: number }
  | { readonly kind: "task-marker"; readonly checked: boolean }
  | { readonly kind: "link"; readonly href: string; readonly title: string | null; readonly children: readonly MarkdownNode[] }
  | { readonly kind: "placeholder"; readonly role: "image" | "link" | "html"; readonly value: string };
```

Use `marked.lexer(markdown, { gfm: true, breaks: false })`, recursively map every known token, and make the default branch a text node containing `token.raw`. Specific security branches are:

```ts
case "html":
  return [{ kind: "placeholder", role: "html", value: token.raw }];
case "image":
  return [{ kind: "placeholder", role: "image", value: `Image: ${token.text || "(no alt text)"} — ${token.href}` }];
case "link": {
  const href = explicitHttpUrl(token.href);
  return href === null
    ? [{ kind: "placeholder", role: "link", value: `${inlineText(token.tokens)} — ${token.href}` }]
    : [{ kind: "link", href, title: token.title ?? null, children: mapInline(token.tokens) }];
}
```

Map a GFM task-list item's checkbox to `{ kind: "task-marker", checked }` before its text. The Solid renderer must turn that node into a text-only `<span aria-hidden="true">` containing `☑` or `☐`; it must not create an `<input>` or any interactive control.

`explicitHttpUrl` must require an absolute URL and `protocol === "http:" || protocol === "https:"`. Do not put language names into an unchecked class attribute; render the fence language as a text label next to the code block.

- [ ] **Step 5: Write and implement source view tests**

Tests:

```ts
expect(buildSourceView("a\nb\n", 2)).toEqual({
  lines: [
    { number: 1, text: "a", highlighted: false },
    { number: 2, text: "b", highlighted: true },
    { number: 3, text: "", highlighted: false },
  ],
  scrollLine: 2,
});
expect(buildSourceView("a\nb", 99).scrollLine).toBe(2);
expect(buildSourceView("", null).scrollLine).toBeNull();
```

Implement `buildSourceView` as a pure split/map plus clamp. Preserve trailing empty lines because Source is the exact returned text.

- [ ] **Step 6: Run the focused model tests and build**

Run:

```bash
bun test src/ui/frontend/src/components/document/markdownView_test.ts src/ui/frontend/src/components/document/sourceView_test.ts
bun run build-ui
```

Expected: tests PASS; UI build reports one JavaScript output and the license bundle count includes Marked.

- [ ] **Step 7: Commit dependency and safe models together**

```bash
git add package.json bun.lock bun.nix scripts/build_ui.ts src/ui/frontend/src/components/document/markdownView.ts src/ui/frontend/src/components/document/markdownView_test.ts src/ui/frontend/src/components/document/sourceView.ts src/ui/frontend/src/components/document/sourceView_test.ts
git commit -m "feat(ui): build a non-executable Markdown view model"
```

Reference during implementation: [Marked renderer/lexer pipeline](https://marked.js.org/using_pro) and [Marked security warning](https://marked.js.org/). The warning is why this task consumes lexer tokens and never injects Marked HTML.

---

### Task 6: Document center pane and Terminal Toolbar integration

**Files:**
- Create: `src/ui/frontend/src/components/document/MarkdownNodes.tsx`
- Create: `src/ui/frontend/src/components/document/DocumentPane.tsx`
- Create: `src/ui/frontend/src/components/document/DocumentToolbarControls.tsx`
- Create: `src/ui/frontend/src/components/document/documentToolbarView.ts`
- Test: `src/ui/frontend/src/components/document/documentToolbarView_test.ts`
- Modify: `src/ui/frontend/src/components/TerminalToolbar.tsx`
- Modify: `src/ui/frontend/src/components/TerminalPane.tsx`
- Modify: `src/ui/frontend/src/styles.css`
- Modify: `src/ui/frontend/src/styles_integration_test.ts`

**Interfaces:**
- Consumes: review store from Task 4 and safe/source models from Task 5.
- Produces: the complete user-visible review workflow in the existing center pane.

- [ ] **Step 1: Write failing toolbar view tests**

Define `describeDocumentToolbar(state)` as a pure helper and assert:

- closed + selected session: `Open doc from clipboard` enabled;
- closed + no session: open disabled;
- open: `Back to terminal`, `Open another`, `Refresh`, and Rendered/Source controls visible;
- loading: the request-triggering controls disabled and label `Opening…` or `Refreshing…`;
- stale: stale indicator visible;
- error: the closed message is returned for the shared `aria-live` output.

- [ ] **Step 2: Implement the exhaustive safe-node Solid renderer**

`MarkdownNodes.tsx` must switch on `node.kind`. For `element`, switch on the closed `SafeTag` union or use Solid's `Dynamic` with that union only. For links, emit exactly:

```tsx
<a href={node.href} title={node.title ?? undefined} target="_blank" rel="noopener noreferrer">
  <MarkdownNodes nodes={node.children} />
</a>
```

For task markers, emit a text-only `span` containing `☑` or `☐`. For placeholders, emit a styled `span` containing `node.value`. Never use `innerHTML`, `innerText`, `src`, or a dynamic tag derived from Markdown input.

- [ ] **Step 3: Implement `DocumentPane`**

Props:

```ts
interface DocumentPaneProps {
  item: () => DocumentItem;
  mode: () => DocumentMode;
  stale: () => boolean;
}
```

Rendered mode memoizes `buildMarkdownView(item().content)`. Source mode memoizes `buildSourceView(item().content, item().line)`, renders every line with a stable `data-source-line`, and uses a deferred `createEffect` to call `scrollIntoView({ block: "center" })` on the clamped target after Source becomes visible. The header shows the relative `item.path`, requested line/column, and stale state; it never shows an absolute root.

- [ ] **Step 4: Implement document toolbar controls**

Keep `TerminalToolbar` responsible for layout and its existing session-level Ack/Stop/error behavior. Delegate only document-specific buttons to `DocumentToolbarControls` with callbacks:

```ts
interface DocumentToolbarControlsProps {
  selectedSessionId: () => string | null;
  state: () => DocumentReviewState;
  onOpen: (sessionId: string) => void;
  onBack: () => void;
  onRefresh: () => void;
  onMode: (mode: DocumentMode) => void;
}
```

When closed, show `Open doc from clipboard` beside `Open shell` and `Search`. When open, replace terminal-scoped Shell/Search/Schedule/font controls with Back/Open another/Refresh/Rendered/Source; keep session identity, Ack, and Stop visible. Feed `state().error` into the existing polite error output without hiding local Ack/Shell/Stop errors.

- [ ] **Step 5: Integrate review state in `TerminalPane`**

Construct the store once:

```ts
const documents = createDocumentReviewStore({
  readClipboard: () => navigator.clipboard.readText(),
  openDocument: client.openDocument,
});
```

Import the API client namespace rather than creating a second fetch wrapper. Derive the selected agent ID from `toolbarContext().contextAgentRow?.id`, and call `documents.selectSession(id)` in a deferred effect. Toggling agent/shell for the same parent agent must not close the document.

Keep the existing terminal div mounted:

```tsx
<div
  class="terminal"
  classList={{ "terminal-document-hidden": documents.state().item !== null }}
  data-active-id={props.terminals.activeId() ?? ""}
  ref={containerRef}
>
  {/* existing terminal children unchanged */}
</div>
<Show when={documents.state().item}>
  {(item) => (
    <DocumentPane
      item={item}
      mode={() => documents.state().mode}
      stale={() => documents.state().stale}
    />
  )}
</Show>
```

Pass the document props/callbacks through `TerminalToolbar`. Do not alter `handles`, `reconcileTerminals`, `applyTerminalActions`, or `attachTerminalSession`; those are the keep-alive boundary and overlap the user's WebGL work.

- [ ] **Step 6: Add document CSS and a layout regression**

Add center-surface rules for:

- `overflow: auto` with `min-width: 0` and `min-height: 0`;
- readable prose width around 80 characters while allowing tables/code to scroll horizontally;
- visible focus states and pressed mode buttons;
- numbered source grid with highlighted requested line;
- wrapped long paths without horizontal center-pane overflow;
- raw-HTML/image/link placeholders that are visibly inert;
- `.terminal-document-hidden { display: none; }` without removing the terminal node.

Extend `styles_integration_test.ts` with a 900×600 center-pane fixture containing a long path, wide table/code block, and source rows. Assert the pane itself does not overflow the viewport and only the designated table/code scrollers have `scrollWidth > clientWidth`.

- [ ] **Step 7: Run focused frontend tests**

Run:

```bash
bun test src/ui/frontend/src/components/document/documentToolbarView_test.ts src/ui/frontend/src/stores/documentReviewStore_test.ts src/ui/frontend/src/components/document/markdownView_test.ts src/ui/frontend/src/components/document/sourceView_test.ts src/ui/frontend/src/styles_integration_test.ts
bun run build-ui
```

Expected: PASS; if Chromium is absent, only the existing guarded layout test is skipped and the unit tests still pass.

- [ ] **Step 8: Commit the UI integration**

```bash
git add src/ui/frontend/src/components/document src/ui/frontend/src/components/TerminalToolbar.tsx src/ui/frontend/src/components/TerminalPane.tsx src/ui/frontend/src/styles.css src/ui/frontend/src/styles_integration_test.ts
git commit -m "feat(ui): review clipboard Markdown beside live sessions"
```

---

### Task 7: End-to-end requirement audit and project checks

**Files:**
- Modify only files that fail the checks; do not add scope.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified feature branch ready for review.

- [ ] **Step 1: Audit the security invariants directly**

Run:

```bash
rg -n "innerHTML|<img|createElement\(['\"]img|console\.(log|warn|error).*clipboard|console\.(log|warn|error).*content" src/ui/frontend/src/components/document src/ui/routes/document* src/ui/routes/documents.ts
```

Expected: no `innerHTML`, image element creation, or document/clipboard logging. Any match must be an explanatory test string or removed.

- [ ] **Step 2: Audit spec coverage**

Manually exercise these cases against `nas ui` in a disposable session:

1. relative `.md`, absolute in-worktree `.markdown`, and `:line` open;
2. Rendered default, Source highlight, Refresh, Back, Open another;
3. session switch closes the document while agent↔shell toggle does not;
4. external image Markdown produces a placeholder and no network request;
5. raw HTML is visible as text;
6. outside path, symlink escape, invalid type, oversize, and clipboard denial show closed errors without revealing the worktree root;
7. terminal output continues while hidden and reappears with the same scrollback/connection.

Expected: every item matches the approved design. Record any environment limitation rather than weakening the check.

- [ ] **Step 3: Run standard post-change checks in nas order**

```bash
bun run fmt
bun run lint
bun run check
bun run test:unit
```

Expected: all commands PASS. Stop on the first failure, fix it with the smallest scoped change, and restart the sequence from `fmt`. Do not run `bun test`, `bun test src/`, or Docker integration lanes inside nas.

- [ ] **Step 4: Review the final diff and commit check-only fixes if any**

```bash
git status --short
git diff --check
git diff --stat HEAD~6..HEAD
```

Expected: no whitespace errors or unrelated files. If checks required code changes, commit only those files with a message that states the invariant restored; otherwise do not create an empty commit.

- [ ] **Step 5: Request final code review**

Invoke the `requesting-code-review` skill against the feature commits, with special attention to descriptor containment, error disclosure, stale async responses, and terminal keep-alive behavior. Address findings through the repository's review workflow before integration.
