/**
 * .agent-sandbox.yml のバリデーション
 */

import type { ApprovalScope } from "../network/protocol.ts";
import type {
  Config,
  DbusRuleConfig,
  EnvConfig,
  EnvKeySpec,
  EnvValSpec,
  ExtraMountConfig,
  HostExecApproval,
  HostExecConfig,
  HostExecCwdConfig,
  HostExecCwdMode,
  HostExecFallback,
  HostExecInheritEnvConfig,
  HostExecInheritEnvMode,
  HostExecPromptConfig,
  HostExecPromptNotify,
  HostExecPromptScope,
  HostExecRule,
  NetworkPromptConfig,
  NetworkPromptNotify,
  Profile,
  RawConfig,
  RawProfile,
  SecretConfig,
} from "./types.ts";
import {
  DEFAULT_AWS_CONFIG,
  DEFAULT_DBUS_SESSION_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_GPG_CONFIG,
  DEFAULT_HOSTEXEC_CONFIG,
  DEFAULT_HOSTEXEC_CWD_CONFIG,
  DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG,
  DEFAULT_HOSTEXEC_PROMPT_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_NETWORK_PROMPT_CONFIG,
  DEFAULT_NIX_CONFIG,
} from "./types.ts";
import type { AgentType } from "./types.ts";

const VALID_AGENTS: AgentType[] = ["claude", "copilot", "codex"];
const VALID_PROMPT_SCOPES: ApprovalScope[] = ["once", "host-port", "host"];
const VALID_PROMPT_NOTIFIES: NetworkPromptNotify[] = [
  "auto",
  "tmux",
  "desktop",
  "off",
];
const VALID_HOSTEXEC_APPROVALS: HostExecApproval[] = [
  "allow",
  "prompt",
  "deny",
];
const VALID_HOSTEXEC_FALLBACKS: HostExecFallback[] = ["container", "deny"];
const VALID_HOSTEXEC_CWD_MODES: HostExecCwdMode[] = [
  "workspace-only",
  "workspace-or-session-tmp",
  "allowlist",
  "any",
];
const VALID_HOSTEXEC_INHERIT_ENV_MODES: HostExecInheritEnvMode[] = [
  "minimal",
  "unsafe-inherit-all",
];
const VALID_HOSTEXEC_PROMPT_SCOPES: HostExecPromptScope[] = [
  "once",
  "capability",
];
const VALID_HOSTEXEC_PROMPT_NOTIFIES: HostExecPromptNotify[] = [
  "auto",
  "tmux",
  "desktop",
  "off",
];

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
  if ("secrets" in raw) {
    throw new ConfigValidationError(
      `profile "${name}": secrets has moved to hostexec.secrets`,
    );
  }

  const network = validateNetwork(name, raw.network);
  const dbus = validateDbus(name, raw.dbus);

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
    network,
    dbus,
    extraMounts: validateExtraMounts(name, raw["extra-mounts"]),
    env: validateEnv(name, raw.env),
    hostexec: validateHostExec(name, raw.hostexec),
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

function validateNetwork(
  profileName: string,
  raw?: RawProfile["network"],
): import("./types.ts").NetworkConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(
      `profile "${profileName}": network must be an object`,
    );
  }

  return {
    allowlist: validateAllowlist(profileName, raw?.allowlist),
    prompt: validateNetworkPrompt(profileName, raw?.prompt),
  };
}

function validateNetworkPrompt(
  profileName: string,
  raw?: NonNullable<NonNullable<RawProfile["network"]>["prompt"]>,
): NetworkPromptConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(
      `profile "${profileName}": network.prompt must be an object`,
    );
  }

  const timeoutSeconds = raw?.["timeout-seconds"] ??
    DEFAULT_NETWORK_PROMPT_CONFIG.timeoutSeconds;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new ConfigValidationError(
      `profile "${profileName}": network.prompt.timeout-seconds must be a positive integer`,
    );
  }

  const defaultScope = raw?.["default-scope"] ??
    DEFAULT_NETWORK_PROMPT_CONFIG.defaultScope;
  if (!VALID_PROMPT_SCOPES.includes(defaultScope)) {
    throw new ConfigValidationError(
      `profile "${profileName}": network.prompt.default-scope must be one of: ${
        VALID_PROMPT_SCOPES.join(", ")
      }`,
    );
  }

  const notify = raw?.notify ?? DEFAULT_NETWORK_PROMPT_CONFIG.notify;
  if (!VALID_PROMPT_NOTIFIES.includes(notify)) {
    throw new ConfigValidationError(
      `profile "${profileName}": network.prompt.notify must be one of: ${
        VALID_PROMPT_NOTIFIES.join(", ")
      }`,
    );
  }

  return {
    enable: raw?.enable ?? DEFAULT_NETWORK_PROMPT_CONFIG.enable,
    timeoutSeconds,
    defaultScope,
    notify,
  };
}

function validateDbus(
  profileName: string,
  raw?: RawProfile["dbus"],
): import("./types.ts").DbusConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(
      `profile "${profileName}": dbus must be an object`,
    );
  }

  return {
    session: validateDbusSession(profileName, raw?.session),
  };
}

function validateDbusSession(
  profileName: string,
  raw?: NonNullable<RawProfile["dbus"]>["session"],
): import("./types.ts").DbusSessionConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(
      `profile "${profileName}": dbus.session must be an object`,
    );
  }

  const sourceAddress = raw?.["source-address"];
  if (sourceAddress !== undefined) {
    if (typeof sourceAddress !== "string" || sourceAddress.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": dbus.session.source-address must be a non-empty string`,
      );
    }
  }

  return {
    enable: raw?.enable ?? DEFAULT_DBUS_SESSION_CONFIG.enable,
    sourceAddress,
    see: validateDbusNameList(profileName, "dbus.session.see", raw?.see),
    talk: validateDbusNameList(profileName, "dbus.session.talk", raw?.talk),
    own: validateDbusNameList(profileName, "dbus.session.own", raw?.own),
    calls: validateDbusRules(profileName, "dbus.session.calls", raw?.calls),
    broadcasts: validateDbusRules(
      profileName,
      "dbus.session.broadcasts",
      raw?.broadcasts,
    ),
  };
}

function validateDbusNameList(
  profileName: string,
  field: string,
  raw?: string[],
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      `profile "${profileName}": ${field} must be a list`,
    );
  }
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": ${field}[${index}] must be a non-empty string`,
      );
    }
  }
  return [...raw];
}

function validateDbusRules(
  profileName: string,
  field: string,
  raw?: Array<{ name?: string; rule?: string }>,
): DbusRuleConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      `profile "${profileName}": ${field} must be a list`,
    );
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ConfigValidationError(
        `profile "${profileName}": ${field}[${index}] must be an object`,
      );
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": ${field}[${index}].name must be a non-empty string`,
      );
    }
    if (typeof entry.rule !== "string" || entry.rule.trim() === "") {
      throw new ConfigValidationError(
        `profile "${profileName}": ${field}[${index}].rule must be a non-empty string`,
      );
    }
    return {
      name: entry.name,
      rule: entry.rule,
    };
  });
}

function validateSecrets(
  profileName: string,
  rawSecrets: NonNullable<RawProfile["hostexec"]>["secrets"] | undefined,
  fieldPath = "hostexec.secrets",
): Record<string, SecretConfig> {
  if (!rawSecrets) return {};
  if (typeof rawSecrets !== "object" || Array.isArray(rawSecrets)) {
    throw new ConfigValidationError(
      `profile "${profileName}": ${fieldPath} must be an object`,
    );
  }

  const result: Record<string, SecretConfig> = {};
  for (const [name, entry] of Object.entries(rawSecrets)) {
    const prefix = `profile "${profileName}": ${fieldPath}.${name}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigValidationError(`${prefix} must be an object`);
    }
    if (typeof entry.from !== "string" || entry.from.trim() === "") {
      throw new ConfigValidationError(
        `${prefix}.from must be a non-empty string`,
      );
    }
    if (!isValidSecretSource(entry.from)) {
      throw new ConfigValidationError(
        `${prefix}.from must start with env:, file:, dotenv:, or keyring:`,
      );
    }
    result[name] = {
      from: entry.from,
      required: entry.required ?? true,
    };
  }
  return result;
}

function validateHostExec(
  profileName: string,
  raw: RawProfile["hostexec"],
): HostExecConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(
      `profile "${profileName}": hostexec must be an object`,
    );
  }

  return {
    prompt: validateHostExecPrompt(profileName, raw?.prompt),
    secrets: validateSecrets(profileName, raw?.secrets),
    rules: validateHostExecRules(profileName, raw?.rules, raw?.secrets),
  };
}

function validateHostExecPrompt(
  profileName: string,
  raw?: NonNullable<NonNullable<RawProfile["hostexec"]>["prompt"]>,
): HostExecPromptConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(
      `profile "${profileName}": hostexec.prompt must be an object`,
    );
  }
  const timeoutSeconds = raw?.["timeout-seconds"] ??
    DEFAULT_HOSTEXEC_PROMPT_CONFIG.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ConfigValidationError(
      `profile "${profileName}": hostexec.prompt.timeout-seconds must be a positive integer`,
    );
  }
  const defaultScope = raw?.["default-scope"] ??
    DEFAULT_HOSTEXEC_PROMPT_CONFIG.defaultScope;
  if (!VALID_HOSTEXEC_PROMPT_SCOPES.includes(defaultScope)) {
    throw new ConfigValidationError(
      `profile "${profileName}": hostexec.prompt.default-scope must be one of: ${
        VALID_HOSTEXEC_PROMPT_SCOPES.join(", ")
      }`,
    );
  }
  const notify = raw?.notify ?? DEFAULT_HOSTEXEC_PROMPT_CONFIG.notify;
  if (!VALID_HOSTEXEC_PROMPT_NOTIFIES.includes(notify)) {
    throw new ConfigValidationError(
      `profile "${profileName}": hostexec.prompt.notify must be one of: ${
        VALID_HOSTEXEC_PROMPT_NOTIFIES.join(", ")
      }`,
    );
  }
  return {
    enable: raw?.enable ?? DEFAULT_HOSTEXEC_CONFIG.prompt.enable,
    timeoutSeconds,
    defaultScope,
    notify,
  };
}

function validateHostExecRules(
  profileName: string,
  rawRules: NonNullable<RawProfile["hostexec"]>["rules"] | undefined,
  rawSecrets: NonNullable<RawProfile["hostexec"]>["secrets"] | undefined,
): HostExecRule[] {
  if (!rawRules) return [];
  if (!Array.isArray(rawRules)) {
    throw new ConfigValidationError(
      `profile "${profileName}": hostexec.rules must be a list`,
    );
  }

  const secretNames = new Set(Object.keys(rawSecrets ?? {}));
  return rawRules.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ConfigValidationError(
        `profile "${profileName}": hostexec.rules[${index}] must be an object`,
      );
    }
    const prefix = `profile "${profileName}": hostexec.rules[${index}]`;
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new ConfigValidationError(
        `${prefix}.id must be a non-empty string`,
      );
    }
    const match = entry.match;
    if (!match || typeof match !== "object") {
      throw new ConfigValidationError(`${prefix}.match must be an object`);
    }
    if (typeof match.argv0 !== "string" || match.argv0.trim() === "") {
      throw new ConfigValidationError(
        `${prefix}.match.argv0 must be a non-empty string`,
      );
    }

    let argRegex: string | undefined;
    if (match["arg-regex"] !== undefined) {
      if (
        typeof match["arg-regex"] !== "string" ||
        match["arg-regex"].trim() === ""
      ) {
        throw new ConfigValidationError(
          `${prefix}.match.arg-regex must be a non-empty string when provided`,
        );
      }
      try {
        new RegExp(match["arg-regex"]);
      } catch {
        throw new ConfigValidationError(
          `${prefix}.match.arg-regex is not a valid regular expression: ${
            match["arg-regex"]
          }`,
        );
      }
      argRegex = match["arg-regex"];
    }

    const env = validateHostExecEnv(prefix, entry.env, secretNames);
    return {
      id: entry.id,
      match: {
        argv0: match.argv0,
        argRegex,
      },
      cwd: validateHostExecCwd(prefix, entry.cwd),
      env,
      inheritEnv: validateHostExecInheritEnv(prefix, entry["inherit-env"]),
      approval: validateHostExecApproval(prefix, entry.approval),
      fallback: validateHostExecFallback(prefix, entry.fallback),
    };
  });
}

function validateHostExecEnv(
  prefix: string,
  raw: Record<string, string> | undefined,
  secretNames: Set<string>,
): Record<string, string> {
  if (!raw) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(`${prefix}.env must be an object`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigValidationError(
        `${prefix}.env contains invalid key: ${key}`,
      );
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigValidationError(
        `${prefix}.env.${key} must be a non-empty string`,
      );
    }
    if (!value.startsWith("secret:")) {
      throw new ConfigValidationError(
        `${prefix}.env.${key} must use secret:<name> reference`,
      );
    }
    const secretName = value.slice("secret:".length);
    if (!secretNames.has(secretName)) {
      throw new ConfigValidationError(
        `${prefix}.env.${key} references unknown secret "${secretName}"`,
      );
    }
    env[key] = value;
  }
  return env;
}

function validateHostExecCwd(
  prefix: string,
  raw?: NonNullable<
    NonNullable<RawProfile["hostexec"]>["rules"]
  >[number]["cwd"],
): HostExecCwdConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(`${prefix}.cwd must be an object`);
  }
  const mode = raw?.mode ?? DEFAULT_HOSTEXEC_CWD_CONFIG.mode;
  if (!VALID_HOSTEXEC_CWD_MODES.includes(mode)) {
    throw new ConfigValidationError(
      `${prefix}.cwd.mode must be one of: ${
        VALID_HOSTEXEC_CWD_MODES.join(", ")
      }`,
    );
  }
  const allow = raw?.allow ?? [];
  if (
    !Array.isArray(allow) ||
    allow.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new ConfigValidationError(
      `${prefix}.cwd.allow must be a list of strings`,
    );
  }
  if (mode !== "allowlist" && allow.length > 0) {
    throw new ConfigValidationError(
      `${prefix}.cwd.allow is only valid with mode=allowlist`,
    );
  }
  return { mode, allow };
}

function validateHostExecInheritEnv(
  prefix: string,
  raw?: NonNullable<
    NonNullable<
      NonNullable<RawProfile["hostexec"]>["rules"]
    >[number]["inherit-env"]
  >,
): HostExecInheritEnvConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigValidationError(`${prefix}.inherit-env must be an object`);
  }
  const mode = raw?.mode ?? DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG.mode;
  if (!VALID_HOSTEXEC_INHERIT_ENV_MODES.includes(mode)) {
    throw new ConfigValidationError(
      `${prefix}.inherit-env.mode must be one of: ${
        VALID_HOSTEXEC_INHERIT_ENV_MODES.join(", ")
      }`,
    );
  }
  const keys = raw?.keys ?? [];
  if (
    !Array.isArray(keys) ||
    keys.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new ConfigValidationError(
      `${prefix}.inherit-env.keys must be a list of strings`,
    );
  }
  return { mode, keys };
}

function validateHostExecApproval(
  prefix: string,
  raw?: string,
): HostExecApproval {
  const approval = raw ?? "prompt";
  if (!VALID_HOSTEXEC_APPROVALS.includes(approval as HostExecApproval)) {
    throw new ConfigValidationError(
      `${prefix}.approval must be one of: ${
        VALID_HOSTEXEC_APPROVALS.join(", ")
      }`,
    );
  }
  return approval as HostExecApproval;
}

function validateHostExecFallback(
  prefix: string,
  raw?: string,
): HostExecFallback {
  const fallback = raw ?? "container";
  if (!VALID_HOSTEXEC_FALLBACKS.includes(fallback as HostExecFallback)) {
    throw new ConfigValidationError(
      `${prefix}.fallback must be one of: ${
        VALID_HOSTEXEC_FALLBACKS.join(", ")
      }`,
    );
  }
  return fallback as HostExecFallback;
}

function isValidSecretSource(value: string): boolean {
  return value.startsWith("env:") || value.startsWith("file:") ||
    value.startsWith("dotenv:") || value.startsWith("keyring:");
}
