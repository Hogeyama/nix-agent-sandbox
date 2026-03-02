/**
 * .agent-sandbox.yml のバリデーション
 */

import type { Config, Profile, RawConfig, RawProfile } from "./types.ts";
import { DEFAULT_DOCKER_CONFIG, DEFAULT_NIX_CONFIG } from "./types.ts";
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
    worktree: raw.worktree
      ? {
        base: raw.worktree.base ?? "origin/main",
        onCreate: raw.worktree["on-create"] ?? "",
        onEnd: raw.worktree["on-end"] ?? "",
      }
      : undefined,
    nix: {
      enable: raw.nix?.enable ?? DEFAULT_NIX_CONFIG.enable,
      mountHostStore: raw.nix?.["mount-host-store"] ??
        DEFAULT_NIX_CONFIG.mountHostStore,
      extraPackages: raw.nix?.["extra-packages"] ??
        DEFAULT_NIX_CONFIG.extraPackages,
    },
    docker: {
      mountSocket: raw.docker?.["mount-socket"] ??
        DEFAULT_DOCKER_CONFIG.mountSocket,
    },
    env: raw.env ?? {},
  };
}
