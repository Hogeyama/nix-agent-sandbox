/** Pin and verify the registry tarballs in Bun's source lock for Linux bundles. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface PackagePin {
  lock: string;
  key: string;
  name: string;
  version: string;
  integrity: string;
  url: string;
  archive: string;
}
export interface BunNpmPins {
  schemaVersion: 1;
  bunVersion: string;
  packages: PackagePin[];
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Bun lock object");
  return value as Record<string, unknown>;
}

const releaseCpus = ["x64", "arm64"] as const;
export type ReleaseCpu = (typeof releaseCpus)[number];

function supportsLinux(value: unknown, cpus: readonly string[]): boolean {
  const metadata = object(value);
  for (const [key, allowed] of [
    ["os", ["linux"]],
    ["cpu", cpus],
  ] as const) {
    const field = metadata[key];
    if (field === undefined) continue;
    if (typeof field === "string") {
      if (!allowed.includes(field as never)) return false;
    } else if (
      Array.isArray(field) &&
      field.every((v) => typeof v === "string")
    ) {
      if (!field.some((v) => allowed.includes(v as never))) return false;
    } else throw new Error(`unsupported Bun lock ${key} metadata`);
  }
  return true;
}

export const lockPaths = [
  "bun.lock",
  "packages/bun-error/bun.lock",
  "src/node-fallbacks/bun.lock",
] as const;

/** Without `cpu`, both release architectures; with it, the archives one architecture installs. */
export function pinsFromLock(
  lockText: string,
  bunVersion: string,
  lock: string = "bun.lock",
  cpu?: string,
): BunNpmPins {
  if (!/^\d+\.\d+\.\d+/.test(bunVersion))
    throw new Error(`invalid Bun version: ${bunVersion}`);
  if (cpu !== undefined && !releaseCpus.includes(cpu as ReleaseCpu))
    throw new Error(`unsupported release CPU: ${cpu}`);
  const cpus = cpu === undefined ? releaseCpus : [cpu];
  const parsed = object(Bun.JSONC.parse(lockText));
  const packages = object(parsed.packages);
  const pins: PackagePin[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || !entry.length || typeof entry[0] !== "string")
      throw new Error(`invalid Bun lock package: ${key}`);
    if (entry[0].includes("@workspace:")) continue;
    const at = entry[0].lastIndexOf("@");
    const name = entry[0].slice(0, at);
    const version = entry[0].slice(at + 1);
    if (
      !/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) ||
      !(key === name || key.endsWith(`/${name}`)) ||
      !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)
    )
      throw new Error(`unexpected Bun package version: ${entry[0]}`);
    if (!supportsLinux(entry[2], cpus)) continue;
    const integrity = entry[3];
    if (
      typeof integrity !== "string" ||
      !integrity.startsWith("sha512-") ||
      Buffer.from(integrity.slice(7), "base64").length !== 64
    )
      throw new Error(`missing SHA-512 integrity for ${name}@${version}`);
    const shortHash = createHash("sha256")
      .update(`${name}@${version}`)
      .digest("hex")
      .slice(0, 12);
    const archive = `${name.replace(/[^A-Za-z0-9._-]/g, "-")}-${version}-${shortHash}.tgz`;
    const tarName = name.split("/").at(-1);
    pins.push({
      lock,
      key,
      name,
      version,
      integrity,
      url: `https://registry.npmjs.org/${name}/-/${tarName}-${version}.tgz`,
      archive,
    });
  }
  pins.sort((a, b) => a.key.localeCompare(b.key));
  return { schemaVersion: 1, bunVersion, packages: pins };
}

export async function pinsFromSource(
  bunSource: string,
  cpu?: string,
): Promise<BunNpmPins> {
  const manifest = object(
    JSON.parse(await readFile(join(bunSource, "package.json"), "utf8")),
  );
  if (typeof manifest.version !== "string")
    throw new Error("Bun package.json lacks version");
  const packages: PackagePin[] = [];
  for (const lock of lockPaths) {
    const pins = pinsFromLock(
      await readFile(join(bunSource, lock), "utf8"),
      manifest.version,
      lock,
      cpu,
    );
    packages.push(...pins.packages);
  }
  return { schemaVersion: 1, bunVersion: manifest.version, packages };
}

export async function verifyArchives(
  bunSource: string,
  pins: BunNpmPins,
  archiveDir: string,
  cpu?: string,
): Promise<void> {
  const expected = await pinsFromSource(bunSource, cpu);
  if (JSON.stringify(pins) !== JSON.stringify(expected))
    throw new Error("Bun npm pins differ from bun.lock");
  for (const pin of pins.packages) {
    const actual = createHash("sha512")
      .update(await readFile(join(archiveDir, pin.archive)))
      .digest("base64");
    if (`sha512-${actual}` !== pin.integrity)
      throw new Error(`Bun npm integrity mismatch: ${pin.name}@${pin.version}`);
  }
}

if (import.meta.main) {
  const [operation, ...args] = Bun.argv.slice(2);
  try {
    if (operation === "pins" && (args.length === 2 || args.length === 3)) {
      const [source, output, cpu] = args as [string, string, string?];
      await writeFile(
        output,
        `${JSON.stringify(await pinsFromSource(source, cpu), null, 2)}\n`,
      );
    } else if (
      operation === "verify" &&
      (args.length === 3 || args.length === 4)
    ) {
      const [source, pinsFile, archives, cpu] = args as [
        string,
        string,
        string,
        string?,
      ];
      const pins = JSON.parse(await readFile(pinsFile, "utf8")) as BunNpmPins;
      await verifyArchives(source, pins, archives, cpu);
    } else
      throw new Error(
        "usage: bun_npm.ts pins BUN_SOURCE OUT [CPU] | verify BUN_SOURCE PINS ARCHIVES [CPU]",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
