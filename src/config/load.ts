/**
 * YAML 設定ファイルの読み込み
 */

import { parse as parseYaml } from "@std/yaml";
import * as path from "@std/path";
import type { Config, RawConfig } from "./types.ts";
import { validateConfig } from "./validate.ts";

const CONFIG_FILENAME = ".agent-sandbox.yml";

/** 設定ファイルを読み込んで検証済み Config を返す */
export async function loadConfig(startDir?: string): Promise<Config> {
  const configPath = await findConfigFile(startDir ?? Deno.cwd());
  if (!configPath) {
    throw new Error(
      `${CONFIG_FILENAME} not found in current directory or parent directories`,
    );
  }

  const text = await Deno.readTextFile(configPath);
  const raw = parseYaml(text) as RawConfig;
  return validateConfig(raw);
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
