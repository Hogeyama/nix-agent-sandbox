/**
 * Config migration utilities.
 *
 * Provides conversion from a JS object (Record<string, unknown>) to a Pkl
 * source string that `amends "Schema.pkl"`, and migration from legacy
 * .agent-sandbox.yml to .nas/config.pkl (or global.pkl).
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  ensureGlobalSchema,
  type InitConfigResult,
  initConfig,
} from "./init.ts";
import { getGlobalConfigDir } from "./paths.ts";

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
 * Convert a plain JS object to a Pkl source string that amends a Pkl module.
 *
 * The returned string is a complete `.pkl` file with the header
 * `amends "<amendsHeader>"` followed by the object fields in Pkl syntax.
 *
 * @param obj   - The plain JS object to convert.
 * @param opts  - Optional settings.
 * @param opts.amendsHeader - The module path for the `amends` header.
 *                            Defaults to `"Schema.pkl"`.
 */
export function objectToPklSource(
  obj: Record<string, unknown>,
  opts?: { amendsHeader?: string },
): string {
  const header = `amends "${escapeString(opts?.amendsHeader ?? "Schema.pkl")}"\n`;
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

// ---------------------------------------------------------------------------
// YAML config discovery
// ---------------------------------------------------------------------------

const YAML_CONFIG_FILENAME = ".agent-sandbox.yml";

/**
 * Search for `.agent-sandbox.yml` starting from `startDir` and walking up
 * to the filesystem root.
 *
 * Returns the absolute path to the file if found, or `null`.
 */
export async function findYamlConfig(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, YAML_CONFIG_FILENAME);
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) {
      return null;
    }
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Nix config discovery
// ---------------------------------------------------------------------------

const NIX_CONFIG_FILENAME = ".agent-sandbox.nix";

/**
 * Search for `.agent-sandbox.nix` starting from `startDir` and walking up
 * to the filesystem root.
 *
 * Returns the absolute path to the file if found, or `null`.
 */
export async function findNixConfig(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, NIX_CONFIG_FILENAME);
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) {
      return null;
    }
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Nix eval helpers
// ---------------------------------------------------------------------------

/** Cached result of nixCommandExists(). */
let nixExistsCache: boolean | null = null;

/** Check whether the `nix` command is available on PATH (cached). */
async function nixCommandExists(): Promise<boolean> {
  if (nixExistsCache !== null) return nixExistsCache;
  try {
    const proc = Bun.spawn(["nix", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    nixExistsCache = code === 0;
    return nixExistsCache;
  } catch {
    nixExistsCache = false;
    return false;
  }
}

/**
 * Double-escape a string so it can be safely embedded as a Nix string literal
 * inside a `builtins.fromJSON` call.
 *
 * The outer `JSON.stringify` produces a JSON string with proper escaping,
 * and the inner `JSON.stringify` wraps it as a Nix-compatible JSON string
 * literal value. This prevents path-injection attacks.
 */
export function buildNixJsonStringLiteral(value: string): string {
  return JSON.stringify(JSON.stringify(value));
}

export interface EvalNixFileResult {
  /** The evaluated Nix value (always a plain object). */
  value: Record<string, unknown>;
  /** Whether the Nix file exported a function (called with `{}`). */
  isFunction: boolean;
}

/**
 * Evaluate a `.agent-sandbox.nix` file and return the result as a JS object.
 *
 * If the Nix expression is a function, it is called with `{}` (empty attrset).
 * The return value includes an `isFunction` flag so callers can distinguish
 * between the two cases.
 *
 * Requires the `nix` CLI to be on PATH. Throws with a clear message if it is
 * missing, if evaluation fails, or if the result is not a plain object.
 *
 * **Security**: Uses `--impure` so the Nix expression can access the local
 * filesystem.  The user must trust the `.agent-sandbox.nix` file being evaluated.
 */
export async function evalNixFile(nixPath: string): Promise<EvalNixFileResult> {
  if (!(await nixCommandExists())) {
    throw new Error(
      `Found ${nixPath}, but 'nix' command is not available on PATH. ` +
        "Install Nix (https://nixos.org/download.html) to use .nix config files.",
    );
  }

  const nixPathArg = buildNixJsonStringLiteral(nixPath);

  const nixExpr = `
    let
      local = import (builtins.fromJSON ${nixPathArg});
    in
      if builtins.isFunction local then
        { value = local {}; isFunction = true; }
      else
        { value = local; isFunction = false; }
  `;

  const proc = Bun.spawn(
    ["nix", "eval", "--impure", "--json", "--expr", nixExpr],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  if (code !== 0) {
    const lines = stderrText.trim().split("\n");
    const errMsg =
      lines.length > 50 ? lines.slice(-50).join("\n") : lines.join("\n");
    throw new Error(
      `Failed to evaluate ${nixPath}: nix eval exited with code ${code}\n${errMsg}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutText);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to parse nix eval output for ${nixPath}: ${message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Expected an object from nix eval of ${nixPath}, ` +
        `but got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    );
  }

  const result = parsed as Record<string, unknown>;

  const value = result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Expected the Nix expression in ${nixPath} to evaluate to an attribute set, ` +
        `but got ${Array.isArray(value) ? "an array" : typeof value}.`,
    );
  }

  return {
    value: value as Record<string, unknown>,
    isFunction: result.isFunction as boolean,
  };
}

// ---------------------------------------------------------------------------
// YAML -> Pkl migration
// ---------------------------------------------------------------------------

export interface MigrateYml2PklOptions {
  /** When true, migrate the global config instead of the local project config. */
  global?: boolean;
  /** Override the input YAML file path. */
  inputPath?: string;
  /** When true, overwrite existing output files. */
  force?: boolean;
}

export interface MigrateYml2PklResult {
  /** Path of the YAML file that was read. */
  inputPath: string;
  /** Path of the Pkl file that was written. */
  outputPath: string;
  /** Scaffold result from initConfig (local mode only). */
  scaffoldResult?: InitConfigResult;
}

/**
 * Migrate a legacy `.agent-sandbox.yml` to a Pkl config file.
 *
 * - **Local mode** (default): Finds `.agent-sandbox.yml` from cwd upward,
 *   runs `initConfig()` to scaffold `.nas/`, then writes the converted
 *   config to `.nas/config.pkl`.
 * - **Global mode** (`global: true`): Reads
 *   `$XDG_CONFIG_HOME/nas/agent-sandbox.yml` and writes to
 *   `$XDG_CONFIG_HOME/nas/global.pkl`. Creates Schema.pkl if missing.
 *
 * The `inputPath` option overrides only the input file location; the output
 * path is always determined by the mode.
 */
export async function migrateYml2Pkl(
  opts: MigrateYml2PklOptions = {},
): Promise<MigrateYml2PklResult> {
  if (opts.global) {
    return migrateGlobal(opts);
  }
  return migrateLocal(opts);
}

async function migrateLocal(
  opts: MigrateYml2PklOptions,
): Promise<MigrateYml2PklResult> {
  const cwd = process.cwd();

  // Resolve input YAML
  const inputPath = opts.inputPath ?? (await findYamlConfig(cwd));
  if (!inputPath) {
    throw new Error(
      `No ${YAML_CONFIG_FILENAME} found from ${cwd} upward. ` +
        "Use --input to specify the YAML file path.",
    );
  }

  // Output is always relative to cwd
  const outputPath = path.join(cwd, ".nas", "config.pkl");

  // Check for existing output unless --force
  if (!opts.force) {
    await assertNotExists(outputPath);
  }

  // Scaffold .nas/ directory via initConfig
  const scaffoldResult = await initConfig({ projectDir: cwd });

  // Read and convert
  const pklSource = await yamlFileToPklSource(inputPath);

  // Write output (initConfig may have created config.pkl, overwrite it)
  await writeFile(outputPath, pklSource);

  return { inputPath, outputPath, scaffoldResult };
}

async function migrateGlobal(
  opts: MigrateYml2PklOptions,
): Promise<MigrateYml2PklResult> {
  const globalDir = getGlobalConfigDir();

  // Resolve input YAML
  const inputPath =
    opts.inputPath ?? path.join(globalDir, YAML_CONFIG_FILENAME);

  // Output is always global.pkl
  const outputPath = path.join(globalDir, "global.pkl");

  // Check for existing output unless --force
  if (!opts.force) {
    await assertNotExists(outputPath);
  }

  // Ensure global dir exists
  await mkdir(globalDir, { recursive: true });

  // Ensure Schema.pkl is up-to-date in global dir (version-aware upsert).
  await ensureGlobalSchema(globalDir);

  // Read and convert
  const pklSource = await yamlFileToPklSource(inputPath);

  // Write output
  await writeFile(outputPath, pklSource);

  return { inputPath, outputPath };
}

/**
 * Assert that a file does not exist. Throws if it does.
 */
async function assertNotExists(filePath: string): Promise<void> {
  try {
    await stat(filePath);
    throw new Error(
      `Output file already exists: ${filePath}. Use --force to overwrite.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return; // Does not exist — OK
    }
    throw error;
  }
}

/**
 * Read a YAML file, parse it, normalize keys, and convert to Pkl source.
 */
async function yamlFileToPklSource(filePath: string): Promise<string> {
  let yamlText: string;
  try {
    yamlText = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`YAML config file not found: ${filePath}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML in ${filePath}: ${message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Expected an object at the top level of ${filePath}, ` +
        `but got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    );
  }

  const normalized = normalizeEnvSnakeCaseKeys(
    parsed as Record<string, unknown>,
  );
  return objectToPklSource(normalized);
}
