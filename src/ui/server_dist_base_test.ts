/**
 * Pin the contract that {@link resolveDistBase} deterministically returns
 * the `dist-next/` directory.
 *
 * The daemon serves a single UI build, and this test guards against any
 * regression that would re-introduce a branch (env-driven, build-flag,
 * etc.) flipping the served tree to a different directory.
 */

import { describe, expect, test } from "bun:test";
import { resolveDistBase } from "./server.ts";

describe("resolveDistBase", () => {
  test("returns the dist-next directory", () => {
    const distBase = resolveDistBase();
    expect(typeof distBase).toBe("string");
    expect(distBase.includes("dist-next")).toBe(true);
  });
});
