/**
 * Pin the {@link preloadAssets} contract that the assets directory may
 * contain nested subdirectories (e.g. `assets/fonts/` for self-hosted
 * woff2). A flat readdir + readFile loop crashes with EISDIR on a
 * directory entry; this test fails loudly if that regression returns.
 *
 * Also pins:
 * - missing distBase / missing assets dir → empty files map, no throw
 * - non-ENOENT errors are re-raised (we do not silently swallow IO failures)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { preloadAssets } from "./server.ts";

describe("preloadAssets", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "nas-preload-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test("loads files from nested subdirectories under assets/", async () => {
    const distBase = path.join(baseDir, "dist-flat-and-nested");
    await mkdir(path.join(distBase, "assets", "fonts"), { recursive: true });
    await writeFile(path.join(distBase, "index.html"), "<html />");
    await writeFile(path.join(distBase, "assets", "main.js"), "console.log(1)");
    await writeFile(path.join(distBase, "assets", "main.css"), "body{}");
    await writeFile(
      path.join(distBase, "assets", "fonts", "geist-mono-latin.woff2"),
      "fake-woff2-bytes",
    );

    const result = await preloadAssets(distBase);

    expect(result.indexHtmlTemplate).toBe("<html />");
    expect([...result.files.keys()].sort()).toEqual([
      "/assets/fonts/geist-mono-latin.woff2",
      "/assets/main.css",
      "/assets/main.js",
    ]);

    const fontBlob = result.files.get("/assets/fonts/geist-mono-latin.woff2");
    expect(fontBlob).toBeDefined();
    expect(fontBlob?.type).toBe("application/octet-stream");
    expect(await fontBlob?.text()).toBe("fake-woff2-bytes");

    const cssBlob = result.files.get("/assets/main.css");
    expect(cssBlob?.type).toBe("text/css; charset=utf-8");
  });

  test("missing distBase → empty assets, no throw", async () => {
    const result = await preloadAssets(path.join(baseDir, "does-not-exist"));
    expect(result.indexHtmlTemplate).toBeNull();
    expect(result.files.size).toBe(0);
  });

  test("missing assets dir → empty files map but index still loads", async () => {
    const distBase = path.join(baseDir, "dist-no-assets");
    await mkdir(distBase, { recursive: true });
    await writeFile(path.join(distBase, "index.html"), "<html />");

    const result = await preloadAssets(distBase);

    expect(result.indexHtmlTemplate).toBe("<html />");
    expect(result.files.size).toBe(0);
  });

  test("empty assets dir → empty files map", async () => {
    const distBase = path.join(baseDir, "dist-empty-assets");
    await mkdir(path.join(distBase, "assets"), { recursive: true });
    await writeFile(path.join(distBase, "index.html"), "<html />");

    const result = await preloadAssets(distBase);

    expect(result.files.size).toBe(0);
  });

  test("deeply nested subdirectories are traversed", async () => {
    const distBase = path.join(baseDir, "dist-deep");
    await mkdir(path.join(distBase, "assets", "a", "b", "c"), {
      recursive: true,
    });
    await writeFile(
      path.join(distBase, "assets", "a", "b", "c", "deep.svg"),
      "<svg/>",
    );

    const result = await preloadAssets(distBase);
    expect([...result.files.keys()]).toEqual(["/assets/a/b/c/deep.svg"]);
    expect(result.files.get("/assets/a/b/c/deep.svg")?.type).toBe(
      "image/svg+xml",
    );
  });
});
