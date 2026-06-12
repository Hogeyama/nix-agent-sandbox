/**
 * Repo-local config trust gate (workspace trust).
 *
 * `.nas/config.pkl` can drive host-side execution (env `valCmd`/`keyCmd`,
 * worktree `onCreate`), mounts, network allowlists and hostexec rules. A
 * cloned, attacker-controlled repo must therefore NOT be loaded just because
 * it happens to sit in the cwd. Before evaluating a repo-local config we
 * require that the exact contents have been explicitly trusted by the user,
 * in the spirit of direnv `allow` / VS Code "workspace trust".
 *
 * Trust is recorded per nas-dir keyed by a content hash, so editing the config
 * (or any sibling `.pkl` it can import) revokes trust until re-approved.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { getGlobalConfigDir } from "./paths.ts";

/**
 * Schema.pkl is regenerated from the bundled CLI asset on every load, so it is
 * excluded from the trust hash to keep trust stable across upgrades.
 */
const HASH_EXCLUDE = new Set(["Schema.pkl"]);

/** Env escape hatch: when set to "1", the trust gate is bypassed entirely. */
const TRUST_BYPASS_ENV = "NAS_CONFIG_TRUST_ALL";

interface TrustStore {
  version: 1;
  /** nasDir (absolute) -> trusted content hash */
  configs: Record<string, string>;
}

function trustStorePath(): string {
  return path.join(getGlobalConfigDir(), "trusted.json");
}

/** Whether the trust gate is disabled via env (CI / tests). */
export function isTrustBypassed(): boolean {
  return process.env[TRUST_BYPASS_ENV] === "1";
}

/**
 * Content hash covering every user-authored `.pkl` file directly under nasDir
 * (config.pkl plus any sibling modules it can import via modulepath). Schema.pkl
 * is excluded because nas rewrites it on every load.
 */
export async function computeConfigTrustHash(nasDir: string): Promise<string> {
  const entries = await readdir(nasDir, { withFileTypes: true });
  const pklFiles = entries
    .filter(
      (e) => e.isFile() && e.name.endsWith(".pkl") && !HASH_EXCLUDE.has(e.name),
    )
    .map((e) => e.name)
    .sort();

  const hash = createHash("sha256");
  for (const name of pklFiles) {
    const content = await readFile(path.join(nasDir, name));
    hash.update(name, "utf8");
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readTrustStore(): Promise<TrustStore> {
  try {
    const raw = await readFile(trustStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TrustStore>;
    if (parsed && parsed.version === 1 && typeof parsed.configs === "object") {
      return { version: 1, configs: parsed.configs ?? {} };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { version: 1, configs: {} };
}

async function writeTrustStore(store: TrustStore): Promise<void> {
  const dir = getGlobalConfigDir();
  await mkdir(dir, { recursive: true });
  const file = trustStorePath();
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // Tighten perms in case the file pre-existed with a looser mode.
  try {
    const st = await stat(file);
    if ((st.mode & 0o077) !== 0) await chmod(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** True if the current contents of nasDir are recorded as trusted. */
export async function isConfigTrusted(nasDir: string): Promise<boolean> {
  const store = await readTrustStore();
  const recorded = store.configs[path.resolve(nasDir)];
  if (!recorded) return false;
  const current = await computeConfigTrustHash(nasDir);
  return recorded === current;
}

/** Record the current contents of nasDir as trusted. */
export async function recordConfigTrust(nasDir: string): Promise<void> {
  const resolved = path.resolve(nasDir);
  const hash = await computeConfigTrustHash(resolved);
  const store = await readTrustStore();
  store.configs[resolved] = hash;
  await writeTrustStore(store);
}

/** Remove any trust recorded for nasDir. Returns true if an entry was removed. */
export async function removeConfigTrust(nasDir: string): Promise<boolean> {
  const resolved = path.resolve(nasDir);
  const store = await readTrustStore();
  if (!(resolved in store.configs)) return false;
  delete store.configs[resolved];
  await writeTrustStore(store);
  return true;
}

/** Raised when a repo-local config is loaded without prior trust. */
export class ConfigUntrustedError extends Error {
  readonly nasDir: string;
  readonly configPath: string;
  constructor(nasDir: string, configPath: string) {
    super(
      `Refusing to load untrusted config: ${configPath}\n` +
        `This config can run commands on your host (env valCmd/keyCmd, worktree onCreate),\n` +
        `mount host paths, and alter the network allowlist. Review it, then run:\n` +
        `    nas config trust\n` +
        `from within this project to approve it. (Trust is revoked automatically if the\n` +
        `config changes. Set ${TRUST_BYPASS_ENV}=1 to disable this gate.)`,
    );
    this.name = "ConfigUntrustedError";
    this.nasDir = nasDir;
    this.configPath = configPath;
  }
}

/**
 * Gate: ensure nasDir is trusted before its config is evaluated.
 *
 * - Bypassed entirely when NAS_CONFIG_TRUST_ALL=1.
 * - If already trusted, returns immediately.
 * - On an interactive TTY, prompts the user; approval records trust.
 * - Otherwise throws ConfigUntrustedError.
 */
export async function ensureConfigTrusted(
  nasDir: string,
  configPath: string,
): Promise<void> {
  if (isTrustBypassed()) return;
  if (await isConfigTrusted(nasDir)) return;

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const ok = confirm(
      `Untrusted nas config: ${configPath}\n` +
        `It can run commands on your host, mount host paths, and change the\n` +
        `network allowlist. Trust this config?`,
    );
    if (ok) {
      await recordConfigTrust(nasDir);
      return;
    }
  }
  throw new ConfigUntrustedError(nasDir, configPath);
}
