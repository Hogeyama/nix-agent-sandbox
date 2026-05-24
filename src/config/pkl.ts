import type { RawConfig } from "./types.ts";

/**
 * Known kebab-case property names from the RawConfig/RawProfile schema.
 * Only these keys are converted between kebab-case and camelCase.
 * User-defined names (profile names, secret names, env var names) are left as-is.
 */
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

/** Convert a kebab-case string to camelCase: "mount-socket" → "mountSocket" */
function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Convert a camelCase string to kebab-case: "mountSocket" → "mount-socket" */
function camelToKebab(key: string): string {
  return key.replace(
    /([a-z0-9])([A-Z])/g,
    (_, a: string, b: string) => `${a}-${b.toLowerCase()}`,
  );
}

/**
 * Recursively normalize JSON keys from pkl eval output.
 * Converts camelCase keys back to kebab-case if they match a known config key.
 * Keys already in kebab-case or not in the whitelist are left as-is.
 *
 * If the same logical key appears in both forms (e.g. "mountSocket" and
 * "mount-socket"), the kebab-case canonical form wins — the camelCase
 * duplicate is silently dropped.  Pkl itself forbids duplicate property
 * names, so this guard only fires on hand-crafted JSON input.
 */
export function normalizePklKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(normalizePklKeys);
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const kebab = camelToKebab(key);
      const normalizedKey = KEBAB_KEYS.has(kebab) ? kebab : key;
      // If the canonical kebab key already exists (written by a prior
      // iteration over the kebab-case form), skip the camelCase duplicate.
      if (normalizedKey !== key && normalizedKey in result) {
        continue;
      }
      result[normalizedKey] = normalizePklKeys(val);
    }
    return result;
  }
  return obj;
}

/**
 * Convert a RawConfig object into a Pkl source string.
 *
 * The output is intended to be written as `agent-sandbox.global.pkl`
 * so that user `.pkl` files can amend it.  The emitted source always
 * begins with `amends "modulepath:/Config.pkl"` so that the typed
 * schema (with structural defaults) is in scope regardless of whether
 * the user provided any global overrides.
 *
 * Known kebab-case config keys are emitted as camelCase identifiers
 * so that Pkl users can write `mountSocket = true` instead of
 * `["mount-socket"] = true`.
 */
export function rawConfigToPklSource(raw: RawConfig): string {
  const header = 'amends "modulepath:/Config.pkl"\n';
  const lines = objectToLines(raw as Record<string, unknown>, 0, "");
  if (lines.length === 0) {
    return header;
  }
  return `${header}\n${lines.join("\n")}\n`;
}

/**
 * Pkl paths whose entries are typed as `Mapping<K, V>` in `Config.pkl`.
 *
 * Pkl 0.31 rejects bare-identifier entries inside a typed `Mapping`, so any
 * object whose path matches one of these patterns must emit its keys via
 * bracket syntax (`["key"] = ...`).  The `*` segment is a wildcard matching
 * exactly one path segment.
 *
 * Path-threading convention used by `objectToLines` / `arrayToPkl`:
 *   - the top-level call starts with path `""`
 *   - recursing into an object child at key `k` yields `path === "" ? k : path + "." + k`
 *   - recursing into a Listing item (object) appends `.*`
 *
 * So e.g. an entry inside `profiles.dev.hostexec.rules[0].env` is reached at
 * path `profiles.*.hostexec.rules.*.env`, which matches the pattern below.
 */
const MAPPING_PARENT_PATHS: ReadonlySet<string> = new Set([
  "profiles",
  "profiles.*.hostexec.secrets",
  "profiles.*.hostexec.rules.*.env",
]);

function matchPath(pattern: string, candidate: string): boolean {
  // Segment-wise comparison.  Splitting on "." (and comparing segments
  // literally) avoids treating "." as a regex metacharacter, which would
  // happen if we joined the path and matched with a regex.
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

/** Determine whether a key needs bracket quoting in Pkl. */
function needsBracketKey(key: string): boolean {
  return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/** Format a key for Pkl output, converting whitelisted kebab keys to camelCase. */
function formatKey(key: string): string {
  if (KEBAB_KEYS.has(key)) {
    return kebabToCamel(key);
  }
  return needsBracketKey(key) ? `["${escapeString(key)}"]` : key;
}

/** Escape a string value for Pkl string literals. */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Convert a primitive or composite value to a Pkl expression string. */
function valueToPkl(val: unknown, _indent: number): string {
  if (typeof val === "string") {
    return `"${escapeString(val)}"`;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return String(val);
}

/** Convert an array to a `new Listing { ... }` expression. */
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

/**
 * Convert an object's entries into Pkl property lines.
 *
 * Each returned line is already indented to `indent` level.  `path` is the
 * dotted Pkl path of `obj` itself (the parent of the entries being emitted);
 * see the comment on `MAPPING_PARENT_PATHS` for the threading convention.
 */
function objectToLines(
  obj: Record<string, unknown>,
  indent: number,
  path: string,
): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  // The parent path is shared by all entries of this object, so compute the
  // Mapping-mode decision once.  When true, keys are emitted via bracket
  // syntax with no kebab→camel rename (Mapping keys are user-defined names).
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
        // Empty object block
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
