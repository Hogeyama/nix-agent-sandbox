import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import { loadConfig } from "./load.ts";

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

/** バンドルされた Schema.pkl のテキストを読み込む */
async function readBundledSchema(): Promise<string> {
  const schemaSrc = resolveAsset(
    "config/Schema.pkl",
    import.meta.url,
    "./Schema.pkl",
  );
  return readFile(schemaSrc, "utf8");
}

/**
 * .nas/ 構造をセットアップする。
 */
async function setupNasDir(
  parentDir: string,
  configPkl: string,
): Promise<string> {
  const nasDir = path.join(parentDir, ".nas");
  await mkdir(nasDir, { recursive: true });

  const schemaText = await readBundledSchema();
  await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);

  const pklProject = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
  }
}
`;
  await writeFile(path.join(nasDir, "PklProject"), pklProject);
  await writeFile(path.join(nasDir, "config.pkl"), configPkl);
  return nasDir;
}

test.skipIf(!hasPkl)(
  "Schema.pkl loads with all profile features via .nas/ project-dir",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-repo-pkl-test-"));
    try {
      await setupNasDir(
        tmpDir,
        `amends "Schema.pkl"

local baseProfile: Profile = new {
  agent = "claude"
  session { multiplex = true }
  nix { extraPackages { "nixpkgs#gh" } }
}

profiles {
  ["claude"] = (baseProfile) {}
  ["copilot"] = (baseProfile) { agent = "copilot" }
  ["codex"] = (baseProfile) { agent = "codex" }
  ["hostexec-demo"] = (baseProfile) {
    hostexec = new HostExecConfig {
      rules {
        new {
          id = "gh-cli"
          match { argv0 = "gh" }
        }
      }
    }
  }
}
`,
      );

      const config = await loadConfig({ startDir: tmpDir });
      expect(Object.keys(config.profiles)).toEqual(
        expect.arrayContaining(["claude", "copilot", "codex", "hostexec-demo"]),
      );
      expect(config.profiles.claude.agent).toBe("claude");
      expect(config.profiles["hostexec-demo"].agent).toBe("claude");
      expect(config.profiles["hostexec-demo"].nix.enable).toBe("auto");
      expect(config.profiles["hostexec-demo"].session.multiplex).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);
