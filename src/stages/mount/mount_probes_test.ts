import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ensureDevcontainerAgentState,
  ensureDevcontainerClaudeState,
  ensureDevcontainerCodexState,
} from "./mount_probes.ts";

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

test("IDE Codex state is created once with private permissions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-codex-"));
  try {
    const created = await ensureDevcontainerCodexState(home);
    expect(created).toEqual({ codexDir: path.join(home, ".codex") });
    const mode = (await stat(created.codexDir)).mode & 0o777;
    expect(mode).toBe(0o700);

    // Idempotent: a marker inside the state dir survives a second call.
    await writeFile(path.join(created.codexDir, "auth.json"), "{}");
    await ensureDevcontainerCodexState(home);
    expect(
      await readFile(path.join(created.codexDir, "auth.json"), "utf8"),
    ).toBe("{}");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

test("ensureDevcontainerAgentState dispatches per requested agent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-state-"));
  try {
    expect(await ensureDevcontainerAgentState(["claude"], home)).toEqual({
      claudeState: {
        claudeDir: path.join(home, ".claude"),
        claudeJson: path.join(home, ".claude.json"),
      },
    });
    expect(await ensureDevcontainerAgentState(["codex"], home)).toEqual({
      codexState: { codexDir: path.join(home, ".codex") },
    });
    expect(await ensureDevcontainerAgentState(["copilot"], home)).toEqual({});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureDevcontainerAgentState prepares both states at once without overwriting existing content", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-state-both-"));
  try {
    const first = await ensureDevcontainerAgentState(["claude", "codex"], home);
    expect(first).toEqual({
      claudeState: {
        claudeDir: path.join(home, ".claude"),
        claudeJson: path.join(home, ".claude.json"),
      },
      codexState: { codexDir: path.join(home, ".codex") },
    });
    expect(await pathExists(first.claudeState!.claudeDir)).toBe(true);
    expect(await pathExists(first.codexState!.codexDir)).toBe(true);

    await writeFile(first.claudeState!.claudeJson, '{"kept":true}\n');
    await writeFile(path.join(first.codexState!.codexDir, "auth.json"), "{}");

    const second = await ensureDevcontainerAgentState(
      ["claude", "codex"],
      home,
    );
    expect(second).toEqual(first);
    expect(await readFile(first.claudeState!.claudeJson, "utf8")).toBe(
      '{"kept":true}\n',
    );
    expect(
      await readFile(
        path.join(first.codexState!.codexDir, "auth.json"),
        "utf8",
      ),
    ).toBe("{}");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureDevcontainerAgentState with only Copilot requested creates neither state directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-state-copilot-"));
  try {
    expect(await ensureDevcontainerAgentState(["copilot"], home)).toEqual({});
    expect(await pathExists(path.join(home, ".claude"))).toBe(false);
    expect(await pathExists(path.join(home, ".codex"))).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureDevcontainerAgentState requesting only one agent on a fresh HOME does not create the other's directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-ide-state-single-"));
  try {
    await ensureDevcontainerAgentState(["claude"], home);
    expect(await pathExists(path.join(home, ".claude"))).toBe(true);
    expect(await pathExists(path.join(home, ".codex"))).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
