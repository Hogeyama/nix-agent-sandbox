/**
 * nas config init — generate configuration files for a project.
 *
 * Creates files in two locations:
 * 1. Global config dir ($XDG_CONFIG_HOME/nas/):
 *    - Schema.pkl  (overwritten only when bundled version is newer)
 *    - global.pkl  (created only if missing)
 * 2. Project dir (.nas/):
 *    - Schema.pkl  (always overwritten — ADR policy)
 *    - config.pkl  (created only if missing)
 *    - PklProject  (created only if missing)
 *    - eval.pkl    (always overwritten — CLI-managed)
 *    - .gitignore  (created only if missing)
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import { getGlobalConfigDir, NAS_GITIGNORE_CONTENT } from "./paths.ts";

/** Parse a `/// @version X.Y.Z` line from the first 5 lines of a pkl file. */
export function parseVersionFromPkl(text: string): string | null {
  const lines = text.split("\n").slice(0, 5);
  for (const line of lines) {
    const m = line.match(/^\/\/\/\s*@version\s+(\S+)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Compare two semver strings. Returns:
 *   positive if a > b, negative if a < b, 0 if equal.
 * Non-semver strings are treated as "0.0.0".
 */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string): [number, number, number] => {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return [0, 0, 0];
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

/** Read a file's text content, returning null on ENOENT. */
export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Check whether a path exists (file or directory). */
async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Resolve a template asset file path. */
export function resolveTemplate(name: string): string {
  return resolveAsset(
    `config/templates/${name}`,
    import.meta.url,
    `./templates/${name}`,
  );
}

/** Resolve the bundled Schema.pkl asset path. */
export function resolveSchemaAsset(): string {
  return resolveAsset("config/Schema.pkl", import.meta.url, "./Schema.pkl");
}

export interface EnsureGlobalSchemaResult {
  /** "written" if created or overwritten, "skipped" if left unchanged. */
  action: "written" | "skipped";
  path: string;
}

/**
 * Ensure the global Schema.pkl is present and up-to-date (version-aware upsert).
 *
 * - If the file does not exist, it is created from the bundled asset.
 * - If it exists but its `@version` is older than the bundled one, it is overwritten.
 * - Otherwise it is left unchanged.
 */
export async function ensureGlobalSchema(
  globalDir: string,
): Promise<EnsureGlobalSchemaResult> {
  const schemaPklSrc = resolveSchemaAsset();
  const schemaPklText = await readFile(schemaPklSrc, "utf8");
  const bundledVersion = parseVersionFromPkl(schemaPklText);

  const globalSchemaPath = path.join(globalDir, "Schema.pkl");
  const existingGlobalSchema = await readFileOrNull(globalSchemaPath);

  if (existingGlobalSchema === null) {
    await writeFile(globalSchemaPath, schemaPklText);
    return { action: "written", path: globalSchemaPath };
  }

  const existingVersion = parseVersionFromPkl(existingGlobalSchema);
  if (
    bundledVersion &&
    existingVersion &&
    compareSemver(bundledVersion, existingVersion) > 0
  ) {
    await writeFile(globalSchemaPath, schemaPklText);
    return { action: "written", path: globalSchemaPath };
  }

  return { action: "skipped", path: globalSchemaPath };
}

export interface InitConfigOptions {
  projectDir: string;
}

export interface InitConfigResult {
  /** Files that were written (created or overwritten). */
  written: string[];
  /** Files that were skipped (already exist and not outdated). */
  skipped: string[];
}

/**
 * Initialize nas configuration files.
 *
 * Idempotent: running twice produces the same result.
 */
export async function initConfig(
  opts: InitConfigOptions,
): Promise<InitConfigResult> {
  const written: string[] = [];
  const skipped: string[] = [];

  // Read the bundled Schema.pkl once (needed for project-level copy below).
  const schemaPklSrc = resolveSchemaAsset();
  const schemaPklText = await readFile(schemaPklSrc, "utf8");

  // --- Global config dir ---
  const globalDir = getGlobalConfigDir();
  await mkdir(globalDir, { recursive: true });

  // Global Schema.pkl — version-aware upsert via shared helper.
  const globalSchemaResult = await ensureGlobalSchema(globalDir);
  if (globalSchemaResult.action === "written") {
    written.push(globalSchemaResult.path);
  } else {
    skipped.push(globalSchemaResult.path);
  }

  // Global global.pkl — create only if missing.
  const globalPklPath = path.join(globalDir, "global.pkl");
  if (await exists(globalPklPath)) {
    skipped.push(globalPklPath);
  } else {
    const templateText = await readFile(resolveTemplate("global.pkl"), "utf8");
    await writeFile(globalPklPath, templateText);
    written.push(globalPklPath);
  }

  // --- Project dir (.nas/) ---
  const nasDir = path.join(opts.projectDir, ".nas");
  await mkdir(nasDir, { recursive: true });

  // .nas/Schema.pkl — always overwrite (ADR policy).
  const projectSchemaPath = path.join(nasDir, "Schema.pkl");
  await writeFile(projectSchemaPath, schemaPklText);
  written.push(projectSchemaPath);

  // .nas/config.pkl — create only if missing.
  const configPklPath = path.join(nasDir, "config.pkl");
  if (await exists(configPklPath)) {
    skipped.push(configPklPath);
  } else {
    const templateText = await readFile(resolveTemplate("config.pkl"), "utf8");
    await writeFile(configPklPath, templateText);
    written.push(configPklPath);
  }

  // .nas/PklProject — create only if missing.
  const pklProjectPath = path.join(nasDir, "PklProject");
  if (await exists(pklProjectPath)) {
    skipped.push(pklProjectPath);
  } else {
    const templateText = await readFile(resolveTemplate("PklProject"), "utf8");
    await writeFile(pklProjectPath, templateText);
    written.push(pklProjectPath);
  }

  // .nas/eval.pkl — always overwrite (CLI-managed file).
  const evalPklPath = path.join(nasDir, "eval.pkl");
  const evalPklText = await readFile(resolveTemplate("eval.pkl"), "utf8");
  await writeFile(evalPklPath, evalPklText);
  written.push(evalPklPath);

  // .nas/.gitignore — create only if missing.
  // Content kept in sync with ensureNasGitignore() via shared NAS_GITIGNORE_CONTENT.
  const gitignorePath = path.join(nasDir, ".gitignore");
  if (await exists(gitignorePath)) {
    skipped.push(gitignorePath);
  } else {
    await writeFile(gitignorePath, NAS_GITIGNORE_CONTENT);
    written.push(gitignorePath);
  }

  return { written, skipped };
}
