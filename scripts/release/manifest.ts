import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface Component {
  id: string;
  version: string;
  license: string;
  origin: string;
  requirements: string[];
  decision: string;
  notices: string[];
  sources: string[];
}

export interface ReleaseInputs {
  schemaVersion: 1;
  system: "x86_64-linux" | "aarch64-linux";
  components: Component[];
  payloadOrigins?: Record<string, string>;
}

const sourceRequirements = new Set([
  "DT-2",
  "JSC-2",
  "JSC-4",
  "TCC-2",
  "TCC-3",
  "MPL-1",
  "GLIBC-1",
  "GLIBC-2",
  "FUSE-1",
  "PKL-4",
]);

export function safeRelative(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error(`unsafe relative path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe relative path: ${value}`);
  }
  return value;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a nonempty string`);
  return value;
}

function strings(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${name} must be a string array`);
  }
  if (new Set(value).size !== value.length)
    throw new Error(`${name} has duplicates`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  name: string,
) {
  for (const key of required)
    if (!(key in value)) throw new Error(`${name} missing ${key}`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key))
      throw new Error(`${name} unknown field ${key}`);
  }
}

export async function requireRegular(
  root: string,
  relative: string,
  nonempty = true,
): Promise<string> {
  safeRelative(relative);
  const rootReal = await realpath(root);
  let cursor = rootReal;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor).catch(() => {
      throw new Error(`missing required file: ${relative}`);
    });
    if (stat.isSymbolicLink())
      throw new Error(`symlink is forbidden: ${relative}`);
  }
  const stat = await lstat(cursor);
  if (!stat.isFile())
    throw new Error(`required file is not regular: ${relative}`);
  if (nonempty && stat.size === 0)
    throw new Error(`required file is empty: ${relative}`);
  return cursor;
}

export async function walkRegular(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string, prefix: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(relative);
      if (entry.isSymbolicLink())
        throw new Error(`symlink is forbidden: ${relative}`);
      if (entry.isDirectory())
        await visit(path.join(dir, entry.name), relative);
      else if (entry.isFile()) result.push(relative);
      else throw new Error(`unsupported file type: ${relative}`);
    }
  }
  await visit(root, "");
  return result.sort();
}

export async function readReleaseInputs(root: string): Promise<ReleaseInputs> {
  const raw = object(
    JSON.parse(
      await readFile(await requireRegular(root, "components.json"), "utf8"),
    ),
    "components.json",
  );
  exactKeys(
    raw,
    ["schemaVersion", "system", "components"],
    ["payloadOrigins"],
    "components.json",
  );
  if (raw.schemaVersion !== 1)
    throw new Error("unsupported components schemaVersion");
  if (raw.system !== "x86_64-linux" && raw.system !== "aarch64-linux")
    throw new Error(`unsupported architecture: ${raw.system}`);
  if (!Array.isArray(raw.components) || raw.components.length === 0)
    throw new Error("components must be nonempty");
  const components = raw.components.map((entry, index) => {
    const c = object(entry, `component ${index}`);
    exactKeys(
      c,
      [
        "id",
        "version",
        "license",
        "origin",
        "requirements",
        "decision",
        "notices",
        "sources",
      ],
      [],
      `component ${index}`,
    );
    const component: Component = {
      id: string(c.id, "component id"),
      version: string(c.version, "version"),
      license: string(c.license, "license"),
      origin: string(c.origin, "origin"),
      requirements: strings(c.requirements, "requirements"),
      decision: string(c.decision, "decision"),
      notices: strings(c.notices, "notices"),
      sources: strings(c.sources, "sources"),
    };
    if (!component.notices.length)
      throw new Error(`${component.id} has no notices`);
    if (
      (component.requirements.some((r) => sourceRequirements.has(r)) ||
        /\bsource[- ](?:asset|archive|material|provision|delivery|code|required)\b|対応ソース|ソース提供/iu.test(
          component.decision,
        )) &&
      !component.sources.length
    ) {
      throw new Error(`${component.id} requires source material`);
    }
    for (const p of component.notices)
      if (!p.startsWith("licenses/"))
        throw new Error(`notice outside licenses/: ${p}`);
    for (const p of component.sources)
      if (!p.startsWith("sources/") && !p.startsWith("recipes/"))
        throw new Error(`source outside materials: ${p}`);
    return component;
  });
  const ids = components.map((c) => c.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("duplicate component id");
  const payloadOriginsRaw =
    raw.payloadOrigins === undefined
      ? {}
      : object(raw.payloadOrigins, "payloadOrigins");
  const payloadOrigins: Record<string, string> = {};
  for (const [relative, id] of Object.entries(payloadOriginsRaw)) {
    safeRelative(relative);
    if (typeof id !== "string" || !ids.includes(id))
      throw new Error(`unknown payload origin for ${relative}: ${id}`);
    payloadOrigins[relative] = id;
  }
  const all = new Set([
    "components.json",
    ...components.flatMap((c) => [...c.notices, ...c.sources]),
  ]);
  for (const relative of all) await requireRegular(root, relative);
  for (const relative of await walkRegular(root)) {
    if (
      !all.has(relative) &&
      !relative.startsWith("sources/") &&
      !relative.startsWith("recipes/") &&
      !relative.startsWith("licenses/")
    )
      throw new Error(`unregistered release input: ${relative}`);
  }
  return {
    schemaVersion: 1,
    system: raw.system,
    components,
    payloadOrigins,
  };
}

export async function fileHashes(
  root: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const relative of await walkRegular(root))
    hashes[relative] = await hashFile(path.join(root, relative));
  return hashes;
}
