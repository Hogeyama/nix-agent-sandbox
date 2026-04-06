import * as path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { SecretConfig } from "../config/types.ts";

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
    this.env = options.env ??
      ({ ...process.env } as Record<string, string | undefined>);
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

export async function resolveSecret(
  source: string,
  env: Record<string, string | undefined>,
  keyringResolver: (service: string, account: string) => Promise<string | null>,
): Promise<string | null> {
  if (source.startsWith("env:")) {
    return env[source.slice(4)] ?? null;
  }
  if (source.startsWith("file:")) {
    const filePath = source.slice(5);
    return (await readFile(filePath, "utf8")).trimEnd();
  }
  if (source.startsWith("dotenv:")) {
    const target = source.slice(7);
    const hashIndex = target.lastIndexOf("#");
    if (hashIndex <= 0 || hashIndex === target.length - 1) {
      throw new Error(`Invalid dotenv secret source: ${source}`);
    }
    const filePath = target.slice(0, hashIndex);
    const key = target.slice(hashIndex + 1);
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
  throw new Error(`Unsupported secret source: ${source}`);
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

async function resolveCommand(name: string): Promise<string | null> {
  const pathValue = process.env["PATH"] ?? "";
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
