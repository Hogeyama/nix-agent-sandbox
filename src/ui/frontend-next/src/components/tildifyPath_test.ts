import { describe, expect, test } from "bun:test";
import { tildifyPath } from "./tildifyPath";

describe("tildifyPath", () => {
  test("shortens a path strictly under home to ~/...", () => {
    expect(tildifyPath("/home/foo/repo", "/home/foo")).toBe("~/repo");
  });

  test("collapses path === home to a bare ~", () => {
    expect(tildifyPath("/home/foo", "/home/foo")).toBe("~");
  });

  test("leaves paths outside home untouched", () => {
    expect(tildifyPath("/var/log", "/home/foo")).toBe("/var/log");
  });

  test("does not false-match when home is a string prefix but not a path prefix", () => {
    // Boundary guard: `/home/foobar` must not become `~bar` just because
    // it shares the literal prefix `/home/foo`. The function inspects
    // the character after `home` and only shortens when it is `/`.
    expect(tildifyPath("/home/foobar", "/home/foo")).toBe("/home/foobar");
  });

  test("returns null when path is null", () => {
    expect(tildifyPath(null, "/home/foo")).toBeNull();
  });

  test("returns the path unchanged when home is null", () => {
    expect(tildifyPath("/home/foo/x", null)).toBe("/home/foo/x");
  });

  test("returns the path unchanged when home is the empty string", () => {
    expect(tildifyPath("/home/foo/x", "")).toBe("/home/foo/x");
  });

  test("normalizes a trailing slash on home and on path equality", () => {
    // A shell that exports `HOME=/home/foo/` (trailing slash) must still
    // yield `~` when the path is the home directory itself.
    expect(tildifyPath("/home/foo/", "/home/foo/")).toBe("~");
  });

  test("normalizes a trailing slash on home when shortening a sub-path", () => {
    expect(tildifyPath("/home/foo/repo", "/home/foo/")).toBe("~/repo");
  });

  test("treats home === '/' as unknown and leaves absolute paths untouched", () => {
    // The `home === "/"` defence prevents `/etc/hosts` from collapsing
    // to `~/etc/hosts` after trailing-slash normalization strips the
    // sole `/`, leaving an empty `normalizedHome` that would otherwise
    // match every absolute path. Pin the branch so a future refactor
    // that drops the empty-home guard surfaces here.
    expect(tildifyPath("/etc/hosts", "/")).toBe("/etc/hosts");
    expect(tildifyPath("/", "/")).toBe("/");
  });

  test("preserves a trailing slash on path when shortening a sub-path", () => {
    // Only `home` is normalized for trailing slashes; the `path` side
    // is sliced raw so a caller that passes `"/home/foo/repo/"` gets
    // `"~/repo/"` back, with the trailing slash intact. Pin the
    // current behaviour so a future refactor that also normalizes
    // `path` surfaces here as a contract change.
    expect(tildifyPath("/home/foo/repo/", "/home/foo")).toBe("~/repo/");
  });
});
