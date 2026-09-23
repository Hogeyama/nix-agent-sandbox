import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Component } from "./manifest.ts";
import {
  fileHashes,
  hashFile,
  readReleaseInputs,
  safeRelative,
  walkRegular,
} from "./manifest.ts";

export interface StagedInventory {
  schemaVersion: 1;
  tag: string;
  system: string;
  binaryArchive: string;
  materialsArchive: string;
  componentsArtifact: string;
  binarySha256: string;
  components: Component[];
  files: Record<string, string>;
  embeddedNotices: Record<string, string>;
  payloadElf: Record<string, { sha256: string; component: string }>;
}

async function run(command: string[], label: string) {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [status, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (status !== 0)
    throw new Error(`${label} failed (${status}): ${stderr.trim()}`);
}

async function copyTree(from: string, to: string) {
  for (const relative of await walkRegular(from)) {
    const target = path.join(to, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(from, relative), target);
  }
}

// Archive the top-level entries rather than `.`: a `./` member makes tar
// reset the target directory's mode and mtime on extraction, which fails in
// a shared directory such as /tmp.
async function rootEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function removeScratch(dir: string) {
  const root = await lstat(dir);
  if (!root.isDirectory()) {
    await rm(dir, { force: true });
    return;
  }
  async function unlockDirectories(current: string) {
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory())
        await unlockDirectories(path.join(current, entry.name));
    }
  }
  await unlockDirectories(dir);
  await rm(dir, { recursive: true, force: true });
}

async function embeddedInventory(
  extracted: string,
  origins: Record<string, string>,
) {
  const noticeDir = path.join(extracted, "share/nas/assets/licenses");
  const embeddedNotices = await fileHashes(noticeDir).catch((e) => {
    throw new Error(`embedded notice tree missing or invalid: ${e}`);
  });
  const payloadElf: StagedInventory["payloadElf"] = {};
  const seen = new Set<string>();
  async function scan(dir: string, prefix: string) {
    const fs = await import("node:fs/promises");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(relative);
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(filename, relative);
      else if (entry.isSymbolicLink()) {
        const target = await fs.realpath(filename);
        if (!target.startsWith(`${path.resolve(extracted)}${path.sep}`))
          throw new Error(`payload symlink escapes extraction: ${relative}`);
      } else if (entry.isFile()) {
        const file = Bun.file(filename);
        const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        if (
          header[0] === 0x7f &&
          header[1] === 0x45 &&
          header[2] === 0x4c &&
          header[3] === 0x46
        ) {
          const component = origins[relative];
          if (!component)
            throw new Error(`unregistered ELF payload: ${relative}`);
          seen.add(relative);
          payloadElf[relative] = {
            sha256: await hashFile(filename),
            component,
          };
        }
      } else throw new Error(`unsupported payload entry: ${relative}`);
    }
  }
  await scan(extracted, "");
  for (const relative of Object.keys(origins))
    if (!seen.has(relative))
      throw new Error(`registered ELF absent from payload: ${relative}`);
  return { embeddedNotices, payloadElf };
}

export async function prepareRelease(options: {
  inputs: string;
  binary: string;
  out: string;
  tag: string;
}): Promise<StagedInventory> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.tag))
    throw new Error(`unsafe tag: ${options.tag}`);
  const inputs = await readReleaseInputs(options.inputs);
  const binary = path.resolve(options.binary);
  const binaryStat = await stat(binary);
  if (!binaryStat.isFile() || binaryStat.size === 0)
    throw new Error("bundled binary is missing or empty");
  const binarySha256 = await hashFile(binary);
  const scratch = await mkdtemp(path.join(tmpdir(), "nas-release-"));
  try {
    const extracted = path.join(scratch, "extracted");
    await run([binary, "--extract", extracted], "bundled binary extraction");
    const { embeddedNotices, payloadElf } = await embeddedInventory(
      extracted,
      inputs.payloadOrigins ?? {},
    );
    const expectedNotices = await fileHashes(
      path.join(options.inputs, "licenses"),
    );
    if (JSON.stringify(embeddedNotices) !== JSON.stringify(expectedNotices)) {
      const missing = Object.keys(expectedNotices).filter(
        (p) => embeddedNotices[p] !== expectedNotices[p],
      );
      const extra = Object.keys(embeddedNotices).filter(
        (p) => !expectedNotices[p],
      );
      throw new Error(
        `embedded notice mismatch: changed/missing ${missing.join(", ")}; extra ${extra.join(", ")}`,
      );
    }
    const binaryDir = path.join(scratch, "binary");
    const materialsDir = path.join(scratch, "materials");
    await mkdir(binaryDir);
    await mkdir(materialsDir);
    await copyFile(binary, path.join(binaryDir, "nas"));
    await chmod(path.join(binaryDir, "nas"), 0o755);
    await copyTree(
      path.join(options.inputs, "licenses"),
      path.join(binaryDir, "licenses"),
    );
    await copyTree(options.inputs, materialsDir);
    const fileHashesForStage: Record<string, string> = {};
    for (const relative of await walkRegular(binaryDir))
      fileHashesForStage[`binary/${relative}`] = await hashFile(
        path.join(binaryDir, relative),
      );
    for (const relative of await walkRegular(materialsDir))
      fileHashesForStage[`materials/${relative}`] = await hashFile(
        path.join(materialsDir, relative),
      );
    const base = `nas-${options.tag}_${inputs.system}`;
    const inventory: StagedInventory = {
      schemaVersion: 1,
      tag: options.tag,
      system: inputs.system,
      binaryArchive: `${base}.tar.gz`,
      materialsArchive: `${base}-sources.tar.gz`,
      componentsArtifact: `${base}-components.json`,
      binarySha256,
      components: inputs.components,
      files: fileHashesForStage,
      embeddedNotices,
      payloadElf,
    };
    const json = `${JSON.stringify(inventory, null, 2)}\n`;
    await writeFile(path.join(scratch, "inventory.json"), json);
    await writeFile(path.join(scratch, inventory.componentsArtifact), json);
    await writeFile(path.join(binaryDir, "inventory.json"), json);
    await writeFile(path.join(materialsDir, "inventory.json"), json);
    await run(
      [
        "tar",
        "-czf",
        path.join(scratch, inventory.binaryArchive),
        "-C",
        binaryDir,
        ...(await rootEntries(binaryDir)),
      ],
      "binary archive",
    );
    await run(
      [
        "tar",
        "-czf",
        path.join(scratch, inventory.materialsArchive),
        "-C",
        materialsDir,
        ...(await rootEntries(materialsDir)),
      ],
      "materials archive",
    );
    await removeScratch(extracted);
    await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    try {
      await stat(options.out);
      throw new Error(`stage destination already exists: ${options.out}`);
    } catch (e) {
      if (e instanceof Error && !e.message.startsWith("ENOENT")) throw e;
    }
    try {
      await rename(scratch, options.out);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(scratch, options.out, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await removeScratch(scratch);
    }
    return inventory;
  } catch (e) {
    try {
      await removeScratch(scratch);
    } catch (cleanupError) {
      throw new AggregateError(
        [e, cleanupError],
        `release preparation failed: ${String(e)}; scratch cleanup failed`,
      );
    }
    throw e;
  }
}
