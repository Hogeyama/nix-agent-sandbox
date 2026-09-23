import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinsFromLock, pinsFromSource, verifyArchives } from "./bun_npm.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

test("selects exact Linux x64 and arm64 archives from Bun's lock", () => {
  const lock = `{
    "workspaces": {"": {"name": "bun", "version": "1.4.2"}},
    "packages": {
      "@scope/core": ["@scope/core@1.2.3", "", {}, "sha512-${"A".repeat(86)}=="],
      "@scope/linux-x64": ["@scope/linux-x64@1.0.0", "", {"os":"linux","cpu":"x64"}, "sha512-${"B".repeat(86)}=="],
      "@scope/linux-arm64": ["@scope/linux-arm64@1.0.0", "", {"os":"linux","cpu":"arm64"}, "sha512-${"C".repeat(86)}=="],
      "@scope/win32": ["@scope/win32@1.0.0", "", {"os":"win32"}, "sha512-${"D".repeat(86)}=="],
      "bun-types": ["bun-types@workspace:packages/bun-types"],
    },
  }`;
  const pins = pinsFromLock(lock, "1.4.2");
  expect(pins.packages.map((p) => p.name)).toEqual([
    "@scope/core",
    "@scope/linux-arm64",
    "@scope/linux-x64",
  ]);
  expect(pins.packages[0]?.url).toBe(
    "https://registry.npmjs.org/@scope/core/-/core-1.2.3.tgz",
  );
});

test("rejects changed source archive bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-bun-npm-"));
  temporary.push(dir);
  const bytes = Buffer.from("original archive bytes");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const lock = JSON.stringify({
    workspaces: { "": { name: "bun", version: "1.4.2" } },
    packages: { example: ["example@1.0.0", "", {}, integrity] },
  });
  await mkdir(join(dir, "packages/bun-error"), { recursive: true });
  await mkdir(join(dir, "src/node-fallbacks"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ version: "1.4.2" }),
  );
  await writeFile(join(dir, "bun.lock"), lock);
  await writeFile(
    join(dir, "packages/bun-error/bun.lock"),
    JSON.stringify({ packages: {} }),
  );
  await writeFile(
    join(dir, "src/node-fallbacks/bun.lock"),
    JSON.stringify({ packages: {} }),
  );
  const pins = await pinsFromSource(dir);
  const first = pins.packages.at(0);
  if (!first) throw new Error("expected one pinned package");
  const archive = join(dir, first.archive);
  await writeFile(archive, bytes);
  await verifyArchives(dir, pins, dir);
  await writeFile(archive, "changed archive bytes");
  await expect(verifyArchives(dir, pins, dir)).rejects.toThrow("integrity");
  expect(await readFile(archive, "utf8")).toBe("changed archive bytes");
});
