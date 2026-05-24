import { expect, test } from "bun:test";
import * as path from "node:path";
import { loadConfig } from "./load.ts";

const repoRoot = path.resolve(import.meta.dir, "../..");

async function pklAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pkl", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

const hasPkl = await pklAvailable();

test.skipIf(!hasPkl)(
  "repo .agent-sandbox.pkl loads with typed Config.pkl and exposes all profiles",
  async () => {
    const config = await loadConfig({
      startDir: repoRoot,
      globalConfigPath: null,
    });
    expect(Object.keys(config.profiles)).toEqual(
      expect.arrayContaining([
        "claude",
        "claude-remote",
        "codex",
        "copilot",
        "hostexec-demo",
      ]),
    );
    expect(config.profiles.claude.agent).toBe("claude");
    expect(config.profiles["hostexec-demo"].agent).toBe("claude");
    // baseProfile 由来の継承確認 (Option X: hostexec-demo amends baseProfile)
    expect(config.profiles["hostexec-demo"].nix.enable).toBe("auto");
    expect(config.profiles["hostexec-demo"].session.multiplex).toBe(true);
  },
);
