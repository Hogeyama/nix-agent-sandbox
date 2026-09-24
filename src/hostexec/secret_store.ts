import { readFile, realpath, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SecretConfig } from "../config/types.ts";
import { expandTilde } from "../lib/fs_utils.ts";

export interface SecretStoreOptions {
  env?: Record<string, string | undefined>;
  keyringResolver?: (
    service: string,
    account: string,
  ) => Promise<string | null>;
}

export class SecretStore {
  private readonly secrets: Record<string, SecretConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly keyringResolver: (
    service: string,
    account: string,
  ) => Promise<string | null>;
  private readonly cache = new Map<string, string | null>();

  constructor(
    secrets: Record<string, SecretConfig>,
    options: SecretStoreOptions = {},
  ) {
    this.secrets = secrets;
    this.env =
      options.env ?? ({ ...process.env } as Record<string, string | undefined>);
    this.keyringResolver = options.keyringResolver ?? defaultKeyringResolver;
  }

  async get(name: string): Promise<string | null> {
    if (this.cache.has(name)) {
      return this.cache.get(name) ?? null;
    }
    const config = this.secrets[name];
    if (!config) {
      throw new Error(`Unknown secret: ${name}`);
    }
    const value = await resolveSecret(
      config.from,
      this.env,
      this.keyringResolver,
    );
    if (Array.isArray(value)) {
      throw new Error(
        `Secret "${name}" resolved to multiple values (lines: source is not supported here)`,
      );
    }
    if ((value === null || value === "") && config.required) {
      throw new Error(`Required secret is unavailable: ${name}`);
    }
    const normalized = value === "" ? null : value;
    this.cache.set(name, normalized);
    return normalized;
  }

  async require(name: string): Promise<string> {
    const value = await this.get(name);
    if (value === null) {
      throw new Error(`Required secret is unavailable: ${name}`);
    }
    return value;
  }
}

/** Recognised source-type prefixes for secret resolution. */
export const SECRET_SOURCE_PREFIXES = [
  "env:",
  "file:",
  "dotenv:",
  "keyring:",
  "lines:",
  "cmd:",
] as const;

export async function resolveSecret(
  source: string,
  env: Record<string, string | undefined>,
  keyringResolver: (
    service: string,
    account: string,
  ) => Promise<string | null> = defaultKeyringResolver,
): Promise<string | string[] | null> {
  if (source.startsWith("env:")) {
    return env[source.slice(4)] ?? null;
  }
  if (source.startsWith("file:")) {
    const filePath = await resolveSafeSecretPath(
      expandSecretPath(source.slice(5), env),
      env,
    );
    return (await readFile(filePath, "utf8")).trimEnd();
  }
  if (source.startsWith("lines:")) {
    const filePath = await resolveSafeSecretPath(
      expandSecretPath(source.slice(6), env),
      env,
    );
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter((line) => line !== "");
  }
  if (source.startsWith("dotenv:")) {
    const target = source.slice(7);
    const hashIndex = target.lastIndexOf("#");
    if (hashIndex <= 0 || hashIndex === target.length - 1) {
      throw new Error(`Invalid dotenv secret source: ${source}`);
    }
    const key = target.slice(hashIndex + 1);
    const filePath = await resolveSafeSecretPath(
      expandSecretPath(target.slice(0, hashIndex), env),
      env,
    );
    const parsed = parseDotEnv(await readFile(filePath, "utf8"));
    return parsed[key] ?? null;
  }
  if (source.startsWith("keyring:")) {
    const target = source.slice(8);
    const slashIndex = target.indexOf("/");
    if (slashIndex <= 0 || slashIndex === target.length - 1) {
      throw new Error(`Invalid keyring secret source: ${source}`);
    }
    const service = target.slice(0, slashIndex);
    const account = target.slice(slashIndex + 1);
    return await keyringResolver(service, account);
  }
  if (source.startsWith("cmd:")) {
    return await runSecretCommand(source.slice(4));
  }
  throw new Error(`Unsupported secret source: ${source}`);
}

/**
 * Run a command and take its first output line as the secret.
 *
 * A credential that only exists behind a helper (`gh auth token`, `aws ecr
 * get-login-password`) has to be able to enter the registry, otherwise it
 * cannot be given a name — and a value with no name is a value that masking
 * and `forbid` cannot see.
 *
 * Only the first line is taken, so a helper that appends a warning or a
 * trailing newline still yields the credential rather than the credential
 * plus noise. Neither the command nor its output appears in the error: the
 * command line is written by the config author and the output is the secret.
 */
async function runSecretCommand(command: string): Promise<string | null> {
  if (command.trim() === "") {
    throw new Error("cmd: secret source must name a command");
  }
  const child = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  await new Response(child.stderr).text();
  const status = await child.exited;
  if (status !== 0) {
    throw new Error(`cmd: secret source exited with status ${status}`);
  }
  const first = stdout.trim().split(/\r?\n/)[0];
  return first === undefined || first === "" ? null : first;
}

const SENSITIVE_PREFIXES = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/var/log",
  // macOS: /etc and /var are symlinks into /private, so a realpath lands here.
  "/private/etc",
  "/private/var/log",
];

/**
 * Well-known credential stores, relative to HOME.
 *
 * HOME is where users keep the files they register as secrets, so it stays
 * allowed. These are the exceptions: files whose whole content is a key or a
 * login for some other system. Reading one as a "secret" hands it to a header
 * injection or a host command's env, which is a way to send the SSH key or
 * the cloud login wherever the config says. A value that genuinely lives in
 * one of them can still be registered with `cmd:` (for example
 * `cmd:aws configure get aws_secret_access_key`), which names the one value
 * being extracted instead of the whole store.
 */
const CREDENTIAL_HOME_ENTRIES = [
  ".ssh",
  ".gnupg",
  ".password-store",
  ".aws",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".local/share/keyrings",
  ".claude/.credentials.json",
  ".codex/auth.json",
  // nas state: audit logs, history, session and UI state.
  ".local/share/nas",
  ".local/state/nas",
];

/** Credential stores relative to the XDG config directory. */
const CREDENTIAL_CONFIG_ENTRIES = [
  "gcloud",
  "gh",
  "git/credentials",
  // nas's own trust decisions.
  "nas/trusted.json",
];

interface SecretPathPolicy {
  /** HOME and XDG_CONFIG_HOME: paths beneath them skip the system denylist. */
  readonly allowedRoots: readonly string[];
  /** HOME candidates, to decide whether /root is the user's own. */
  readonly homes: readonly string[];
  /** Credential stores and nas state, rejected even beneath HOME. */
  readonly deniedEntries: readonly string[];
}

function buildSecretPathPolicy(
  env: Record<string, string | undefined>,
): SecretPathPolicy {
  const home = env.HOME ?? os.homedir();
  const homes = home ? [path.resolve(home)] : [];
  const xdgConfig = absoluteEnv(env.XDG_CONFIG_HOME);
  const configDirs = [
    ...homes.map((h) => path.join(h, ".config")),
    ...xdgConfig,
  ];
  const denied: string[] = [];
  for (const h of homes) {
    for (const entry of CREDENTIAL_HOME_ENTRIES) {
      denied.push(path.join(h, entry));
    }
  }
  for (const dir of configDirs) {
    for (const entry of CREDENTIAL_CONFIG_ENTRIES) {
      denied.push(path.join(dir, entry));
    }
  }
  // nas state and runtime (broker dirs, secret frames, network tokens).
  for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
    for (const dir of absoluteEnv(env[name])) {
      denied.push(path.join(dir, "nas"));
    }
  }
  denied.push(path.join("/tmp", `nas-${currentUid()}`));
  for (const dir of absoluteEnv(env.CODEX_HOME)) {
    denied.push(path.join(dir, "auth.json"));
  }
  for (const dir of absoluteEnv(env.CLAUDE_CONFIG_DIR)) {
    denied.push(path.join(dir, ".credentials.json"));
  }
  return {
    allowedRoots: [...homes, ...xdgConfig],
    homes,
    deniedEntries: denied,
  };
}

function absoluteEnv(value: string | undefined): string[] {
  return value && path.isAbsolute(value) ? [path.resolve(value)] : [];
}

function currentUid(): string {
  try {
    return String(os.userInfo().uid);
  } catch {
    return "unknown";
  }
}

/**
 * The same policy with every root also given as its realpath, so a symlinked
 * HOME (`/home` -> `/var/home`) or a symlinked `~/.ssh` (-> `~/dotfiles/ssh`)
 * still matches a realpath'd target.
 */
async function withRealRoots(
  policy: SecretPathPolicy,
): Promise<SecretPathPolicy> {
  const expand = async (roots: readonly string[]) => {
    const reals = await Promise.all(
      roots.map((root) => realpath(root).catch(() => root)),
    );
    return [...new Set([...roots, ...reals])];
  };
  const [allowedRoots, homes, deniedEntries] = await Promise.all([
    expand(policy.allowedRoots),
    expand(policy.homes),
    expand(policy.deniedEntries),
  ]);
  return { allowedRoots, homes, deniedEntries };
}

/**
 * Lexical check of a secret file path: rejects `..`, well-known credential
 * stores and nas's own state (even beneath HOME), and system paths outside
 * HOME / XDG_CONFIG_HOME.
 *
 * Symlinks are not followed here; `resolveSafeSecretPath` follows them and is
 * what the resolver calls before reading.
 */
export function assertSafeSecretPath(
  rawPath: string,
  env: Record<string, string | undefined>,
): void {
  checkSecretPath(
    rawPath,
    normalizeSecretPath(rawPath),
    buildSecretPathPolicy(env),
  );
}

/**
 * Check a secret file path, follow it to its real location, check that too,
 * and return the real path. The caller reads the returned path: checking one
 * name and opening another would let a symlink aim the read anywhere.
 */
export async function resolveSafeSecretPath(
  rawPath: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const normalized = normalizeSecretPath(rawPath);
  const policy = buildSecretPathPolicy(env);
  checkSecretPath(rawPath, normalized, policy);
  const real = await realpath(normalized);
  checkSecretPath(rawPath, real, await withRealRoots(policy));
  return real;
}

function normalizeSecretPath(rawPath: string): string {
  if (rawPath === "") {
    throw new Error("secret path must not be empty");
  }
  if (rawPath.split("/").some((segment) => segment === "..")) {
    throw new Error(`secret path "${rawPath}" must not contain ".." segments`);
  }
  const normalized = path.resolve(rawPath);
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`secret path "${rawPath}" must not contain ".." segments`);
  }
  return normalized;
}

function checkSecretPath(
  rawPath: string,
  normalized: string,
  policy: SecretPathPolicy,
): void {
  // macOS volumes are case-insensitive by default, so ~/.SSH is ~/.ssh.
  const foldCase = process.platform === "darwin";
  for (const entry of policy.deniedEntries) {
    if (isWithin(normalized, entry, foldCase)) {
      throw new Error(
        `secret path "${rawPath}" is inside sensitive credential location ${entry}`,
      );
    }
  }
  if (policy.allowedRoots.some((root) => isWithin(normalized, root))) return;

  for (const prefix of SENSITIVE_PREFIXES) {
    if (isWithin(normalized, prefix)) {
      throw new Error(
        `secret path "${rawPath}" is inside sensitive prefix ${prefix}`,
      );
    }
  }
  // /root is only rejected when it isn't the user's HOME.
  if (isWithin(normalized, "/root") && !policy.homes.includes("/root")) {
    throw new Error(
      `secret path "${rawPath}" is inside sensitive prefix /root`,
    );
  }
  // /var/lib is sensitive, but allow /var/lib/<user>/... (i.e. require a
  // subdirectory beneath the first segment so bare files like
  // /var/lib/secret are rejected).
  if (isWithin(normalized, "/var/lib")) {
    const rest = path.relative("/var/lib", normalized);
    const segments = rest === "" ? [] : rest.split(path.sep).filter(Boolean);
    if (segments.length < 2) {
      throw new Error(
        `secret path "${rawPath}" is inside sensitive prefix /var/lib`,
      );
    }
  }
}

function isWithin(target: string, root: string, foldCase = false): boolean {
  const relative = foldCase
    ? path.relative(root.toLowerCase(), target.toLowerCase())
    : path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ")
      ? line.slice(7).trim()
      : line;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = withoutExport.slice(0, equalsIndex).trim();
    let value = withoutExport.slice(equalsIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function defaultKeyringResolver(
  service: string,
  account: string,
): Promise<string | null> {
  if (process.platform === "linux") {
    return await readKeyringViaCommand("secret-tool", [
      "lookup",
      "service",
      service,
      "account",
      account,
    ]);
  }
  if (process.platform === "darwin") {
    return await readKeyringViaCommand("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
  }
  throw new Error(`keyring secrets are not supported on ${process.platform}`);
}

async function readKeyringViaCommand(
  command: string,
  args: string[],
): Promise<string | null> {
  const resolved = await resolveCommand(command);
  if (!resolved) {
    throw new Error(`keyring helper not found: ${command}`);
  }
  const proc = Bun.spawn([resolved, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    return null;
  }
  return stdout.trimEnd() || null;
}

function expandSecretPath(
  rawPath: string,
  env: Record<string, string | undefined>,
): string {
  if (rawPath.split("/").some((s) => s === "..")) {
    return rawPath;
  }
  const home = env.HOME || os.homedir();
  return expandTilde(rawPath, home);
}

async function resolveCommand(name: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}
