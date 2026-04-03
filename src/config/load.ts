/**
 * YAML 設定ファイルの読み込み
 */

import { parse as parseYaml } from "@std/yaml";
import * as path from "@std/path";
import type { Config, RawConfig, RawProfile } from "./types.ts";
import { validateConfig } from "./validate.ts";

const CONFIG_FILENAME_YML = ".agent-sandbox.yml";
const CONFIG_FILENAME_NIX = ".agent-sandbox.nix";

/** グローバル設定ディレクトリ */
const GLOBAL_CONFIG_DIR = path.join(
  Deno.env.get("HOME") ?? "/",
  ".config",
  "nas",
);

/** loadConfig のオプション */
export interface LoadConfigOptions {
  /** 開始ディレクトリ（デフォルト: Deno.cwd()） */
  startDir?: string;
  /** グローバル設定ファイルのパス（null でグローバル読み込みを無効化） */
  globalConfigPath?: string | null;
}

/** 設定ファイルを読み込んで検証済み Config を返す */
export async function loadConfig(
  startDirOrOpts?: string | LoadConfigOptions,
): Promise<Config> {
  const opts: LoadConfigOptions = typeof startDirOrOpts === "string"
    ? { startDir: startDirOrOpts }
    : startDirOrOpts ?? {};

  const globalRaw = opts.globalConfigPath === null
    ? null
    : await loadGlobalConfig(opts.globalConfigPath);
  const found = await findConfigFile(opts.startDir ?? Deno.cwd());

  // Nix ローカル設定が関数の場合、グローバル設定を super として渡す
  const localRaw = found ? await loadLocalConfig(found, globalRaw) : null;

  if (!globalRaw && !localRaw) {
    throw new Error(
      `${CONFIG_FILENAME_YML} (or ${CONFIG_FILENAME_NIX}) not found in current directory or parent directories, and no global config found in ${GLOBAL_CONFIG_DIR}`,
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
    // 明示パス指定時はそのまま読む
    return await loadConfigByPath(configPath);
  }
  // .yml → .nix の順で探す
  for (
    const [filename, format] of [
      ["agent-sandbox.yml", "yml"],
      ["agent-sandbox.nix", "nix"],
    ] as const
  ) {
    const candidate = path.join(GLOBAL_CONFIG_DIR, filename);
    try {
      await Deno.stat(candidate);
      if (format === "yml") {
        const text = await Deno.readTextFile(candidate);
        return parseYaml(text) as RawConfig;
      }
      return await loadNixConfig(candidate);
    } catch {
      // not found, try next
    }
  }
  return null;
}

/** パスから形式を判定して読み込む */
async function loadConfigByPath(filePath: string): Promise<RawConfig | null> {
  try {
    if (filePath.endsWith(".nix")) {
      return await loadNixConfig(filePath);
    }
    const text = await Deno.readTextFile(filePath);
    return parseYaml(text) as RawConfig;
  } catch {
    return null;
  }
}

/** グローバルとローカルの RawConfig をマージする */
export function mergeRawConfigs(
  global: RawConfig | null,
  local: RawConfig | null,
): RawConfig {
  if (!global) return local!;
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
    } else {
      mergedProfiles[name] = (lp ?? gp)!;
    }
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
    return parseYaml(await Deno.readTextFile(found.path)) as RawConfig;
  }
  return await loadNixConfig(found.path, globalRaw ?? undefined);
}

/** nix コマンドが PATH 上に存在するか確認する */
async function nixCommandExists(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("nix", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
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
  if (!await nixCommandExists()) {
    throw new Error(
      `Found ${CONFIG_FILENAME_NIX} at ${nixPath}, but 'nix' command is not available on PATH. Install Nix or use ${CONFIG_FILENAME_YML} instead.`,
    );
  }

  const globalJson = JSON.stringify(globalRaw ?? {});

  // グローバル設定を一時ファイルに書き出す
  const globalFile = await Deno.makeTempFile({
    prefix: "nas-global-",
    suffix: ".json",
  });
  try {
    await Deno.writeTextFile(globalFile, globalJson);

    // Nix 式: 関数なら super を渡す、attrset ならそのまま返す
    const nixExpr = `
      let
        local = import ${nixPath};
        global = builtins.fromJSON (builtins.readFile ${globalFile});
      in
        if builtins.isFunction local then
          { value = local global; __nixFunctionMerged = true; }
        else
          { value = local; __nixFunctionMerged = false; }
    `;
    const cmd = new Deno.Command("nix", {
      args: ["eval", "--impure", "--json", "--expr", nixExpr],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) {
      const errMsg = new TextDecoder().decode(stderr).trim();
      throw new Error(
        `Failed to evaluate ${nixPath}: nix eval exited with code ${code}\n${errMsg}`,
      );
    }
    const json = new TextDecoder().decode(stdout);
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
      await Deno.remove(globalFile);
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
    for (
      const [filename, format] of [
        [CONFIG_FILENAME_YML, "yml"],
        [CONFIG_FILENAME_NIX, "nix"],
      ] as const
    ) {
      const candidate = path.join(current, filename);
      try {
        await Deno.stat(candidate);
        return { path: candidate, format };
      } catch {
        // not found, try next
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
      `Profile "${name}" not found. Available: ${
        Object.keys(config.profiles).join(", ")
      }`,
    );
  }
  return { name, profile };
}
