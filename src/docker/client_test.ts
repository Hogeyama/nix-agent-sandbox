import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runDockerCommand } from "./client.ts";

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
