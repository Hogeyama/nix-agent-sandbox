import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fileHashes,
  hashFile,
  readReleaseInputs,
  safeRelative,
  sha256,
} from "./manifest.ts";
import type { StagedInventory } from "./prepare.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid JSON object");
  return value as Record<string, unknown>;
}

async function extractArchive(archive: string, destination: string) {
  const list = Bun.spawn(["tar", "-tvzf", archive], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, listing, stderr] = await Promise.all([
    list.exited,
    new Response(list.stdout).text(),
    new Response(list.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`archive listing failed: ${stderr}`);
  for (const line of listing.trimEnd().split("\n")) {
    if (!line || !/^[-d]/.test(line))
      throw new Error(`archive contains a link or special file: ${line}`);
  }
  const names = Bun.spawn(["tar", "-tzf", archive], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [namesStatus, nameList] = await Promise.all([
    names.exited,
    new Response(names.stdout).text(),
  ]);
  if (namesStatus !== 0) throw new Error("archive member listing failed");
  const members = nameList.trimEnd().split("\n");
  if (members.length !== listing.trimEnd().split("\n").length)
    throw new Error("archive member name contains a newline");
  for (const item of members) {
    if (item === "./") continue;
    safeRelative(
      item.startsWith("./")
        ? item.slice(2).replace(/\/$/, "")
        : item.replace(/\/$/, ""),
    );
  }
  const proc = Bun.spawn(
    ["tar", "-xzf", archive, "--no-same-owner", "-C", destination],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, error] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`archive extraction failed: ${error}`);
}

async function verifyArchive(
  stage: string,
  name: string,
  prefix: string,
  expected: Record<string, string>,
  inventoryHash: string,
): Promise<string> {
  safeRelative(name);
  const temp = await mkdtemp(path.join(tmpdir(), "nas-archive-check-"));
  try {
    await extractArchive(path.join(stage, name), temp);
    const actual = await fileHashes(temp);
    const wanted: Record<string, string> = { "inventory.json": inventoryHash };
    for (const [relative, digest] of Object.entries(expected)) {
      if (relative.startsWith(`${prefix}/`))
        wanted[relative.slice(prefix.length + 1)] = digest;
    }
    if (
      JSON.stringify(Object.entries(actual).sort()) !==
      JSON.stringify(Object.entries(wanted).sort())
    ) {
      throw new Error(`${name} contents differ from inventory`);
    }
    return temp;
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRelease(options: {
  stage: string;
  inventoryArtifact?: string;
}): Promise<void> {
  const inventoryBytes = await readFile(
    path.join(options.stage, options.inventoryArtifact ?? "inventory.json"),
  );
  const inventory = record(
    JSON.parse(inventoryBytes.toString()),
  ) as unknown as StagedInventory;
  if (inventory.schemaVersion !== 1) {
    throw new Error("invalid staged inventory");
  }
  if (
    !inventory.files ||
    !inventory.binarySha256 ||
    !inventory.componentsArtifact
  )
    throw new Error("invalid staged inventory fields");
  if (
    options.inventoryArtifact &&
    options.inventoryArtifact !== inventory.componentsArtifact
  )
    throw new Error("component artifact name differs from inventory");
  if (!options.inventoryArtifact) {
    const staged: Record<string, string> = {};
    for (const relative of Object.keys(inventory.files)) {
      safeRelative(relative);
      staged[relative] = await hashFile(path.join(options.stage, relative));
    }
    if (
      JSON.stringify(Object.entries(staged).sort()) !==
      JSON.stringify(Object.entries(inventory.files).sort())
    )
      throw new Error("staged files differ from inventory");
  }
  const inventoryHash = sha256(inventoryBytes);
  if (
    (await hashFile(path.join(options.stage, inventory.componentsArtifact))) !==
    inventoryHash
  ) {
    throw new Error("component artifact differs from inventory");
  }
  const binaryRoot = await verifyArchive(
    options.stage,
    inventory.binaryArchive,
    "binary",
    inventory.files,
    inventoryHash,
  );
  let materialsRoot: string | undefined;
  try {
    materialsRoot = await verifyArchive(
      options.stage,
      inventory.materialsArchive,
      "materials",
      inventory.files,
      inventoryHash,
    );
    if (
      (await hashFile(path.join(binaryRoot, "nas"))) !== inventory.binarySha256
    )
      throw new Error("bundled binary identity changed");
    await rm(path.join(materialsRoot, "inventory.json"));
    const materialInputs = await readReleaseInputs(materialsRoot);
    if (
      materialInputs.system !== inventory.system ||
      JSON.stringify(materialInputs.components) !==
        JSON.stringify(inventory.components)
    )
      throw new Error("material metadata differs from inventory");
    const origins = Object.fromEntries(
      Object.entries(inventory.payloadElf).map(([name, entry]) => [
        name,
        entry.component,
      ]),
    );
    if (
      JSON.stringify(Object.entries(origins).sort()) !==
      JSON.stringify(Object.entries(materialInputs.payloadOrigins ?? {}).sort())
    )
      throw new Error("payload origins differ from material metadata");
    const noticeHashes = await fileHashes(path.join(materialsRoot, "licenses"));
    if (
      JSON.stringify(noticeHashes) !== JSON.stringify(inventory.embeddedNotices)
    )
      throw new Error("embedded notices differ from source materials");
  } finally {
    await rm(binaryRoot, { recursive: true, force: true });
    if (materialsRoot)
      await rm(materialsRoot, { recursive: true, force: true });
  }
}
