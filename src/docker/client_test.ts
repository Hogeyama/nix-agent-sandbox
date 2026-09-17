import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EMBEDDED_ASSET_NAMES, runDockerCommand } from "./client.ts";

test("bounded Docker command kills a wedged client at its deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-docker-timeout-"));
  const script = path.join(root, "wedged.sh");
  await writeFile(script, "trap '' TERM\nwhile :; do sleep 1; done\n");
  const startedAt = Date.now();
  try {
    await expect(
      runDockerCommand([script], {
        executable: "/bin/sh",
        timeoutMs: 30,
      }),
    ).rejects.toThrow("docker command timed out after 30ms");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every file the Dockerfile copies is part of the image hash", async () => {
  // The hash of these files is the image's identity. A COPY source missing
  // from the list lets a changed image keep an old tag; a listed file missing
  // from the packaged assets breaks every profile at startup.
  const embedDir = path.join(import.meta.dir, "embed");
  const dockerfile = await readFile(path.join(embedDir, "Dockerfile"), "utf8");
  const copied = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    const match = /^COPY\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    // COPY may name several sources before its destination.
    for (const source of match[1].trim().split(/\s+/).slice(0, -1))
      copied.add(source);
  }
  expect(copied.size).toBeGreaterThan(0);
  const hashed = new Set<string>(EMBEDDED_ASSET_NAMES);
  expect([...copied].filter((name) => !hashed.has(name))).toEqual([]);

  for (const name of EMBEDDED_ASSET_NAMES)
    expect(await stat(path.join(embedDir, name))).toBeDefined();
});
