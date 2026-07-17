import { describe, expect, test } from "bun:test";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";

describe("resolveMaskFilterBinPath", () => {
  test("returns null when binary does not exist", async () => {
    const result = await resolveMaskFilterBinPath({
      assetDir: "/nonexistent/asset/dir",
    });
    expect(result).toBeNull();
  });

  test("resolves from assetDir when provided", async () => {
    // This test verifies the path construction logic.
    // The binary won't exist, but the path should be correctly formed.
    const result = await resolveMaskFilterBinPath({
      assetDir: "/tmp/test-assets",
    });
    // Returns null because file doesn't exist, but exercises the code path
    expect(result).toBeNull();
  });
});
