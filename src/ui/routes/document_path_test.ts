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
    [
      "'/repo/docs/design.markdown:42:7'",
      { path: "/repo/docs/design.markdown", line: 42, column: 7 },
    ],
    [
      '"/repo/docs/design.md#L9"',
      { path: "/repo/docs/design.md", line: 9, column: null },
    ],
    [" DOCS/DESIGN.MD ", { path: "DOCS/DESIGN.MD", line: null, column: null }],
    [
      "` docs/design.md:42 `",
      { path: "docs/design.md", line: 42, column: null },
    ],
    [
      "docs/changelog:2026.md:42",
      { path: "docs/changelog:2026.md", line: 42, column: null },
    ],
    [
      "notes.md:backup.md",
      { path: "notes.md:backup.md", line: null, column: null },
    ],
    [
      "docs/archive.md:old/readme.md",
      { path: "docs/archive.md:old/readme.md", line: null, column: null },
    ],
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
    "C:a.md",
    "\\\\server\\share\\a.md",
    "docs\\a.md",
    `a.md:${Number.MAX_SAFE_INTEGER + 1}`,
    "a.md`",
    "'a.md\"",
  ])("rejects %s", (raw) => {
    expect(() => parseDocumentClipboard(raw)).toThrow(DocumentOpenError);
  });

  test.each([
    "a.md:0",
    "a.md:1:0",
    "a.md#L1-L2",
    `a.md:${Number.MAX_SAFE_INTEGER + 1}`,
  ])("reports invalid-path for malformed location %s", (raw) => {
    try {
      parseDocumentClipboard(raw);
      throw new Error("expected parseDocumentClipboard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentOpenError);
      expect((error as DocumentOpenError).code).toBe("invalid-path");
    }
  });

  test("reports unsupported-type for a genuine non-Markdown path", () => {
    try {
      parseDocumentClipboard("notes.txt");
      throw new Error("expected parseDocumentClipboard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentOpenError);
      expect((error as DocumentOpenError).code).toBe("unsupported-type");
    }
  });

  test("reports unsupported-type when an earlier component contains Markdown-like text", () => {
    try {
      parseDocumentClipboard("docs/archive.md:old/readme.txt");
      throw new Error("expected parseDocumentClipboard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentOpenError);
      expect((error as DocumentOpenError).code).toBe("unsupported-type");
    }
  });

  test("reports unsupported-type for an ordinary colon-containing non-Markdown path", () => {
    try {
      parseDocumentClipboard("notes.md:backup.txt");
      throw new Error("expected parseDocumentClipboard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentOpenError);
      expect((error as DocumentOpenError).code).toBe("unsupported-type");
    }
  });

  test.each([
    "``",
    "'   '",
    '" \t "',
  ])("reports invalid-path for an empty wrapped value %s", (raw) => {
    try {
      parseDocumentClipboard(raw);
      throw new Error("expected parseDocumentClipboard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentOpenError);
      expect((error as DocumentOpenError).code).toBe("invalid-path");
    }
  });
});

test("isStrictlyInside is component-aware", () => {
  expect(isStrictlyInside("/repo/wt", "/repo/wt/docs/a.md")).toBe(true);
  expect(isStrictlyInside("/repo/wt", "/repo/wt")).toBe(false);
  expect(isStrictlyInside("/repo/wt", "/repo/wt-other/a.md")).toBe(false);
  expect(isStrictlyInside("/repo/wt", "/repo/secret.md")).toBe(false);
});
