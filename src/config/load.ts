/**
 * Pkl 設定ファイルの読み込み
 */

import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import type { Config } from "./types.ts";
import { validateConfig } from "./validate.ts";

const CONFIG_FILENAME_PKL = ".agent-sandbox.pkl";

/** グローバル設定ディレクトリ（XDG_CONFIG_HOME を優先） */
export function getGlobalConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configBase =
    xdgConfigHome ?? path.join(process.env.HOME ?? "/", ".config");
  return path.join(configBase, "nas");
}

/** loadConfig のオプション */
export interface LoadConfigOptions {
  /** 開始ディレクトリ（デフォルト: process.cwd()） */
  startDir?: string;
  /** グローバル設定ファイルのパス（null でグローバル読み込みを無効化） */
  globalConfigPath?: string | null;
}

/** 設定ファイルを読み込んで検証済み Config を返す */
export async function loadConfig(
  startDirOrOpts?: string | LoadConfigOptions,
): Promise<Config> {
  const opts: LoadConfigOptions =
    typeof startDirOrOpts === "string"
      ? { startDir: startDirOrOpts }
      : (startDirOrOpts ?? {});

  const globalResult =
    opts.globalConfigPath === null
      ? null
      : await loadGlobalConfig(opts.globalConfigPath);
  const found = await findConfigFile(opts.startDir ?? process.cwd());

  if (found) {
    // ローカル設定あり: グローバル .pkl パスを渡して pkl eval
    const raw = await loadPklConfig(found.path, globalResult?.pklPath);
    return validateConfig(raw);
  }

  if (globalResult) {
    // グローバルのみ: 直接読む
    const raw = await loadPklConfig(globalResult.pklPath);
    return validateConfig(raw);
  }

  throw new Error(
    `${CONFIG_FILENAME_PKL} not found in current directory or parent directories, and no global config found in ${getGlobalConfigDir()}`,
  );
}

/** グローバル設定ファイルの .pkl パスを返す。なければ null */
export async function loadGlobalConfig(
  configPath?: string,
): Promise<{ pklPath: string } | null> {
  if (configPath) {
    return { pklPath: configPath };
  }
  const candidate = path.join(getGlobalConfigDir(), "agent-sandbox.pkl");
  try {
    await stat(candidate);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e; // 予期しない stat エラー（権限不足など）は伝播
  }
  return { pklPath: candidate };
}

/** 設定ファイルの検索結果 */
interface ConfigFileFound {
  path: string;
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
 * .agent-sandbox.pkl を pkl eval で評価して設定オブジェクトを得る。
 *
 * 評価のたびに一時ディレクトリを作り、そこに以下を配置する:
 *   - `Schema.pkl`         : 型付きスキーマ（バンドルされたアセットからコピー）
 *   - `agent-sandbox.global.pkl` : グローバル .pkl ファイルのコピー、または
 *                                  空の amends ヘッダのみのファイル。
 *
 * tmpDir は `--module-path` として pkl eval に渡される。これによりユーザの
 * `.pkl` ファイルは `amends "modulepath:/Schema.pkl"` または
 * `amends "modulepath:/agent-sandbox.global.pkl"` のいずれでも参照できる。
 */
async function loadPklConfig(
  pklPath: string,
  globalPklPath?: string,
): Promise<unknown> {
  if (!(await pklCommandExists())) {
    throw new Error(
      `Found ${CONFIG_FILENAME_PKL} at ${pklPath}, but 'pkl' command is not available on PATH. Install Pkl (https://pkl-lang.org/main/current/pkl-cli/index.html#installation).`,
    );
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-module-"));
  try {
    // Schema.pkl をアセットから解決して tmpDir にコピーする。
    // NAS_ASSET_DIR があればそちらを優先し、なければソースツリー上の隣接ファイルを使う。
    const schemaPklSrc = resolveAsset(
      "config/Schema.pkl",
      import.meta.url,
      "./Schema.pkl",
    );
    let schemaPklText: string;
    try {
      schemaPklText = await readFile(schemaPklSrc, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Schema.pkl not found at ${schemaPklSrc}. ` +
            `Set NAS_ASSET_DIR to a directory containing config/Schema.pkl, ` +
            `or ensure the file exists adjacent to src/config/load.ts.`,
        );
      }
      throw e;
    }
    await writeFile(path.join(tmpDir, "Schema.pkl"), schemaPklText);
    // Config.pkl is a deprecated alias for Schema.pkl; user .pkl files may still reference it.
    await writeFile(path.join(tmpDir, "Config.pkl"), schemaPklText);

    // agent-sandbox.global.pkl は常に配置する。
    // globalPklPath が指定されていればそのファイルをコピーし、
    // なければ空の amends ヘッダのみのファイルを書き出す。
    const globalDst = path.join(tmpDir, "agent-sandbox.global.pkl");
    if (globalPklPath) {
      await copyFile(globalPklPath, globalDst);
    } else {
      await writeFile(globalDst, 'amends "modulepath:/Schema.pkl"\n');
    }

    const cmdArgs = [
      "pkl",
      "eval",
      "--module-path",
      tmpDir,
      "-f",
      "json",
      pklPath,
    ];

    const proc = Bun.spawn(cmdArgs, {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      const errMsg = stderrText.trim();
      throw new Error(
        `Failed to evaluate ${pklPath}: pkl eval exited with code ${code}\n${errMsg}`,
      );
    }
    try {
      return JSON.parse(stdoutText);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to parse pkl output for ${pklPath}: ${message}\nstdout: ${stdoutText.slice(0, 500)}`,
      );
    }
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }
}

/** 指定ディレクトリから上位に向かって .agent-sandbox.pkl を探す */
async function findConfigFile(dir: string): Promise<ConfigFileFound | null> {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, CONFIG_FILENAME_PKL);
    try {
      await stat(candidate);
      return { path: candidate };
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
