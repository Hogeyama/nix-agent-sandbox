/**
 * YAML 設定ファイルの読み込み
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Config, RawConfig, RawProfile } from "./types.ts";
import { validateConfig } from "./validate.ts";

const CONFIG_FILENAME_YML = ".agent-sandbox.yml";
const CONFIG_FILENAME_NIX = ".agent-sandbox.nix";

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

  // Nix ローカル設定が関数の場合、グローバル設定を super として渡す
  const localRaw = found ? await loadLocalConfig(found, globalRaw) : null;

  if (!globalRaw && !localRaw) {
    throw new Error(
      `${CONFIG_FILENAME_YML} (or ${CONFIG_FILENAME_NIX}) not found in current directory or parent directories, and no global config found in ${getGlobalConfigDir()}`,
    );
  }

  // Nix 関数でマージ済みの場合は TypeScript マージをスキップ
  if (localRaw?._nixFunctionMerged) {
    const { _nixFunctionMerged: _, ...raw } = localRaw;
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
    // 明示パス指定時はそのまま読む（エラーはそのまま伝播）
    return await loadConfigByPath(configPath);
  }
  // .yml → .nix の順で探す
  for (const [filename, format] of [
    ["agent-sandbox.yml", "yml"],
    ["agent-sandbox.nix", "nix"],
  ] as const) {
    const candidate = path.join(getGlobalConfigDir(), filename);
    try {
      await stat(candidate);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e; // 予期しない stat エラー（権限不足など）は伝播
    }
    // ファイルが存在する場合、読み込み・解析エラーは伝播させる
    if (format === "yml") {
      const text = await readFile(candidate, "utf8");
      return Bun.YAML.parse(text) as RawConfig;
    }
    return await loadNixConfig(candidate);
  }
  return null;
}

/** パスから形式を判定して読み込む（エラーはそのまま伝播） */
async function loadConfigByPath(filePath: string): Promise<RawConfig> {
  if (filePath.endsWith(".nix")) {
    return await loadNixConfig(filePath);
  }
  const text = await readFile(filePath, "utf8");
  return Bun.YAML.parse(text) as RawConfig;
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
    nix: shallowMerge(global.nix, local.nix),
    docker: shallowMerge(global.docker, local.docker),
    gcloud: shallowMerge(global.gcloud, local.gcloud),
    aws: shallowMerge(global.aws, local.aws),
    gpg: shallowMerge(global.gpg, local.gpg),
    display: shallowMerge(global.display, local.display),
    network: mergeRawNetworkConfigs(global.network, local.network),
    dbus: mergeRawDbusConfigs(global.dbus, local.dbus),
    "extra-mounts": local["extra-mounts"] ?? global["extra-mounts"],
    env: local.env ?? global.env,
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
  format: "yml" | "nix";
}

/** ローカル設定ファイルを読み込む */
async function loadLocalConfig(
  found: ConfigFileFound,
  globalRaw?: RawConfig | null,
): Promise<RawConfig & { _nixFunctionMerged?: boolean }> {
  if (found.format === "yml") {
    return Bun.YAML.parse(await readFile(found.path, "utf8")) as RawConfig;
  }
  return await loadNixConfig(found.path, globalRaw ?? undefined);
}

/** nix コマンドが PATH 上に存在するか確認する */
async function nixCommandExists(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["nix", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * .agent-sandbox.nix を nix eval で評価して RawConfig を得る。
 *
 * Nix 式が関数の場合、globalRaw を引数 (super) として適用する。
 * 関数でマージされた場合、返り値に _nixFunctionMerged: true を付与する。
 */
async function loadNixConfig(
  nixPath: string,
  globalRaw?: RawConfig,
): Promise<RawConfig & { _nixFunctionMerged?: boolean }> {
  if (!(await nixCommandExists())) {
    throw new Error(
      `Found ${CONFIG_FILENAME_NIX} at ${nixPath}, but 'nix' command is not available on PATH. Install Nix or use ${CONFIG_FILENAME_YML} instead.`,
    );
  }

  const globalJson = JSON.stringify(globalRaw ?? {});

  // グローバル設定を一時ファイルに書き出す
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-global-"));
  const globalFile = path.join(tmpDir, "global.json");
  try {
    await writeFile(globalFile, globalJson);

    const nixPathArg = buildNixJsonStringLiteral(nixPath);
    const globalFileArg = buildNixJsonStringLiteral(globalFile);

    // Nix 式: 関数なら super を渡す、attrset ならそのまま返す
    const nixExpr = `
      let
        local = import (builtins.fromJSON ${nixPathArg});
        global = builtins.fromJSON (builtins.readFile (builtins.fromJSON ${globalFileArg}));
      in
        if builtins.isFunction local then
          { value = local global; __nixFunctionMerged = true; }
        else
          { value = local; __nixFunctionMerged = false; }
    `;
    const proc = Bun.spawn(
      ["nix", "eval", "--impure", "--json", "--expr", nixExpr],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      const errMsg = stderrText.trim();
      throw new Error(
        `Failed to evaluate ${nixPath}: nix eval exited with code ${code}\n${errMsg}`,
      );
    }
    const json = stdoutText;
    const result = JSON.parse(json) as {
      value: RawConfig;
      __nixFunctionMerged: boolean;
    };
    if (result.__nixFunctionMerged) {
      return { ...result.value, _nixFunctionMerged: true };
    }
    return result.value;
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }
}

/** 指定ディレクトリから上位に向かって設定ファイルを探す (.yml 優先、なければ .nix) */
async function findConfigFile(dir: string): Promise<ConfigFileFound | null> {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (true) {
    // .yml を優先
    for (const [filename, format] of [
      [CONFIG_FILENAME_YML, "yml"],
      [CONFIG_FILENAME_NIX, "nix"],
    ] as const) {
      const candidate = path.join(current, filename);
      try {
        await stat(candidate);
        return { path: candidate, format };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
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

function buildNixJsonStringLiteral(value: string): string {
  return JSON.stringify(JSON.stringify(value));
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
