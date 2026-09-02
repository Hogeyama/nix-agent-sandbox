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
    throw new DocumentOpenError(
      "invalid-path",
      "Clipboard must contain one path",
    );
  }
  const wrappers = new Set(["`", "'", '"']);
  if (wrappers.has(value[0] ?? "")) {
    if (value.at(-1) !== value[0] || value.length < 3) {
      throw new DocumentOpenError(
        "invalid-path",
        "Document path has unmatched quotes",
      );
    }
    value = value.slice(1, -1).trim();
  } else if (wrappers.has(value.at(-1) ?? "")) {
    throw new DocumentOpenError(
      "invalid-path",
      "Document path has unmatched quotes",
    );
  }
  if (value === "") {
    throw new DocumentOpenError(
      "invalid-path",
      "Clipboard must contain one path",
    );
  }
  if (
    /^file:\/\//i.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\")
  ) {
    throw new DocumentOpenError(
      "invalid-path",
      "Document path syntax is not supported",
    );
  }

  let line: number | null = null;
  let column: number | null = null;
  const match = LOCATION_HASH.exec(value) ?? LOCATION_COLON.exec(value);
  if (match) {
    const candidate = value.slice(0, match.index);
    if (hasMarkdownExtension(candidate)) {
      value = candidate;
      line = parsePositiveSafe(match[1] ?? "");
      column = match[2] === undefined ? null : parsePositiveSafe(match[2]);
    }
  }
  if (
    line === null &&
    !hasMarkdownExtension(value) &&
    /(?:^|\/)[^/]*\.(?:md|markdown)(?::\d|#L)[^/]*$/i.test(value)
  ) {
    throw new DocumentOpenError("invalid-path", "Invalid document location");
  }
  if (!hasMarkdownExtension(value)) {
    throw new DocumentOpenError(
      "unsupported-type",
      "Only Markdown documents can be opened",
    );
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
