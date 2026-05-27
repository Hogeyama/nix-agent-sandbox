/**
 * Pkl 設定ファイルの読み込み
 *
 * .nas/config.pkl を eval.pkl 経由の型注釈で評価し、
 * Schema.pkl への適合を pkl の型システムで検証する。
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { initConfig, resolveSchemaAsset } from "./init.ts";
import {
  findNixConfig,
  findYamlConfig,
  migrateNix2Pkl,
  migrateYml2Pkl,
} from "./migrate.ts";
import { getGlobalConfigDir } from "./paths.ts";
import type { Config } from "./types.ts";
import { validateConfig } from "./validate.ts";

export { getGlobalConfigDir } from "./paths.ts";

const CONFIG_DIR = ".nas";
const CONFIG_FILENAME = "config.pkl";
const SCHEMA_FILENAME = "Schema.pkl";
const PKL_PROJECT_FILENAME = "PklProject";

/** loadConfig のオプション */
export interface LoadConfigOptions {
  /** 開始ディレクトリ（デフォルト: process.cwd()） */
  startDir?: string;
}

/** 設定ファイルを読み込んで検証済み Config を返す */
export async function loadConfig(
  startDirOrOpts?: string | LoadConfigOptions,
): Promise<Config> {
  const opts: LoadConfigOptions =
    typeof startDirOrOpts === "string"
      ? { startDir: startDirOrOpts }
      : (startDirOrOpts ?? {});

  const startDir = opts.startDir ?? process.cwd();
  const found = await resolveConfigFile(startDir);

  // Check for legacy global config before eval
  await detectAndMigrateGlobalLegacy();

  const raw = await evalPklConfig(found.nasDir, found.configPath);
  return validateConfig(raw as Config);
}

/**
 * .nas/config.pkl を探し、見つからなければレガシー検出 or auto-init で解決する。
 * handleLegacyConfig は process.exit するため、戻り値は常に非 null。
 */
async function resolveConfigFile(startDir: string): Promise<ConfigFileFound> {
  const found = await findConfigFile(startDir);
  if (found) return found;

  const legacyNix = await findNixConfig(startDir);
  const legacyYaml = legacyNix ? null : await findYamlConfig(startDir);
  const legacyPath = legacyNix ?? legacyYaml;

  if (legacyPath) {
    // handleLegacyConfig never returns (exits or throws)
    await handleLegacyConfig(legacyPath, !!legacyNix);
  }

  if (process.env.NAS_NO_AUTO_INIT === "1") {
    throw new Error(
      `.nas/config.pkl not found. Run \`nas config init\` to create it.`,
    );
  }

  console.error(
    `Auto-initializing .nas/ in ${startDir}. Run 'nas config init' in your project root to choose the location.`,
  );
  await initConfig({ projectDir: startDir });
  const afterInit = await findConfigFile(startDir);
  if (!afterInit) {
    throw new Error(
      `.nas/config.pkl not found even after auto-init. This is a bug — please report it.`,
    );
  }
  return afterInit;
}

/**
 * レガシー設定ファイル検出時の移行ハンドリング。
 * TTY なら confirm で確認、非 TTY ならエラーで案内。
 */
async function handleLegacyConfig(
  legacyPath: string,
  isNix: boolean,
): Promise<never> {
  const migrateSub = isNix ? "nix2pkl" : "yml2pkl";
  const migrateCmd = `nas config migrate ${migrateSub}`;

  if (!process.stdin.isTTY) {
    throw new Error(
      `Found legacy config: ${legacyPath}\n` +
        `Run \`${migrateCmd}\` to migrate to .nas/config.pkl.`,
    );
  }

  const ok = confirm(
    `Found legacy config: ${legacyPath}\nMigrate to .nas/config.pkl?`,
  );
  if (!ok) {
    throw new Error(
      `Run \`${migrateCmd}\` when ready, or delete ${path.basename(legacyPath)} and run \`nas config init\`.`,
    );
  }

  console.error(`Migrating ${legacyPath} -> .nas/config.pkl ...`);
  if (isNix) {
    const result = await migrateNix2Pkl();
    if (result.scaffoldResult) {
      for (const f of result.scaffoldResult.written) {
        console.error(`  created: ${f}`);
      }
    }
    console.error(`  converted: ${result.inputPath} -> ${result.outputPath}`);
  } else {
    const result = await migrateYml2Pkl();
    if (result.scaffoldResult) {
      for (const f of result.scaffoldResult.written) {
        console.error(`  created: ${f}`);
      }
    }
    console.error(`  converted: ${result.inputPath} -> ${result.outputPath}`);
  }
  console.error(
    `\n  Verify the migrated config, then remove the old file:\n    rm ${legacyPath}`,
  );
  console.error(`\n  Run \`nas\` again to start.`);
  process.exit(0);
}

/**
 * グローバル設定ディレクトリにレガシー設定 (agent-sandbox.{nix,yml}) が
 * あるのに global.pkl が存在しない場合、移行を促す。
 */
async function detectAndMigrateGlobalLegacy(): Promise<void> {
  const globalDir = getGlobalConfigDir();
  const globalPkl = path.join(globalDir, "global.pkl");

  // global.pkl が既にあるなら何もしない
  try {
    await stat(globalPkl);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const nixPath = path.join(globalDir, ".agent-sandbox.nix");
  const ymlPath = path.join(globalDir, ".agent-sandbox.yml");

  let legacyPath: string | null = null;
  let isNix = false;
  try {
    await stat(nixPath);
    legacyPath = nixPath;
    isNix = true;
  } catch {
    try {
      await stat(ymlPath);
      legacyPath = ymlPath;
    } catch {
      return;
    }
  }

  const migrateSub = isNix ? "nix2pkl" : "yml2pkl";
  const migrateCmd = `nas config migrate ${migrateSub} --global`;

  if (!process.stdin.isTTY) {
    console.error(
      `Found legacy global config: ${legacyPath}\n` +
        `Run \`${migrateCmd}\` to migrate to ${globalPkl}.`,
    );
    return;
  }

  const ok = confirm(
    `Found legacy global config: ${legacyPath}\nMigrate to ${globalPkl}?`,
  );
  if (!ok) {
    console.error(
      `Skipped global migration. Run \`${migrateCmd}\` when ready.`,
    );
    return;
  }

  console.error(`Migrating ${legacyPath} -> ${globalPkl} ...`);
  if (isNix) {
    const result = await migrateNix2Pkl({ global: true });
    console.error(`  converted: ${result.inputPath} -> ${result.outputPath}`);
  } else {
    const result = await migrateYml2Pkl({ global: true });
    console.error(`  converted: ${result.inputPath} -> ${result.outputPath}`);
  }
  console.error(
    `\n  Verify the migrated config, then remove the old file:\n    rm ${legacyPath}`,
  );
}

/** 設定ファイルの検索結果 */
interface ConfigFileFound {
  /** .nas ディレクトリの絶対パス */
  nasDir: string;
  /** .nas/config.pkl の絶対パス */
  configPath: string;
}

/** 指定ディレクトリから上位に向かって .nas/config.pkl を探す */
async function findConfigFile(dir: string): Promise<ConfigFileFound | null> {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (true) {
    const nasDir = path.join(current, CONFIG_DIR);
    const candidate = path.join(nasDir, CONFIG_FILENAME);
    try {
      await stat(candidate);
      return { nasDir, configPath: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) {
      return null;
    }
    current = parent;
  }
}

/** pkl コマンドが PATH 上に存在するか確認する */
async function pklCommandExists(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pkl", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
    const code = await proc.exited;
    return code === 0;
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw e;
  }
}

/**
 * .nas/config.pkl を一時ディレクトリの eval.pkl 経由で pkl eval する。
 *
 * eval.pkl と PklProject は tmp に生成し、.nas/ にはユーザーが触る
 * ファイル (config.pkl, Schema.pkl, PklProject) だけを残す。
 *
 * eval.pkl は config.pkl を絶対パスで import し、Schema への型検証を行う。
 * config.pkl 内の modulepath:/global.pkl は tmp の PklProject の modulePath
 * 経由で解決される。
 */
async function evalPklConfig(
  nasDir: string,
  configPath: string,
): Promise<unknown> {
  if (!(await pklCommandExists())) {
    throw new Error(
      `Found .nas/config.pkl at ${configPath}, but 'pkl' command is not available on PATH.`,
    );
  }

  // PklProject 存在確認 (ユーザー向け; ここではエラーチェックのみ)
  const pklProjectPath = path.join(nasDir, PKL_PROJECT_FILENAME);
  try {
    await stat(pklProjectPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `PklProject not found at ${pklProjectPath}. Run "nas config init" to regenerate it.`,
      );
    }
    throw e;
  }

  // Schema.pkl を CLI アセットから .nas/ に上書き (エディタ補完用)
  const schemaPklSrc = resolveSchemaAsset();
  let schemaPklText: string;
  try {
    schemaPklText = await readFile(schemaPklSrc, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Bundled Schema.pkl asset not found at ${schemaPklSrc}. This is a bug — please report it.`,
      );
    }
    throw e;
  }
  await writeFile(path.join(nasDir, SCHEMA_FILENAME), schemaPklText);

  // --- tmp ディレクトリで eval を実行 ---
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "nas-eval-"));
  try {
    // Schema.pkl と global.pkl を tmp にコピー。
    // すべてを modulepath 経由で解決することで Pkl のモジュール identity を統一する。
    // (file:// と modulepath:// で同じファイルを指しても Pkl は別モジュール扱いする)
    await writeFile(path.join(tmpDir, "Schema.pkl"), schemaPklText);

    const globalDir = getGlobalConfigDir();
    const globalPklSrc = path.join(globalDir, "global.pkl");
    try {
      const globalPklText = await readFile(globalPklSrc, "utf8");
      await writeFile(path.join(tmpDir, "global.pkl"), globalPklText);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await mkdir(globalDir, { recursive: true });
      const fallback = 'amends "Schema.pkl"\n';
      await writeFile(globalPklSrc, fallback);
      await writeFile(path.join(tmpDir, "global.pkl"), fallback);
    }

    // tmp/PklProject: tmpDir → Schema.pkl, global.pkl; nasDir → config.pkl
    const pklProject = [
      'amends "pkl:Project"',
      "",
      "evaluatorSettings {",
      "  modulePath {",
      `    "${escapePklString(tmpDir)}"`,
      `    "${escapePklString(nasDir)}"`,
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(path.join(tmpDir, "PklProject"), pklProject);

    // tmp/eval.pkl: すべて modulepath 経由で import
    const evalContent = [
      'import "modulepath:/config.pkl"',
      'import "modulepath:/Schema.pkl"',
      "",
      "local validated: Schema = config",
      "",
      "output {",
      "  value = validated",
      "}",
      "",
    ].join("\n");
    const evalPklPath = path.join(tmpDir, "eval.pkl");
    await writeFile(evalPklPath, evalContent);

    // pkl eval
    const proc = Bun.spawn(
      ["pkl", "eval", "--project-dir", tmpDir, "-f", "json", evalPklPath],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        `Failed to evaluate ${configPath}: pkl eval exited with code ${code}\n${stderrText.trim()}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdoutText) as Record<string, unknown>;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to parse pkl output for ${configPath}: ${message}`,
      );
    }

    return parsed;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function escapePklString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** プロファイルを解決 (名前指定 or default) */
export function resolveProfile(config: Config, profileName?: string) {
  const name = profileName ?? config.default;
  if (!name) {
    const names = Object.keys(config.profiles);
    if (names.length === 1) {
      return { name: names[0], profile: config.profiles[names[0]] };
    }
    throw new Error(
      "No profile specified and no default set. Available: " +
        Object.keys(config.profiles).join(", "),
    );
  }

  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(
      `Profile "${name}" not found. Available: ${Object.keys(
        config.profiles,
      ).join(", ")}`,
    );
  }
  return { name, profile };
}
