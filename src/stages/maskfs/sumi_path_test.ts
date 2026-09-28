import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSumiBinPath } from "./sumi_path.ts";

describe("resolveSumiBinPath", () => {
  test("returns null when binary does not exist", async () => {
    const result = await resolveSumiBinPath({
      assetDir: "/nonexistent/asset/dir",
    });
    expect(result).toBeNull();
  });

  test("resolves sumi/sumi under the asset directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-asset-"));
    try {
      fs.mkdirSync(path.join(dir, "sumi"));
      fs.writeFileSync(path.join(dir, "sumi", "sumi"), "");
      expect(await resolveSumiBinPath({ assetDir: dir })).toBe(
        path.join(dir, "sumi", "sumi"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
