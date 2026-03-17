/**
 * YAML 設定ファイルの読み込み
 */

import { parse as parseYaml } from "@std/yaml";
import * as path from "@std/path";
import type { Config, RawConfig, RawProfile } from "./types.ts";
import { validateConfig } from "./validate.ts";

const CONFIG_FILENAME = ".agent-sandbox.yml";

/** グローバル設定ファイルのパス */
export const GLOBAL_CONFIG_PATH = path.join(
  Deno.env.get("HOME") ?? "/",
  ".config",
  "nas",
  "agent-sandbox.yml",
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
  const localPath = await findConfigFile(opts.startDir ?? Deno.cwd());
  const localRaw = localPath
    ? parseYaml(await Deno.readTextFile(localPath)) as RawConfig
    : null;

  if (!globalRaw && !localRaw) {
    throw new Error(
      `${CONFIG_FILENAME} not found in current directory or parent directories`,
    );
  }

  const merged = mergeRawConfigs(globalRaw, localRaw);
  return validateConfig(merged);
}

/** グローバル設定ファイルを読み込む。なければ null */
export async function loadGlobalConfig(
  configPath?: string,
): Promise<RawConfig | null> {
  try {
    const text = await Deno.readTextFile(configPath ?? GLOBAL_CONFIG_PATH);
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
    network: mergeRawNetworkConfigs(global.network, local.network),
    dbus: mergeRawDbusConfigs(global.dbus, local.dbus),
    "extra-mounts": local["extra-mounts"] ?? global["extra-mounts"],
    env: local.env ?? global.env,
    secrets: local.secrets ?? global.secrets,
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

/** 指定ディレクトリから上位に向かって設定ファイルを探す */
async function findConfigFile(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, CONFIG_FILENAME);
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch {
      // not found, go up
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
