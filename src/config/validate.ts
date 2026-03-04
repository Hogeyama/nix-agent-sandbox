/**
 * .agent-sandbox.yml のバリデーション
 */

import type {
  CommandEnvConfig,
  Config,
  EnvConfig,
  Profile,
  RawConfig,
  RawProfile,
  StaticEnvConfig,
} from "./types.ts";
import { DEFAULT_DOCKER_CONFIG, DEFAULT_GCLOUD_CONFIG, DEFAULT_NIX_CONFIG } from "./types.ts";
import type { AgentType } from "./types.ts";

const VALID_AGENTS: AgentType[] = ["claude", "copilot"];

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/** RawConfig を検証して Config に変換 */
export function validateConfig(raw: RawConfig): Config {
  if (!raw.profiles || Object.keys(raw.profiles).length === 0) {
    throw new ConfigValidationError("profiles must contain at least one entry");
  }

  const profiles: Record<string, Profile> = {};
  for (const [name, rawProfile] of Object.entries(raw.profiles)) {
    profiles[name] = validateProfile(name, rawProfile);
  }

  if (raw.default && !(raw.default in profiles)) {
    throw new ConfigValidationError(
      `default profile "${raw.default}" not found in profiles`,
    );
  }

  return {
    default: raw.default,
    profiles,
  };
}

function validateProfile(name: string, raw: RawProfile): Profile {
  if (!raw.agent || !VALID_AGENTS.includes(raw.agent as AgentType)) {
    throw new ConfigValidationError(
      `profile "${name}": agent must be one of: ${VALID_AGENTS.join(", ")}`,
    );
  }

  return {
    agent: raw.agent as AgentType,
    agentArgs: raw["agent-args"] ?? [],
    worktree: raw.worktree
      ? {
        base: raw.worktree.base ?? "origin/main",
        onCreate: raw.worktree["on-create"] ?? "",
        onEnd: raw.worktree["on-end"] ?? "",
      }
      : undefined,
    nix: {
      enable: raw.nix?.enable ?? DEFAULT_NIX_CONFIG.enable,
      mountSocket: raw.nix?.["mount-socket"] ??
        DEFAULT_NIX_CONFIG.mountSocket,
      extraPackages: raw.nix?.["extra-packages"] ??
        DEFAULT_NIX_CONFIG.extraPackages,
    },
    docker: {
      mountSocket: raw.docker?.["mount-socket"] ??
        DEFAULT_DOCKER_CONFIG.mountSocket,
    },
    gcloud: {
      mountConfig: raw.gcloud?.["mount-config"] ??
        DEFAULT_GCLOUD_CONFIG.mountConfig,
    },
    env: validateEnv(name, raw.env),
  };
}

function validateEnv(
  profileName: string,
  rawEnv: RawProfile["env"],
): EnvConfig[] {
  if (!rawEnv) return [];
  if (!Array.isArray(rawEnv)) {
    throw new ConfigValidationError(
      `profile "${profileName}": env must be a list`,
    );
  }

  return rawEnv.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ConfigValidationError(
        `profile "${profileName}": env[${index}] must be an object`,
      );
    }
    const hasStatic = entry.key !== undefined || entry.val !== undefined;
    const hasCommand = entry.key_cmd !== undefined || entry.val_cmd !== undefined;
    if (hasStatic && hasCommand) {
      throw new ConfigValidationError(
        `profile "${profileName}": env[${index}] must use either (key,val) or (key_cmd,val_cmd)`,
      );
    }

    if (hasStatic) {
      if (typeof entry.key !== "string" || entry.key.trim() === "") {
        throw new ConfigValidationError(
          `profile "${profileName}": env[${index}].key must be a non-empty string`,
        );
      }
      if (typeof entry.val !== "string") {
        throw new ConfigValidationError(
          `profile "${profileName}": env[${index}].val must be a string`,
        );
      }
      const staticEntry: StaticEnvConfig = { key: entry.key, val: entry.val };
      return staticEntry;
    }

    if (typeof entry.key_cmd !== "string" || entry.key_cmd.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": env[${index}].key_cmd must be a non-empty string`,
      );
    }
    if (typeof entry.val_cmd !== "string" || entry.val_cmd.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": env[${index}].val_cmd must be a non-empty string`,
      );
    }
    const commandEntry: CommandEnvConfig = {
      keyCmd: entry.key_cmd,
      valCmd: entry.val_cmd,
    };
    return commandEntry;
  });
}
