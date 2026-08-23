/**
 * 設定ファイルのセマンティックバリデーション
 *
 * Pkl の型検査を前提とし、構造・型・enum・デフォルト値は Pkl 側で保証される。
 * ここでは Pkl では表現しにくいクロスフィールド制約や実行時セマンティクスのみ検証する。
 */

import { SECRET_SOURCE_PREFIXES } from "../hostexec/secret_store.ts";
import { logWarn } from "../log.ts";
import { validateAuthzConfig } from "../network/authz/validate.ts";
import type { Config, HostExecRule, Profile, SecretConfig } from "./types.ts";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/** Config 型を前提としたセマンティック検証 */
export function validateConfig(config: Config): Config {
  const errors: string[] = [];

  // --- profiles が存在し空でないこと ---
  if (!config.profiles || Object.keys(config.profiles).length === 0) {
    throw new ConfigValidationError("profiles must contain at least one entry");
  }

  // --- default プロファイルが profiles に存在すること ---
  if (config.default && !(config.default in config.profiles)) {
    throw new ConfigValidationError(
      `default profile "${config.default}" not found in profiles`,
    );
  }

  // --- 各プロファイルのセマンティック検証 ---
  for (const [name, profile] of Object.entries(config.profiles)) {
    errors.push(...validateProfile(name, profile));
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors.join("\n"));
  }

  return config;
}

function validateProfile(name: string, profile: Profile): string[] {
  const errors: string[] = [];

  // --- 秘密のレジストリと、それを使うネットワーク認可 ---
  errors.push(...validateSecretRegistry(name, profile.secrets));
  errors.push(...validateAuthz(name, profile));

  // --- forwardPorts の予約ポート(18080)・重複検出 ---
  errors.push(
    ...validateForwardPorts(name, profile.network.proxy.forwardPorts),
  );

  errors.push(
    ...validateRequestBodyAudit(name, profile.network.requestBodyAudit),
  );

  // --- nix.extraPackages の入力検証 ---
  errors.push(...validateNixExtraPackages(name, profile.nix.extraPackages));

  // --- display.size フォーマット検証 ---
  errors.push(...validateDisplaySize(name, profile.display.size));

  // --- D-Bus ルール名の検証 ---
  errors.push(...validateDbusRules(name, profile.dbus));

  // --- env の mode/separator 相互依存 ---
  errors.push(...validateEnvEntries(name, profile.env));

  // --- hostexec ---
  if (profile.hostexec) {
    // hostexec env の secret 参照検証
    const secretNames = new Set(Object.keys(profile.hostexec.secrets));
    for (const [i, rule] of profile.hostexec.rules.entries()) {
      errors.push(...validateHostExecRuleEnv(name, i, rule, secretNames));
      errors.push(...validateHostExecRuleEnvKeys(name, i, rule));
      errors.push(...validateHostExecRuleCwdAllow(name, i, rule));
      errors.push(...validateHostExecRuleArgRegex(name, i, rule));
    }

    // hostexec rules の overlapping 警告
    warnOverlappingHostExecRules(name, profile.hostexec.rules);
  }

  // --- mask ---
  if (profile.mask) {
    for (const field of ["maskfs", "proxy", "filter"] as const) {
      if (typeof profile.mask[field] !== "boolean") {
        errors.push(`profile "${name}": mask.${field} must be a boolean`);
      }
    }
    for (const [i, secretName] of (profile.mask.apply ?? []).entries()) {
      if (!(secretName in profile.secrets)) {
        errors.push(
          `profile "${name}": mask.apply[${i}] ("${secretName}") is not a name in secrets`,
        );
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Secret registry
// ---------------------------------------------------------------------------

function validateSecretRegistry(
  profileName: string,
  secrets: Record<string, SecretConfig>,
): string[] {
  const errors: string[] = [];
  for (const [secretName, secret] of Object.entries(secrets)) {
    const source = secret.from;
    if (typeof source !== "string" || source.trim() === "") {
      errors.push(
        `profile "${profileName}": secrets["${secretName}"].from must be a non-empty string`,
      );
      continue;
    }
    if (!SECRET_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix))) {
      errors.push(
        `profile "${profileName}": secrets["${secretName}"].from ("${source}") must start with one of ${SECRET_SOURCE_PREFIXES.join(", ")} (literal values are not supported)`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Network authorization
// ---------------------------------------------------------------------------

/**
 * Headers a config may not inject.
 *
 * They describe the connection or the message framing rather than the
 * caller, so overwriting one rewrites how the proxied request is
 * transported — or, for `proxy-authorization`, hands the agent's own
 * session credential to the upstream host.
 */
const FORBIDDEN_INJECT_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

function validateAuthz(profileName: string, profile: Profile): string[] {
  const errors: string[] = [];
  const prefix = `profile "${profileName}": `;

  for (const diagnostic of validateAuthzConfig({
    secrets: profile.secrets,
    mask: profile.mask,
    network: profile.network,
  })) {
    if (diagnostic.severity === "warning") {
      logWarn(`[warn] ${prefix}${diagnostic.message}`);
      continue;
    }
    errors.push(prefix + diagnostic.message);
  }

  for (const [scopeName, scope] of Object.entries(profile.network.scopes)) {
    const injects = [
      ...(scope.inject ?? []),
      ...Object.values(scope.rules ?? {}).flatMap((rule) => rule.inject ?? []),
    ];
    for (const entry of injects) {
      const header = entry.name.trim();
      if (header === "") {
        errors.push(
          `${prefix}スコープ ${scopeName} の inject にヘッダー名がありません。`,
        );
      } else if (FORBIDDEN_INJECT_HEADERS.has(header.toLowerCase())) {
        errors.push(
          `${prefix}スコープ ${scopeName} の inject が注入を禁じられたヘッダー ${header} を指しています。`,
        );
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Forward ports validation
// ---------------------------------------------------------------------------

function validateForwardPorts(profileName: string, ports: number[]): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const [i, port] of ports.entries()) {
    if (port === 18080) {
      errors.push(
        `profile "${profileName}": proxy.forwardPorts[${i}] port 18080 is reserved for the internal authentication proxy`,
      );
    }
    if (seen.has(port)) {
      errors.push(
        `profile "${profileName}": proxy.forwardPorts[${i}] duplicate port ${port}`,
      );
    }
    seen.add(port);
  }
  return errors;
}

function validateRequestBodyAudit(
  profileName: string,
  config: Profile["network"]["requestBodyAudit"],
): string[] {
  const errors: string[] = [];
  const prefix = `profile "${profileName}": requestBodyAudit`;
  const positiveSafeIntegers = [
    ["retentionSeconds", config.retentionSeconds],
    ["maxBodyBytes", config.maxBodyBytes],
    ["maxTotalBytes", config.maxTotalBytes],
  ] as const;

  for (const [field, value] of positiveSafeIntegers) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push(`${prefix}.${field} must be a positive safe integer`);
    }
  }

  if (
    Number.isSafeInteger(config.maxBodyBytes) &&
    config.maxBodyBytes > 33_554_432
  ) {
    errors.push(`${prefix}.maxBodyBytes must be at most 33554432`);
  }
  if (
    Number.isSafeInteger(config.maxBodyBytes) &&
    config.maxBodyBytes > 0 &&
    Number.isSafeInteger(config.maxTotalBytes) &&
    config.maxTotalBytes > 0 &&
    config.maxTotalBytes < config.maxBodyBytes
  ) {
    errors.push(
      `${prefix}.maxTotalBytes must be greater than or equal to requestBodyAudit.maxBodyBytes`,
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Env mode/separator cross-validation
// ---------------------------------------------------------------------------

function validateEnvEntries(
  profileName: string,
  envEntries: Profile["env"],
): string[] {
  const errors: string[] = [];
  for (const [i, entry] of envEntries.entries()) {
    const mode = entry.mode;
    if (mode === "set") {
      if (entry.separator !== undefined) {
        errors.push(
          `profile "${profileName}": env[${i}].separator is only allowed when mode is "prefix" or "suffix"`,
        );
      }
    } else {
      if (entry.separator === undefined) {
        errors.push(
          `profile "${profileName}": env[${i}].separator is required when mode is "${mode}"`,
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Nix extraPackages validation (F1)
// ---------------------------------------------------------------------------

function validateNixExtraPackages(
  profileName: string,
  extraPackages: string[],
): string[] {
  const errors: string[] = [];
  for (const [i, pkg] of extraPackages.entries()) {
    if (pkg.startsWith("-")) {
      errors.push(
        `profile "${profileName}": nix.extraPackages[${i}] ("${pkg}") must not start with "-" (flag injection)`,
      );
    }
    if (pkg.includes("..")) {
      errors.push(
        `profile "${profileName}": nix.extraPackages[${i}] ("${pkg}") must not contain ".." (path traversal)`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Display size validation (F2)
// ---------------------------------------------------------------------------

const DISPLAY_SIZE_RE = /^\d+x\d+$/;
const DISPLAY_MAX_DIMENSION = 16384;

function validateDisplaySize(profileName: string, size: string): string[] {
  const errors: string[] = [];
  if (!DISPLAY_SIZE_RE.test(size)) {
    errors.push(
      `profile "${profileName}": display.size ("${size}") must match "<width>x<height>" (digits only)`,
    );
    return errors;
  }
  const [w, h] = size.split("x").map(Number);
  if (w < 1 || w > DISPLAY_MAX_DIMENSION) {
    errors.push(
      `profile "${profileName}": display.size width ${w} out of range 1-${DISPLAY_MAX_DIMENSION}`,
    );
  }
  if (h < 1 || h > DISPLAY_MAX_DIMENSION) {
    errors.push(
      `profile "${profileName}": display.size height ${h} out of range 1-${DISPLAY_MAX_DIMENSION}`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// D-Bus rules validation (F3)
// ---------------------------------------------------------------------------

const DBUS_NAME_RE = /^[A-Za-z_-][A-Za-z0-9_.-]*\*?$/;

function validateDbusRules(
  profileName: string,
  dbus: Config["profiles"][string]["dbus"],
): string[] {
  const errors: string[] = [];
  const session = dbus.session;

  // Validate see/talk/own arrays (simple well-known names)
  for (const field of ["see", "talk", "own"] as const) {
    for (const [i, name] of session[field].entries()) {
      if (name.includes("=")) {
        errors.push(
          `profile "${profileName}": dbus.session.${field}[${i}] ("${name}") must not contain "=" (argument injection)`,
        );
      }
      if (!DBUS_NAME_RE.test(name)) {
        errors.push(
          `profile "${profileName}": dbus.session.${field}[${i}] ("${name}") is not a valid D-Bus well-known name`,
        );
      }
    }
  }

  // Validate calls/broadcasts rule objects
  for (const field of ["calls", "broadcasts"] as const) {
    for (const [i, entry] of session[field].entries()) {
      // name: full D-Bus well-known name validation (includes = check)
      const name = entry.name;
      if (name.includes("=")) {
        errors.push(
          `profile "${profileName}": dbus.session.${field}[${i}].name ("${name}") must not contain "=" (argument injection)`,
        );
      }
      if (!DBUS_NAME_RE.test(name)) {
        errors.push(
          `profile "${profileName}": dbus.session.${field}[${i}].name ("${name}") is not a valid D-Bus well-known name`,
        );
      }

      // rule: only = injection check (rules can contain non-name values
      // like wildcards or member@path syntax used by xdg-dbus-proxy)
      const rule = entry.rule;
      if (rule.includes("=")) {
        errors.push(
          `profile "${profileName}": dbus.session.${field}[${i}].rule ("${rule}") must not contain "=" (argument injection)`,
        );
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// HostExec rule env key validation (F4)
// ---------------------------------------------------------------------------

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateHostExecRuleEnvKeys(
  profileName: string,
  ruleIndex: number,
  rule: HostExecRule,
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(rule.env)) {
    if (!ENV_KEY_RE.test(key)) {
      errors.push(
        `profile "${profileName}": hostexec.rules[${ruleIndex}].env key "${key}" is not a valid environment variable name`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// HostExec cwd.allow cross-field constraint (F5)
// ---------------------------------------------------------------------------

function validateHostExecRuleCwdAllow(
  profileName: string,
  ruleIndex: number,
  rule: HostExecRule,
): string[] {
  const errors: string[] = [];
  if (rule.cwd.allow.length > 0 && rule.cwd.mode !== "allowlist") {
    errors.push(
      `profile "${profileName}": hostexec.rules[${ruleIndex}].cwd.allow is non-empty but cwd.mode is "${rule.cwd.mode}" (must be "allowlist")`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// HostExec argRegex syntax validation (F7)
// ---------------------------------------------------------------------------

function validateHostExecRuleArgRegex(
  profileName: string,
  ruleIndex: number,
  rule: HostExecRule,
): string[] {
  const errors: string[] = [];
  if (rule.match.argRegex !== undefined) {
    try {
      new RegExp(rule.match.argRegex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(
        `profile "${profileName}": hostexec.rules[${ruleIndex}].match.argRegex ("${rule.match.argRegex}") is not a valid regular expression: ${msg}`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// HostExec rule env validation
// ---------------------------------------------------------------------------

function validateHostExecRuleEnv(
  profileName: string,
  ruleIndex: number,
  rule: HostExecRule,
  secretNames: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(rule.env)) {
    if (!value.startsWith("secret:")) {
      errors.push(
        `profile "${profileName}": hostexec.rules[${ruleIndex}].env.${key} must use secret:<name> reference`,
      );
      continue;
    }
    const secretName = value.slice("secret:".length);
    if (!secretNames.has(secretName)) {
      errors.push(
        `profile "${profileName}": hostexec.rules[${ruleIndex}].env.${key} references unknown secret "${secretName}"`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// HostExec overlapping rules warning
// ---------------------------------------------------------------------------

function warnOverlappingHostExecRules(
  profileName: string,
  rules: HostExecRule[],
): void {
  const byArgv0 = new Map<string, HostExecRule[]>();
  for (const rule of rules) {
    const key = rule.match.argv0;
    const group = byArgv0.get(key);
    if (group) {
      group.push(rule);
    } else {
      byArgv0.set(key, [rule]);
    }
  }

  for (const [argv0, group] of byArgv0) {
    if (group.length < 2) continue;

    const seen = new Map<string, HostExecRule>();
    for (const rule of group) {
      const regexKey = rule.match.argRegex ?? "";
      const prev = seen.get(regexKey);
      if (prev) {
        logWarn(
          `[warn] profile "${profileName}": hostexec rules "${prev.id}" and "${rule.id}" ` +
            `have identical match (argv0="${argv0}"${
              rule.match.argRegex ? `, arg-regex="${rule.match.argRegex}"` : ""
            }); only the first rule will ever match`,
        );
      } else {
        seen.set(regexKey, rule);
      }
    }

    const catchAll = group.find((r) => r.match.argRegex === undefined);
    if (catchAll) {
      for (const rule of group) {
        if (rule === catchAll) continue;
        if (rule.match.argRegex !== undefined) {
          if (group.indexOf(catchAll) < group.indexOf(rule)) {
            logWarn(
              `[warn] profile "${profileName}": hostexec rule "${catchAll.id}" (argv0="${argv0}", no arg-regex) ` +
                `shadows rule "${rule.id}" (arg-regex="${rule.match.argRegex}"); ` +
                `consider reordering so the more specific rule comes first`,
            );
          }
        }
      }
    }
  }
}
