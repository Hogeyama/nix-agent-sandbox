/**
 * Pkl 設定ファイルの読み込み
 *
 * .nas/config.pkl を eval.pkl 経由の型注釈で評価し、
 * Schema.pkl への適合を pkl の型システムで検証する。
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { initConfig, resolveSchemaAsset, resolveTemplate } from "./init.ts";
import { getGlobalConfigDir } from "./paths.ts";
import type { Config } from "./types.ts";
import { validateConfig } from "./validate.ts";

export { getGlobalConfigDir } from "./paths.ts";

const CONFIG_DIR = ".nas";
const CONFIG_FILENAME = "config.pkl";
const SCHEMA_FILENAME = "Schema.pkl";
const PKL_PROJECT_FILENAME = "PklProject";
const EVAL_FILENAME = "eval.pkl";

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
  let found = await findConfigFile(startDir);

  if (!found) {
    if (process.env.NAS_NO_AUTO_INIT === "1") {
      throw new Error(
        `.nas/config.pkl not found. Run \`nas config init\` to create it.`,
      );
    }
    // Auto-init: create .nas/ with default config in the start directory
    console.error(
      `Auto-initializing .nas/ in ${startDir}. Run 'nas config init' in your project root to choose the location.`,
    );
    await initConfig({ projectDir: startDir });
    found = await findConfigFile(startDir);
    if (!found) {
      throw new Error(
        `.nas/config.pkl not found even after auto-init. This is a bug — please report it.`,
      );
    }
  }

  const raw = await evalPklConfig(found.nasDir, found.configPath);
  return validateConfig(raw as Config);
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
 * .nas/config.pkl を eval.pkl 経由で pkl eval し、設定オブジェクトを得る。
 *
 * eval.pkl は `local validated: Schema = config` という型注釈を持ち、
 * config.pkl が Schema.pkl を正しく amends していなければ pkl の型エラーになる。
 * Schema.pkl と eval.pkl は CLI バンドルのアセットから毎回上書きする。
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

  // PklProject 存在確認
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

  // global.pkl をグローバル設定ディレクトリからコピー（pkl の modulePath は
  // シンボリックリンクを辿れないため、実体を読み込んで .nas/ にコピーする）
  const globalDir = getGlobalConfigDir();
  const globalPklSrc = path.join(globalDir, "global.pkl");
  try {
    // readFile はシンボリックリンクを辿るので Nix home-manager 管理でも動作する
    const globalPklText = await readFile(globalPklSrc, "utf8");
    await writeFile(path.join(nasDir, "global.pkl"), globalPklText);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
    // global.pkl が存在しない場合はスキップ — config.pkl が
    // amends "Schema.pkl" を使っていれば問題ない
  }

  // Schema.pkl を CLI アセットから上書き
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

  // eval.pkl を CLI アセットから上書き
  const evalPklSrc = resolveTemplate("eval.pkl");
  let evalPklText: string;
  try {
    evalPklText = await readFile(evalPklSrc, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Bundled eval.pkl asset not found at ${evalPklSrc}. This is a bug — please report it.`,
      );
    }
    throw e;
  }
  const evalPklPath = path.join(nasDir, EVAL_FILENAME);
  await writeFile(evalPklPath, evalPklText);

  // pkl eval --project-dir .nas/ -f json .nas/eval.pkl
  const proc = Bun.spawn(
    ["pkl", "eval", "--project-dir", nasDir, "-f", "json", evalPklPath],
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
    throw new Error(`Failed to parse pkl output for ${configPath}: ${message}`);
  }

  return parsed;
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
