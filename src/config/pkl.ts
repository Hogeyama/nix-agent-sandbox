/**
 * Known kebab-case property names from the config schema.
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
