import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig } from "../src/config/init.ts";
import { resolveMaskFsBinPath } from "../src/stages/maskfs/maskfs_path.ts";
import { isUserAllowOtherEnabled } from "../src/stages/maskfs/maskfs_service.ts";

const MAIN_TS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "main.ts",
);

const SECRET = "hunter2secret";
const MASKED = "*".repeat(13);

async function isDockerAvailable(): Promise<boolean> {
  try {
    const exitCode = await Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function isFuseUsable(): Promise<boolean> {
  try {
    await stat("/dev/fuse");
  } catch {
    return false;
  }
  if (!Bun.which("fusermount3")) return false;
  // docker からアクセスされるため allow_other が必要
  if (!(await isUserAllowOtherEnabled())) return false;
  return (await resolveMaskFsBinPath()) !== null;
}

const dockerAvailable = await isDockerAvailable();
const fuseUsable = await isFuseUsable();

async function runNas(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cleanedParent: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "NAS_SESSION_ID",
    "NAS_HOSTEXEC_SESSION_ID",
    "NAS_HOSTEXEC_SESSION_TMP",
  ]) {
    delete cleanedParent[key];
  }
  const proc = Bun.spawn(["bun", "run", MAIN_TS, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
    env: options.env ? { ...cleanedParent, ...options.env } : cleanedParent,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test.skipIf(!dockerAvailable || !fuseUsable)(
  "E2E: agent sees masked workspace and cannot corrupt the secret file",
  async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "nas-maskfs-e2e-"));
    try {
      const projectDir = path.join(rootDir, "project");
      const homeDir = path.join(rootDir, "home");
      const binDir = path.join(rootDir, "bin");
      await mkdir(projectDir, { recursive: true });
      await mkdir(path.join(homeDir, ".codex"), { recursive: true });
      await mkdir(binDir, { recursive: true });

      // ワークスペース: 秘密値入りファイル
      await writeFile(
        path.join(projectDir, "secret.env"),
        `DB_PASSWORD=${SECRET}\n`,
      );

      // fake agent: cat と書き込み試行の結果を出力する
      const fakeCodexPath = path.join(binDir, "codex");
      await writeFile(
        fakeCodexPath,
        [
          "#!/bin/sh",
          'printf "CAT=%s\\n" "$(cat ./secret.env)"',
          'if echo overwrite >> ./secret.env 2>/dev/null; then printf "WRITE=ok\\n"; else printf "WRITE=denied\\n"; fi',
        ].join("\n"),
      );
      await chmod(fakeCodexPath, 0o755);

      await initConfig({ projectDir });
      await writeFile(
        path.join(projectDir, ".nas", "config.pkl"),
        [
          'amends "Schema.pkl"',
          "",
          'default = "test"',
          "profiles {",
          '  ["test"] {',
          '    agent = "codex"',
          "    nix { enable = false }",
          "    docker { enable = false; shared = false }",
          "    mask = new MaskConfig {",
          "      values {",
          '        new { source = "dotenv:secret.env#DB_PASSWORD" }',
          "      }",
          '      writePolicy = "readonly"',
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await runNas(["test"], {
        cwd: projectDir,
        env: { HOME: homeDir, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`CAT=DB_PASSWORD=${MASKED}`);
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stdout).toContain("WRITE=denied");

      // ホスト実体は無傷
      const real = await readFile(path.join(projectDir, "secret.env"), "utf8");
      expect(real).toEqual(`DB_PASSWORD=${SECRET}\n`);
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
