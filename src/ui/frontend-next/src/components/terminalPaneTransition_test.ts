/**
 * Pin the four transition outcomes plus the "same id" idempotence case.
 *
 * `TerminalPane`'s `createEffect` body delegates to `pickTerminalAction`
 * so a regression that, say, mounts on every effect re-run would surface
 * here rather than as a leaked WebSocket in the running UI.
 */

import { describe, expect, test } from "bun:test";
import { pickTerminalAction } from "./terminalPaneTransition";

describe("pickTerminalAction", () => {
  test("null → null is a noop", () => {
    expect(pickTerminalAction(null, null)).toBe("noop");
  });

  test("null → id is a mount", () => {
    expect(pickTerminalAction(null, "s1")).toBe("mount");
  });

  test("id → null is an unmount", () => {
    expect(pickTerminalAction("s1", null)).toBe("unmount");
  });

  test("id → other id is a remount", () => {
    expect(pickTerminalAction("s1", "s2")).toBe("remount");
  });

  test("same id on both sides is a noop", () => {
    expect(pickTerminalAction("s1", "s1")).toBe("noop");
  });
});
