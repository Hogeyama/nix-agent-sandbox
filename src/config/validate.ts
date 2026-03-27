/**
 * .agent-sandbox.yml のバリデーション
 */

import { ZodError } from "zod";
import type {
  Config,
  HostExecRule,
  Profile,
  RawConfig,
  RawProfile,
} from "./types.ts";
import { formatZodError, profileSchema, uiSchema } from "./schema.ts";
import { logWarn } from "../log.ts";

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

  const errors: string[] = [];

  let ui;
  try {
    ui = uiSchema.parse(raw.ui ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      errors.push(`ui: ${formatZodError(err)}`);
    } else {
      throw err;
    }
  }

  const profiles: Record<string, Profile> = {};
  for (const [name, rawProfile] of Object.entries(raw.profiles)) {
    try {
      profiles[name] = parseProfile(name, rawProfile);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        errors.push(err.message);
      } else {
        throw err;
      }
    }
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors.join("\n"));
  }

  if (raw.default && !(raw.default in profiles)) {
    throw new ConfigValidationError(
      `default profile "${raw.default}" not found in profiles`,
    );
  }

  return {
    default: raw.default,
    ui: ui!,
    profiles,
  };
}

function parseProfile(name: string, raw: RawProfile): Profile {
  // Legacy secrets check
  if ("secrets" in raw) {
    throw new ConfigValidationError(
      `profile "${name}": secrets has moved to hostexec.secrets`,
    );
  }

  try {
    const schema = profileSchema(name);
    const parsed = schema.parse(raw);
    warnOverlappingHostExecRules(name, parsed.hostexec.rules);
    return parsed;
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new ConfigValidationError(
        `profile "${name}": ${err.message}`,
      );
    }
    if (err instanceof ZodError) {
      throw new ConfigValidationError(
        `profile "${name}": ${formatZodError(err)}`,
      );
    }
    throw err;
  }
}

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
