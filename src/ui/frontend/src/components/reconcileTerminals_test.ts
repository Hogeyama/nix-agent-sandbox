/**
 * Pin the keep-alive terminal lifecycle reducer.
 *
 * `TerminalPane`'s effect dispatches the result of `reconcileTerminals`
 * to mount/show/hide/dispose xterm handles. A regression in the reducer
 * (e.g. emitting `dispose` for a still-live but inactive session) would
 * silently drop scrollback and reset the dtach socket on every switch,
 * so each transition gets its own pinned case below.
 */

import { describe, expect, test } from "bun:test";
import { reconcileTerminals } from "./reconcileTerminals";

describe("reconcileTerminals", () => {
  test("no active and nothing mounted yields no actions", () => {
    expect(reconcileTerminals(null, null, new Set(), new Set())).toEqual([]);
  });

  test("activating from null mounts and shows the new id", () => {
    expect(reconcileTerminals(null, "a", new Set(["a"]), new Set())).toEqual([
      { type: "mount", sessionId: "a" },
      { type: "show", sessionId: "a" },
    ]);
  });

  test("inactive but live id is hidden, never disposed", () => {
    expect(
      reconcileTerminals("a", "b", new Set(["a", "b"]), new Set(["a", "b"])),
    ).toEqual([
      { type: "hide", sessionId: "a" },
      { type: "show", sessionId: "b" },
    ]);
  });

  test("swapping to an unmounted live id mounts it after hiding the previous", () => {
    expect(
      reconcileTerminals("a", "b", new Set(["a", "b"]), new Set(["a"])),
    ).toEqual([
      { type: "hide", sessionId: "a" },
      { type: "mount", sessionId: "b" },
      { type: "show", sessionId: "b" },
    ]);
  });

  test("a session that vanished from live is disposed, not hidden", () => {
    expect(
      reconcileTerminals("a", "b", new Set(["b"]), new Set(["a"])),
    ).toEqual([
      { type: "dispose", sessionId: "a" },
      { type: "mount", sessionId: "b" },
      { type: "show", sessionId: "b" },
    ]);
  });

  test("switching back to a previously-mounted id only shows it", () => {
    expect(
      reconcileTerminals("b", "a", new Set(["a", "b"]), new Set(["a", "b"])),
    ).toEqual([
      { type: "hide", sessionId: "b" },
      { type: "show", sessionId: "a" },
    ]);
  });

  test("an unrelated snapshot change leaves the active view stable", () => {
    expect(
      reconcileTerminals("a", "a", new Set(["a", "c"]), new Set(["a"])),
    ).toEqual([]);
  });

  test("clearing the active id while sessions vanish disposes every mounted handle", () => {
    expect(
      reconcileTerminals("a", null, new Set(), new Set(["a", "b"])),
    ).toEqual([
      { type: "dispose", sessionId: "a" },
      { type: "dispose", sessionId: "b" },
    ]);
  });
});
