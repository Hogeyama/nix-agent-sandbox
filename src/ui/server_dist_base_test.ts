/**
 * Pin the `NAS_UI_NEXT` routing contract for {@link resolveDistBase}.
 *
 * Only the literal string `"1"` flips the daemon to the Solid frontend
 * under `dist-next/` (`mode: "next"`); any other value (unset, `"0"`,
 * `"true"`, etc.) resolves to the classic Preact `dist/` tree
 * (`mode: "classic"`). Asserting `{ distBase, mode }` together prevents
 * the path and the startup-log mode label from drifting against one
 * another, and locks out an ambiguous-truthy regression
 * (e.g. `Boolean(env.NAS_UI_NEXT)`) from silently swapping the served UI.
 */

import { describe, expect, test } from "bun:test";
import { resolveDistBase } from "./server.ts";

describe("resolveDistBase", () => {
  test("env unset → classic ui/dist", () => {
    const { distBase, mode } = resolveDistBase({});
    expect(distBase.includes("dist-next")).toBe(false);
    expect(distBase.endsWith("/dist") || distBase.endsWith("/dist/")).toBe(
      true,
    );
    expect(mode).toBe("classic");
  });

  test('NAS_UI_NEXT="1" → ui/dist-next', () => {
    const { distBase, mode } = resolveDistBase({ NAS_UI_NEXT: "1" });
    expect(distBase.includes("dist-next")).toBe(true);
    expect(mode).toBe("next");
  });

  test('NAS_UI_NEXT="0" → classic ui/dist', () => {
    const { distBase, mode } = resolveDistBase({ NAS_UI_NEXT: "0" });
    expect(distBase.includes("dist-next")).toBe(false);
    expect(mode).toBe("classic");
  });

  test('NAS_UI_NEXT="true" → classic ui/dist (strict "1" match)', () => {
    const { distBase, mode } = resolveDistBase({ NAS_UI_NEXT: "true" });
    expect(distBase.includes("dist-next")).toBe(false);
    expect(mode).toBe("classic");
  });
});
