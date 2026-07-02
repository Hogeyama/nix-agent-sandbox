/**
 * 設定ファイルのセマンティックバリデーション
 *
 * Pkl の型検査を前提とし、構造・型・enum・デフォルト値は Pkl 側で保証される。
 * ここでは Pkl では表現しにくいクロスフィールド制約や実行時セマンティクスのみ検証する。
 */

import { SECRET_SOURCE_PREFIXES } from "../hostexec/secret_store.ts";
import { logWarn } from "../log.ts";
import { parseAllowlistEntry } from "../network/protocol.ts";
import type {
  Config,
  CredentialRule,
  HostExecRule,
  MaskValueConfig,
  Profile,
  ReviewRule,
} from "./types.ts";

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

  // --- reviewRules host pattern validation ---
  for (const [i, rule] of profile.network.reviewRules.entries()) {
    if (rule.host !== undefined) {
      errors.push(
        ...validateHostList(
          `profile "${name}": network.reviewRules[${i}].host`,
          [rule.host],
        ),
      );
    }
  }

  // --- reviewRules shadowing warnings ---
  warnShadowedReviewRules(name, profile.network.reviewRules);

  // --- credentials validation ---
  errors.push(...validateCredentials(name, profile.network.credentials));

  // --- forwardPorts の予約ポート(18080)・重複検出 ---
  errors.push(
    ...validateForwardPorts(name, profile.network.proxy.forwardPorts),
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
    errors.push(...validateMaskValues(name, profile.mask.values));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Host list validation (shared by allowlist / denylist)
// ---------------------------------------------------------------------------

function validateHostList(fieldPath: string, entries: string[]): string[] {
  const errors: string[] = [];
  for (const [i, entry] of entries.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`${fieldPath}[${i}] must be a non-empty string`);
      continue;
    }
    let parsed: { host: string; port: number | null };
    try {
      parsed = parseAllowlistEntry(entry);
    } catch {
      errors.push(
        `${fieldPath}[${i}] ("${entry}") is not a valid host or host:port entry`,
      );
      continue;
    }
    const domain = parsed.host.startsWith("*.")
      ? parsed.host.slice(2)
      : parsed.host;
    if (domain.includes("*")) {
      errors.push(
        `${fieldPath}[${i}] ("${entry}") contains wildcard "*" in an invalid position; only "*.domain.com" prefix form is allowed`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// ReviewRules shadowing warning
// ---------------------------------------------------------------------------

function warnShadowedReviewRules(
  profileName: string,
  rules: ReviewRule[],
): void {
  for (let i = 0; i < rules.length; i++) {
    const earlier = rules[i];
    if (
      earlier.method === undefined &&
      earlier.host === undefined &&
      earlier.pathPrefix === undefined
    ) {
      for (let j = i + 1; j < rules.length; j++) {
        logWarn(
          `[warn] profile "${profileName}": network.reviewRules[${i}] (catch-all, action="${earlier.action}") ` +
            `shadows reviewRules[${j}]; consider reordering`,
        );
      }
      break;
    }
  }
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
// Credential validation
// ---------------------------------------------------------------------------

const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
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

function validateCredentials(
  profileName: string,
  credentials: CredentialRule[],
): string[] {
  const errors: string[] = [];
  for (const [i, cred] of credentials.entries()) {
    const prefix = `profile "${profileName}": network.credentials[${i}]`;

    const normalizedHeader = cred.header.trim();
    if (!normalizedHeader) {
      errors.push(`${prefix}.header must not be empty`);
    } else if (
      FORBIDDEN_CREDENTIAL_HEADERS.has(normalizedHeader.toLowerCase())
    ) {
      errors.push(
        `${prefix}.header "${cred.header}" is a forbidden header for credential injection`,
      );
    }

    // Use != null (covers both null and undefined) to handle Pkl's null values
    // which arrive as null at runtime despite the TypeScript type saying string.
    const hasVal = "val" in cred.value && cred.value.val != null;
    // After "valCmd" in check TypeScript narrows to { valCmd: string };
    // the != null guard catches Pkl nulls that slip through the type.
    const hasValCmd = "valCmd" in cred.value && cred.value.valCmd != null;
    if (hasVal && hasValCmd) {
      errors.push(`${prefix}.value: only one of val or valCmd may be set`);
    } else if (!hasVal && !hasValCmd) {
      errors.push(`${prefix}.value: exactly one of val or valCmd must be set`);
    }

    errors.push(...validateHostList(`${prefix}.host`, [cred.host]));
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

// ---------------------------------------------------------------------------
// Mask values validation
// ---------------------------------------------------------------------------

function validateMaskValues(
  profileName: string,
  values: MaskValueConfig[],
): string[] {
  const errors: string[] = [];
  for (const [i, value] of values.entries()) {
    const source = value.source;
    if (typeof source !== "string" || source.trim() === "") {
      errors.push(
        `profile "${profileName}": mask.values[${i}].source must be a non-empty string`,
      );
      continue;
    }
    if (!SECRET_SOURCE_PREFIXES.some((p) => source.startsWith(p))) {
      errors.push(
        `profile "${profileName}": mask.values[${i}].source ("${source}") must start with one of ${SECRET_SOURCE_PREFIXES.join(", ")} (literal values are not supported)`,
      );
    }
  }
  return errors;
}
