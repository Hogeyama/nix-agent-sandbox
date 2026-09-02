# Clipboard Markdown Review in nas UI

**Status:** Approved

**Date:** 2026-09-02

## Purpose

AI agents often finish by printing the path of a Markdown document they wrote.
Reading that document currently requires leaving nas UI, locating the file in
the session worktree, and opening another application. nas UI should turn a
clipboard containing that path into a focused, human-readable document view
with one explicit action.

This is a human review surface, not an AI review workflow. It does not infer
which files an agent changed, annotate documents, or feed review decisions back
to the agent.

## Scope

The first version supports `.md` and `.markdown` files belonging to the
currently selected live session. It accepts both paths relative to the session
worktree and absolute paths whose resolved file is inside that worktree.

The feature deliberately excludes:

- file discovery and directory browsing;
- attribution of changes to an agent;
- HTML preview;
- automatic image loading;
- file watching and automatic refresh;
- inline comments, edits, or review decisions; and
- completed sessions whose runtime session record no longer exists.

HTML preview is especially out of scope. nas isolates untrusted agents, and
executing or interpreting agent-authored HTML in the host UI would weaken that
boundary. Markdown raw HTML is displayed as text rather than interpreted.

## User Experience

### Opening a document

The existing terminal toolbar—the row containing actions such as `Open shell`
and `Search`—gains an `Open doc from clipboard` button. The button is enabled
only when an agent session is selected. Its click is the user gesture that
authorizes the browser Clipboard API read.

The flow is:

1. The user selects a session.
2. The user copies a Markdown path produced by the agent.
3. The user clicks `Open doc from clipboard`.
4. The frontend reads the clipboard and submits its text with the selected
   session ID.
5. The daemon validates and reads the file.
6. On success, the center pane switches from the terminal to the document.

The Sessions and Pending panes remain visible. The terminal component stays
mounted but hidden, preserving its xterm instance and WebSocket. The document
toolbar provides `Back to terminal`, `Refresh`, and a `Rendered` / `Source`
toggle.

Opening another clipboard path while a document is visible replaces the
current document. Selecting a different session closes the document and shows
that session's terminal. Document state is ephemeral and is not restored after
a page reload.

### Clipboard path syntax

The parser trims surrounding whitespace and accepts one path, optionally
wrapped in matching backticks, single quotes, or double quotes. Multiline input
and unmatched wrappers are rejected instead of guessing.

Supported location suffixes are:

```text
docs/design.md:42
docs/design.md:42:7
/absolute/session/path/docs/design.md#L42
```

Line and column numbers are positive decimal safe integers. A location suffix
is recognized only when the remaining value ends in `.md` or `.markdown`, so
ordinary colons elsewhere in a Linux path are not silently reinterpreted.
`file://` URLs, line ranges, and Windows paths are not supported.

Relative paths use the selected session worktree as their base. Absolute paths
are accepted only when the opened file resolves inside the same worktree.

### Rendered view

Rendered view is the default, including when a line suffix is present. It
supports the GitHub-Flavored Markdown constructs needed for typical technical
documents: headings, lists, task lists, tables, blockquotes, fenced code, and
inline code.

Rendering follows these rules:

- Raw HTML is escaped and shown as text.
- Image syntax becomes a non-loading placeholder containing its alt text and
  source path. It never creates an `img` request.
- Only explicit `http:` and `https:` links are clickable. They open in a new
  tab with `noopener` and `noreferrer`.
- Relative links and all other URL schemes are displayed but are not
  navigable in the first version.

The implementation must not insert unsanitized parser output with
`innerHTML`. It may use a parser library, but rendered elements must be created
from a token tree or passed through a sanitizer configured to enforce the
rules above.

### Source view and locations

Source view presents the exact returned UTF-8 text with line numbers. When the
clipboard path includes a line number, switching to Source scrolls that line
into view and highlights it. A column suffix is retained in the view model for
future precision but does not add column highlighting in the first version.
Out-of-range line and column values do not fail the open request; Source clamps
the scroll target to the available lines while continuing to show the supplied
location in the toolbar.

`Refresh` repeats the daemon request with the same original clipboard text and
session ID. It is explicit so reading a document does not add filesystem
watchers or background traffic.

## Architecture

### Frontend components

The frontend adds three focused units:

- A narrow browser adapter that reads `navigator.clipboard` only from the
  toolbar click handler, plus pure helpers that shape the request and errors.
- A document view state owner containing the selected session ID, original
  clipboard text, returned document, display mode, and request status.
- A center-pane document component responsible for Rendered and Source views.

Document state belongs alongside the terminal workspace state rather than in a
session or audit store. It has one consumer and is intentionally discarded on
session change. Pure Markdown-to-view-model and source-line helpers remain
separate from Solid components so they can be tested without a browser runtime.

The existing center pane uses the same keep-alive approach as the workspace
and Settings route: CSS visibility switches which surface is shown while the
terminal remains mounted. Opening or closing a document must not dispose or
reattach a terminal.

### HTTP API

The daemon exposes one endpoint:

```http
POST /api/documents/open
Content-Type: application/json

{
  "sessionId": "...",
  "clipboardText": "docs/design.md:42"
}
```

The request body is used instead of a path URL segment so slashes, fragments,
and location suffixes do not participate in routing or appear in ordinary
access paths. The request schema reuses the existing 128-character safe
session-ID rule, limits `clipboardText` to 4,096 characters, and rejects
unknown or malformed fields.

The successful response is:

```json
{
  "path": "docs/design.md",
  "content": "# Design\n...",
  "line": 42,
  "column": null
}
```

`path` is a normalized worktree-relative display path. The API never returns
the worktree root or another host path. It returns UTF-8 JSON only; invalid
UTF-8 is rejected rather than replaced lossily.

The route resolves the session through the existing session service. The
security-sensitive path parsing and file-descriptor read live behind a narrow,
UI-route-specific document reader service under `src/ui/routes/`, not in the
route handler and not in the shared L2 domain layer. There is only one UI
caller and no CLI consumer, so a shared domain service would be premature.

### File access boundary

The daemon must treat the clipboard path and the session worktree as separate
trust inputs. A lexical `startsWith` check or `realpath` followed by a pathname
read is insufficient because an agent can create symlinks and race pathname
resolution.

The reader uses this invariant-preserving sequence on Linux:

1. Resolve the session record's worktree to its canonical root.
2. Parse the location suffix and construct the candidate pathname.
3. Open the candidate read-only with `O_NOFOLLOW` so the final component cannot
   be a symlink.
4. Use the opened descriptor to verify that the target is a regular file.
5. Resolve the descriptor's pinned target through `/proc/self/fd/<fd>` and
   verify with `path.relative` that it is strictly beneath the canonical root.
6. Read at most 1 MiB plus one byte through that same descriptor. Reject the
   file if the extra byte exists, including when it grows after the metadata
   check.
7. Decode with a fatal UTF-8 decoder and close the descriptor in all paths.

The descriptor pins the object that is checked and read, removing the
check/read pathname race. Intermediate symlinks that resolve outside the
worktree fail the descriptor-target containment check. A missing `/proc`
descriptor view fails closed.

Only regular files with a case-insensitive `.md` or `.markdown` suffix are
accepted. The suffix is checked against the normalized display path and the
pinned target. Directories, devices, FIFOs, sockets, final symlinks, and files
larger than 1 MiB are rejected.

Document bytes and clipboard text must not be written to logs, audit storage,
history storage, SSE events, notifications, or session records. The API is
host-UI-only and adds no mount, socket, or endpoint visible inside the agent
container.

## Errors

Clipboard permission failures happen entirely in the frontend and produce a
short toolbar-adjacent message. A failed open leaves the current center surface
unchanged: the terminal remains visible, or an already open document remains
open.

The daemon returns stable error codes so the frontend can distinguish:

- `invalid-path` — empty, multiline, malformed, or unsupported syntax;
- `unsupported-type` — not `.md` or `.markdown`;
- `outside-worktree` — the pinned target is not inside the selected worktree;
- `not-found` — session or file no longer exists;
- `not-regular-file` — target is not an allowed regular file;
- `too-large` — target exceeds 1 MiB; and
- `unreadable` — permission, invalid UTF-8, or another read failure.

Messages shown to the user include the submitted display path when safe, but
never include the canonical worktree root, `/proc` path, file contents, or raw
filesystem exception. Unexpected failures use the existing route error wrapper
and a generic message.

Refresh errors leave the previous content visible and mark it stale. A
successful refresh clears the stale marker and preserves the Rendered / Source
selection.

## Testing

### Pure unit tests

- Parse relative and absolute path forms, wrappers, `:line`, `:line:column`,
  and `#Lline`.
- Reject multiline text, unmatched wrappers, invalid numbers, unsupported
  extensions, ranges, and ambiguous suffixes.
- Verify worktree-relative display paths and component-aware containment.
- Verify Markdown raw HTML escaping, image placeholders, safe external links,
  and rejection of other link schemes.
- Verify source scrolling, highlighting, and out-of-range clamping.

### Document reader tests

- Read a normal Markdown file through the live reader.
- Accept an absolute path only when its pinned target is inside the worktree.
- Reject final and intermediate symlinks that escape the worktree.
- Replace a checked pathname during the test and prove the reader cannot return
  bytes from the replacement outside the worktree.
- Reject non-regular files, invalid UTF-8, and files over 1 MiB, including a
  file that grows while being read.
- Assert descriptors close on success and every failure branch.
- Assert errors and response values never expose the canonical root.

### Route and client tests

- Cover success, schema rejection, missing sessions, and every stable error
  mapping.
- Verify session IDs use the existing safe-ID validation.
- Verify unknown JSON fields and oversized clipboard strings are rejected.
- Verify the response contains no absolute host path.

### Frontend tests

- Exercise Clipboard API success and permission rejection from the toolbar
  action.
- Verify open, replacement, refresh, stale-on-refresh-error, and back actions.
- Verify Rendered / Source switching and location scrolling.
- Verify changing sessions closes the document.
- Verify the terminal component remains mounted and its connection is not
  recreated while the document is shown.
- Verify raw HTML and images produce no active DOM elements or network loads.

The implementation is complete only when the repository's formatting, lint,
type checking, unit tests, and relevant UI/API integration tests all pass.
