/**
 * Config migration utilities.
 *
 * Provides conversion from a JS object (Record<string, unknown>) to a Pkl
 * source string that `amends "Schema.pkl"`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** YAML/JSON kebab-case keys that map to camelCase in Pkl. */
const KEBAB_KEYS = new Set([
  "agent-args",
  "arg-regex",
  "default-scope",
  "detach-key",
  "extra-mounts",
  "extra-packages",
  "forward-agent",
  "forward-ports",
  "idle-timeout",
  "inherit-env",
  "mount-config",
  "mount-socket",
  "on-create",
  "source-address",
  "timeout-seconds",
]);

/** Dot-separated path patterns where the object is a Pkl Mapping (not a class). */
const MAPPING_PARENT_PATHS: ReadonlySet<string> = new Set([
  "profiles",
  "profiles.*.hostexec.secrets",
  "profiles.*.hostexec.rules.*.env",
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function valueToPkl(val: unknown, _indent: number): string {
  if (typeof val === "string") {
    return `"${escapeString(val)}"`;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return String(val);
}

function matchPath(pattern: string, candidate: string): boolean {
  const ps = pattern.split(".");
  const cs = candidate.split(".");
  if (ps.length !== cs.length) return false;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] !== "*" && ps[i] !== cs[i]) return false;
  }
  return true;
}

function pathIsMappingParent(path: string): boolean {
  for (const pattern of MAPPING_PARENT_PATHS) {
    if (matchPath(pattern, path)) return true;
  }
  return false;
}

function bracketKey(key: string): string {
  return `["${escapeString(key)}"]`;
}

function needsBracketKey(key: string): boolean {
  return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

function formatKey(key: string): string {
  if (KEBAB_KEYS.has(key)) {
    return kebabToCamel(key);
  }
  return needsBracketKey(key) ? bracketKey(key) : key;
}

function arrayToPkl(arr: unknown[], indent: number, path: string): string {
  if (arr.length === 0) {
    return "new Listing {}";
  }
  const prefix = "  ".repeat(indent + 1);
  const closing = "  ".repeat(indent);
  const itemPath = path === "" ? "*" : `${path}.*`;
  const items = arr
    .filter((item) => item !== null && item !== undefined)
    .map((item) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const innerLines = objectToLines(
          item as Record<string, unknown>,
          indent + 2,
          itemPath,
        );
        if (innerLines.length === 0) {
          return `${prefix}new {}`;
        }
        return `${prefix}new {\n${innerLines.join("\n")}\n${prefix}}`;
      }
      return `${prefix}${valueToPkl(item, indent + 1)}`;
    });
  return `new Listing {\n${items.join("\n")}\n${closing}}`;
}

function objectToLines(
  obj: Record<string, unknown>,
  indent: number,
  path: string,
): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  const parentIsMapping = pathIsMappingParent(path);

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      continue;
    }

    const fkey = parentIsMapping ? bracketKey(key) : formatKey(key);
    const childPath = path === "" ? key : `${path}.${key}`;

    if (Array.isArray(val)) {
      lines.push(`${prefix}${fkey} = ${arrayToPkl(val, indent, childPath)}`);
    } else if (typeof val === "object") {
      const innerLines = objectToLines(
        val as Record<string, unknown>,
        indent + 1,
        childPath,
      );
      if (innerLines.length === 0) {
        lines.push(`${prefix}${fkey} {}`);
      } else {
        lines.push(`${prefix}${fkey} {`);
        lines.push(...innerLines);
        lines.push(`${prefix}}`);
      }
    } else {
      lines.push(`${prefix}${fkey} = ${valueToPkl(val, indent)}`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a plain JS object to a Pkl source string that amends Schema.pkl.
 *
 * The returned string is a complete `.pkl` file with the header
 * `amends "Schema.pkl"` followed by the object fields in Pkl syntax.
 */
export function objectToPklSource(obj: Record<string, unknown>): string {
  const header = 'amends "Schema.pkl"\n';
  const lines = objectToLines(obj, 0, "");
  if (lines.length === 0) {
    return header;
  }
  return `${header}\n${lines.join("\n")}\n`;
}

/**
 * Normalize snake_case keys in env entries to camelCase.
 *
 * YAML configs historically used `key_cmd` and `val_cmd` inside
 * `profiles.*.env[]` entries.  Pkl uses `keyCmd` / `valCmd`.
 * This function walks the raw object and rewrites those keys in-place.
 */
export function normalizeEnvSnakeCaseKeys(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (!raw.profiles) return raw;
  const profiles: Record<string, Record<string, unknown>> = {};
  for (const [profileName, profile] of Object.entries(
    raw.profiles as Record<string, Record<string, unknown>>,
  )) {
    if (!profile.env || !Array.isArray(profile.env)) {
      profiles[profileName] = profile;
      continue;
    }
    const normalizedEnv = (profile.env as Record<string, unknown>[]).map(
      (entry) => {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(entry)) {
          if (key === "key_cmd") {
            result.keyCmd = val;
          } else if (key === "val_cmd") {
            result.valCmd = val;
          } else {
            result[key] = val;
          }
        }
        return result;
      },
    );
    profiles[profileName] = {
      ...profile,
      env: normalizedEnv,
    };
  }
  return { ...raw, profiles };
}
