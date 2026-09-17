import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_SETTINGS_FILES,
  existingSettingsFiles,
  settingsMountArgs,
  settingsMountSpecs,
} from "./settings_protection.ts";

async function withTempStateDir(
  fn: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "nas-agent-state-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

test("existingSettingsFiles: reports only the files that exist", async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, "settings.json"), "{}");
    expect(existingSettingsFiles(stateDir, CLAUDE_SETTINGS_FILES)).toEqual([
      "settings.json",
    ]);
  });
});

test("existingSettingsFiles: an absent state directory protects nothing", () => {
  expect(
    existingSettingsFiles("/nonexistent/nas-test/.claude", ["settings.json"]),
  ).toEqual([]);
});

// Binding a path that is not a regular file would hand Docker a directory to
// mount read-only, which hides whatever the agent later writes beneath it.
test("existingSettingsFiles: skips a name taken by a directory", async () => {
  await withTempStateDir(async (stateDir) => {
    await mkdir(path.join(stateDir, "settings.json"));
    expect(existingSettingsFiles(stateDir, ["settings.json"])).toEqual([]);
  });
});

test("settingsMountArgs: pairs each file with a read-only bind mount", () => {
  expect(
    settingsMountArgs("/home/host/.claude", "/home/nas/.claude", [
      "settings.json",
      "settings.local.json",
    ]),
  ).toEqual([
    "-v",
    "/home/host/.claude/settings.json:/home/nas/.claude/settings.json:ro",
    "-v",
    "/home/host/.claude/settings.local.json:/home/nas/.claude/settings.local.json:ro",
  ]);
});

test("settingsMountSpecs: keeps host paths structured and read-only", () => {
  expect(
    settingsMountSpecs("/state:$x/claude", "/home/nas/.claude", [
      "settings.json",
    ]),
  ).toEqual([
    {
      source: "/state:$x/claude/settings.json",
      target: "/home/nas/.claude/settings.json",
      readOnly: true,
    },
  ]);
});
