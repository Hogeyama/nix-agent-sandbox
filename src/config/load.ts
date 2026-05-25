/**
 * Pkl 設定ファイルの読み込み
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import { normalizePklKeys, rawConfigToPklSource } from "./pkl.ts";
import type { Config, RawConfig, RawProfile } from "./types.ts";
import { validateConfig } from "./validate.ts";

const CONFIG_FILENAME_PKL = ".agent-sandbox.pkl";

/** グローバル設定ディレクトリ（XDG_CONFIG_HOME を優先） */
function getGlobalConfigDir(): string {
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

  const globalRaw =
    opts.globalConfigPath === null
      ? null
      : await loadGlobalConfig(opts.globalConfigPath);
  const found = await findConfigFile(opts.startDir ?? process.cwd());

  const localRaw = found ? await loadLocalConfig(found, globalRaw) : null;

  if (!globalRaw && !localRaw) {
    throw new Error(
      `${CONFIG_FILENAME_PKL} not found in current directory or parent directories, and no global config found in ${getGlobalConfigDir()}`,
    );
  }

  // Pkl で自己完結している場合は TypeScript マージをスキップ
  if (localRaw?._pklSelfContained) {
    const { _pklSelfContained: _, ...raw } = localRaw;
    return validateConfig(raw);
  }

  const merged = mergeRawConfigs(globalRaw, localRaw);
  return validateConfig(merged);
}

/** グローバル設定ファイルを読み込む。なければ null */
export async function loadGlobalConfig(
  configPath?: string,
): Promise<RawConfig | null> {
  if (configPath) {
    // 明示パス指定時は .pkl として読む（エラーはそのまま伝播）
    return await loadPklConfig(configPath);
  }
  const candidate = path.join(getGlobalConfigDir(), "agent-sandbox.pkl");
  try {
    await stat(candidate);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e; // 予期しない stat エラー（権限不足など）は伝播
  }
  return await loadPklConfig(candidate);
}

/** グローバルとローカルの RawConfig をマージする */
export function mergeRawConfigs(
  global: RawConfig | null,
  local: RawConfig | null,
): RawConfig {
  if (!global) {
    if (!local) {
      throw new Error("mergeRawConfigs: both global and local are null");
    }
    return local;
  }
  if (!local) return global;

  // プロファイルをマージ
  const globalProfiles = global.profiles ?? {};
  const localProfiles = local.profiles ?? {};
  const allNames = new Set([
    ...Object.keys(globalProfiles),
    ...Object.keys(localProfiles),
  ]);

  const mergedProfiles: Record<string, RawProfile> = {};
  for (const name of allNames) {
    const gp = globalProfiles[name];
    const lp = localProfiles[name];
    if (gp && lp) {
      mergedProfiles[name] = mergeRawProfiles(gp, lp);
    } else if (lp) {
      mergedProfiles[name] = lp;
    } else if (gp) {
      mergedProfiles[name] = gp;
    }
    // unreachable: name came from the union of both keysets
  }

  return {
    default: local.default ?? global.default,
    ui: shallowMerge(global.ui, local.ui),
    observability: shallowMerge(global.observability, local.observability),
    profiles: mergedProfiles,
  };
}

/** 2つの RawProfile をフィールド単位でマージする（ローカル優先） */
export function mergeRawProfiles(
  global: RawProfile,
  local: RawProfile,
): RawProfile {
  return {
    agent: local.agent ?? global.agent,
    "agent-args": local["agent-args"] ?? global["agent-args"],
    worktree: shallowMerge(global.worktree, local.worktree),
    session: shallowMerge(global.session, local.session),
    nix: shallowMerge(global.nix, local.nix),
    docker: shallowMerge(global.docker, local.docker),
    gcloud: shallowMerge(global.gcloud, local.gcloud),
    aws: shallowMerge(global.aws, local.aws),
    gpg: shallowMerge(global.gpg, local.gpg),
    network: mergeRawNetworkConfigs(global.network, local.network),
    dbus: mergeRawDbusConfigs(global.dbus, local.dbus),
    display: shallowMerge(global.display, local.display),
    "extra-mounts": local["extra-mounts"] ?? global["extra-mounts"],
    env: local.env ?? global.env,
    hook: shallowMerge(global.hook, local.hook),
    hostexec: mergeRawHostExecConfigs(global.hostexec, local.hostexec),
  };
}

function mergeRawNetworkConfigs(
  global?: RawProfile["network"],
  local?: RawProfile["network"],
): RawProfile["network"] {
  if (!global) return local;
  if (!local) return global;
  return {
    ...global,
    ...local,
    proxy: shallowMerge(global.proxy, local.proxy),
    prompt: shallowMerge(global.prompt, local.prompt),
  };
}

function mergeRawHostExecConfigs(
  global?: RawProfile["hostexec"],
  local?: RawProfile["hostexec"],
): RawProfile["hostexec"] {
  if (!global) return local;
  if (!local) return global;
  return {
    ...global,
    ...local,
    prompt: shallowMerge(global.prompt, local.prompt),
    secrets: local.secrets ?? global.secrets,
    rules: local.rules ?? global.rules,
  };
}

function mergeRawDbusConfigs(
  global?: RawProfile["dbus"],
  local?: RawProfile["dbus"],
): RawProfile["dbus"] {
  if (!global) return local;
  if (!local) return global;
  return {
    ...global,
    ...local,
    session: shallowMerge(global.session, local.session),
  };
}

/** オブジェクトのフィールド単位でシャローマージ（ローカル優先） */
function shallowMerge<T extends Record<string, unknown>>(
  global?: T,
  local?: T,
): T | undefined {
  if (!global) return local;
  if (!local) return global;
  return { ...global, ...local };
}

/** 設定ファイルの検索結果 */
interface ConfigFileFound {
  path: string;
}

/** ローカル設定ファイルを読み込む */
async function loadLocalConfig(
  found: ConfigFileFound,
  globalRaw?: RawConfig | null,
): Promise<RawConfig & { _pklSelfContained?: boolean }> {
  return await loadPklConfig(found.path, globalRaw ?? undefined);
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
 * .agent-sandbox.pkl を pkl eval で評価して RawConfig を得る。
 *
 * 評価のたびに一時ディレクトリを作り、そこに以下を配置する:
 *   - `Config.pkl`         : 型付きスキーマ（バンドルされたアセットからコピー）
 *   - `agent-sandbox.global.pkl` : `amends "modulepath:/Config.pkl"` を先頭に持つ
 *                                  グローバル設定。globalRaw が空でもヘッダだけのファイルを書き出す。
 *
 * tmpDir は `--module-path` として pkl eval に渡される。これによりユーザの
 * `.pkl` ファイルは `amends "modulepath:/Config.pkl"` または
 * `amends "modulepath:/agent-sandbox.global.pkl"` のいずれでも参照できる。
 */
async function loadPklConfig(
  pklPath: string,
  globalRaw?: RawConfig,
): Promise<RawConfig & { _pklSelfContained?: boolean }> {
  if (!(await pklCommandExists())) {
    throw new Error(
      `Found ${CONFIG_FILENAME_PKL} at ${pklPath}, but 'pkl' command is not available on PATH. Install Pkl (https://pkl-lang.org/main/current/pkl-cli/index.html#installation).`,
    );
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-module-"));
  try {
    // Config.pkl をアセットから解決して tmpDir にコピーする。
    // NAS_ASSET_DIR があればそちらを優先し、なければソースツリー上の隣接ファイルを使う。
    const configPklSrc = resolveAsset(
      "config/Config.pkl",
      import.meta.url,
      "./Config.pkl",
    );
    let configPklText: string;
    try {
      configPklText = await readFile(configPklSrc, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Config.pkl not found at ${configPklSrc}. ` +
            `Set NAS_ASSET_DIR to a directory containing config/Config.pkl, ` +
            `or ensure the file exists adjacent to src/config/load.ts.`,
        );
      }
      throw e;
    }
    await writeFile(path.join(tmpDir, "Config.pkl"), configPklText);

    // agent-sandbox.global.pkl は常に書き出す。
    // globalRaw が空/未指定でも、ファイル自体は `amends "modulepath:/Config.pkl"` を含むので
    // ユーザの `amends "modulepath:/agent-sandbox.global.pkl"` がそのまま解決できる。
    // Strip internal flags before serializing to Pkl source.
    const { _pklSelfContained: _, ...cleanGlobalRaw } = (globalRaw ??
      {}) as RawConfig & { _pklSelfContained?: boolean };
    const globalPklSource = rawConfigToPklSource(cleanGlobalRaw);
    await writeFile(
      path.join(tmpDir, "agent-sandbox.global.pkl"),
      globalPklSource,
    );

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
    let raw: RawConfig;
    try {
      raw = normalizePklKeys(JSON.parse(stdoutText)) as RawConfig;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to parse pkl output for ${pklPath}: ${message}\nstdout: ${stdoutText.slice(0, 500)}`,
      );
    }
    return { ...raw, _pklSelfContained: true };
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
