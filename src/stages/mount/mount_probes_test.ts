import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ensureDevcontainerClaudeState } from "./mount_probes.ts";

test("IDE Claude state is created once and never overwritten", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-claude-"));
  try {
    const created = await ensureDevcontainerClaudeState(home);
    expect(created).toEqual({
      claudeDir: path.join(home, ".claude"),
      claudeJson: path.join(home, ".claude.json"),
    });
    expect(await readFile(created.claudeJson, "utf8")).toBe("{}\n");

    await writeFile(created.claudeJson, '{"kept":true}\n');
    await writeFile(path.join(created.claudeDir, "marker"), "");
    await ensureDevcontainerClaudeState(home);
    expect(await readFile(created.claudeJson, "utf8")).toBe('{"kept":true}\n');
    expect(await readFile(path.join(created.claudeDir, "marker"), "utf8")).toBe(
      "",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
