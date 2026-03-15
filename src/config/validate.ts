/**
 * .agent-sandbox.yml のバリデーション
 */

import type {
  Config,
  EnvConfig,
  EnvKeySpec,
  EnvValSpec,
  ExtraMountConfig,
  Profile,
  RawConfig,
  RawProfile,
} from "./types.ts";
import {
  DEFAULT_AWS_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_GPG_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_NIX_CONFIG,
} from "./types.ts";
import type { AgentType } from "./types.ts";

const VALID_AGENTS: AgentType[] = ["claude", "copilot", "codex"];

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
    worktree: raw.worktree ? validateWorktree(name, raw.worktree) : undefined,
    nix: {
      enable: raw.nix?.enable ?? DEFAULT_NIX_CONFIG.enable,
      mountSocket: raw.nix?.["mount-socket"] ??
        DEFAULT_NIX_CONFIG.mountSocket,
      extraPackages: raw.nix?.["extra-packages"] ??
        DEFAULT_NIX_CONFIG.extraPackages,
    },
    docker: {
      enable: raw.docker?.enable ??
        DEFAULT_DOCKER_CONFIG.enable,
      shared: raw.docker?.shared ??
        DEFAULT_DOCKER_CONFIG.shared,
    },
    gcloud: {
      mountConfig: raw.gcloud?.["mount-config"] ??
        DEFAULT_GCLOUD_CONFIG.mountConfig,
    },
    aws: {
      mountConfig: raw.aws?.["mount-config"] ??
        DEFAULT_AWS_CONFIG.mountConfig,
    },
    gpg: {
      forwardAgent: raw.gpg?.["forward-agent"] ??
        DEFAULT_GPG_CONFIG.forwardAgent,
    },
    network: {
      allowlist: validateAllowlist(name, raw.network?.allowlist),
    },
    extraMounts: validateExtraMounts(name, raw["extra-mounts"]),
    env: validateEnv(name, raw.env),
  };
}

function validateWorktree(
  _profileName: string,
  raw: NonNullable<RawProfile["worktree"]>,
): import("./types.ts").WorktreeConfig {
  return {
    base: raw.base ?? "origin/main",
    onCreate: raw["on-create"] ?? "",
  };
}

function validateExtraMounts(
  profileName: string,
  rawExtraMounts: RawProfile["extra-mounts"],
): ExtraMountConfig[] {
  if (!rawExtraMounts) return [];
  if (!Array.isArray(rawExtraMounts)) {
    throw new ConfigValidationError(
      `profile "${profileName}": extra-mounts must be a list`,
    );
  }

  return rawExtraMounts.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ConfigValidationError(
        `profile "${profileName}": extra-mounts[${index}] must be an object`,
      );
    }
    if (typeof entry.src !== "string" || entry.src.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": extra-mounts[${index}].src must be a non-empty string`,
      );
    }
    if (typeof entry.dst !== "string" || entry.dst.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": extra-mounts[${index}].dst must be a non-empty string`,
      );
    }

    const mode = entry.mode ?? "ro";
    if (mode !== "ro" && mode !== "rw") {
      throw new ConfigValidationError(
        `profile "${profileName}": extra-mounts[${index}].mode must be "ro" or "rw"`,
      );
    }

    return { src: entry.src, dst: entry.dst, mode };
  });
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
    const prefix = `profile "${profileName}": env[${index}]`;
    const keySpec = validateEnvKey(prefix, entry);
    const valSpec = validateEnvVal(prefix, entry);
    return { ...keySpec, ...valSpec } as EnvConfig;
  });
}

type RawEnvEntry = NonNullable<RawProfile["env"]>[number];

function validateEnvKey(prefix: string, entry: RawEnvEntry): EnvKeySpec {
  const hasKey = entry.key !== undefined;
  const hasKeyCmd = entry.key_cmd !== undefined;
  if (hasKey === hasKeyCmd) {
    throw new ConfigValidationError(
      `${prefix} must have exactly one of key or key_cmd`,
    );
  }
  if (hasKey) {
    if (typeof entry.key !== "string" || entry.key.trim() === "") {
      throw new ConfigValidationError(
        `${prefix}.key must be a non-empty string`,
      );
    }
    return { key: entry.key };
  }
  if (typeof entry.key_cmd !== "string" || entry.key_cmd.trim() === "") {
    throw new ConfigValidationError(
      `${prefix}.key_cmd must be a non-empty string`,
    );
  }
  return { keyCmd: entry.key_cmd };
}

function validateEnvVal(prefix: string, entry: RawEnvEntry): EnvValSpec {
  const hasVal = entry.val !== undefined;
  const hasValCmd = entry.val_cmd !== undefined;
  if (hasVal === hasValCmd) {
    throw new ConfigValidationError(
      `${prefix} must have exactly one of val or val_cmd`,
    );
  }
  if (hasVal) {
    if (typeof entry.val !== "string") {
      throw new ConfigValidationError(
        `${prefix}.val must be a string`,
      );
    }
    return { val: entry.val };
  }
  if (typeof entry.val_cmd !== "string" || entry.val_cmd.trim() === "") {
    throw new ConfigValidationError(
      `${prefix}.val_cmd must be a non-empty string`,
    );
  }
  return { valCmd: entry.val_cmd };
}

function validateAllowlist(profileName: string, raw?: unknown): string[] {
  if (!raw) return DEFAULT_NETWORK_CONFIG.allowlist;
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      `profile "${profileName}": network.allowlist must be a list`,
    );
  }
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": network.allowlist[${i}] must be a non-empty string`,
      );
    }
    // *.domain.com は許可、それ以外の位置に * があればエラー
    const domain = entry.startsWith("*.") ? entry.slice(2) : entry;
    if (domain.includes("*")) {
      throw new ConfigValidationError(
        `profile "${profileName}": network.allowlist[${i}] ("${entry}") contains wildcard "*" in an invalid position; only "*.domain.com" prefix form is allowed`,
      );
    }
  }
  return raw as string[];
}
