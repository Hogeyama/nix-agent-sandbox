import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./load.ts";

test("noninteractive launch fails before implicit setup or legacy prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-config-acp-"));
  try {
    await expect(
      loadConfig({ startDir: dir, nonInteractive: true }),
    ).rejects.toThrow("nas config init");
    await writeFile(join(dir, ".agent-sandbox.yml"), "profiles: {}\n");
    await expect(
      loadConfig({ startDir: dir, nonInteractive: true }),
    ).rejects.toThrow("nas config migrate yml2pkl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
