/** Publish the already-verified two-architecture artifact set as one draft transaction. */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hashFile } from "./manifest.ts";
import { assetBase, isProduct, type Product } from "./prepare.ts";
import { verifyRelease } from "./verify.ts";

const systems = ["x86_64-linux", "aarch64-linux"] as const;
const tagPatterns: Record<Product, RegExp> = {
  nas: /^v\d+\.\d+\.\d+$/,
  strait: /^strait-v\d+\.\d+\.\d+$/,
};

export async function publicationFiles(
  directory: string,
  tag: string,
  product: Product = "nas",
): Promise<string[]> {
  if (!tagPatterns[product].test(tag))
    throw new Error(`Invalid release tag: ${tag}`);
  const files: string[] = [];
  for (const system of systems) {
    const prefix = assetBase(product, tag, system);
    const expected = [
      `${prefix}.tar.gz`,
      `${prefix}-sources.tar.gz`,
      `${prefix}-components.json`,
    ];
    const checksum = `${prefix}-sha256.txt`;
    const lines = (await readFile(join(directory, checksum), "utf8"))
      .trim()
      .split("\n");
    const entries = new Map<string, string>();
    for (const line of lines) {
      const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
      if (!match || entries.has(match[2]))
        throw new Error(`Invalid or duplicate checksum entry: ${checksum}`);
      entries.set(match[2], match[1]);
    }
    if (
      JSON.stringify([...entries.keys()].sort()) !==
      JSON.stringify([...expected].sort())
    ) {
      throw new Error(`Incomplete artifact set for ${system}`);
    }
    for (const name of expected) {
      const file = join(directory, name);
      if (!(await stat(file)).isFile() || (await stat(file)).size === 0)
        throw new Error(`Missing artifact: ${name}`);
      if ((await hashFile(file)) !== entries.get(name))
        throw new Error(`Artifact checksum mismatch: ${name}`);
    }
    const inventory = JSON.parse(
      await readFile(join(directory, `${prefix}-components.json`), "utf8"),
    );
    if (
      inventory.schemaVersion !== 1 ||
      (inventory.product ?? "nas") !== product ||
      inventory.system !== system ||
      inventory.tag !== tag ||
      inventory.binaryArchive !== expected[0] ||
      inventory.materialsArchive !== expected[1]
    ) {
      throw new Error(`Artifact identity mismatch: ${system}`);
    }
    files.push(...expected, checksum);
  }
  return files;
}

export async function publishRelease(options: {
  directory: string;
  tag: string;
  repo: string;
  env?: NodeJS.ProcessEnv;
  product?: Product;
  /** Defaults to the tag. */
  title?: string;
  /** Release notes; GitHub generates them when absent. */
  notesFile?: string;
  /** false keeps /releases/latest on nas when another product publishes. */
  latest?: boolean;
}): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo))
    throw new Error("Invalid repository");
  const product = options.product ?? "nas";
  const directory = resolve(options.directory);
  const files = await publicationFiles(directory, options.tag, product);
  for (const system of systems) {
    await verifyRelease({
      stage: directory,
      inventoryArtifact: `${assetBase(product, options.tag, system)}-components.json`,
    });
  }
  async function gh(args: string[]) {
    const proc = Bun.spawn(["gh", ...args], {
      cwd: directory,
      env: options.env ?? process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (status !== 0)
      throw new Error(
        `gh ${args.slice(0, 2).join(" ")} failed (${status}): ${stderr.trim()}`,
      );
    return stdout;
  }
  await gh([
    "release",
    "create",
    options.tag,
    "--repo",
    options.repo,
    "--draft",
    "--verify-tag",
    "--title",
    options.title ?? options.tag,
    ...(options.notesFile
      ? ["--notes-file", resolve(options.notesFile)]
      : ["--generate-notes"]),
    ...(options.latest === false ? ["--latest=false"] : []),
  ]);
  await gh([
    "release",
    "upload",
    options.tag,
    "--repo",
    options.repo,
    ...files,
  ]);
  const remote = JSON.parse(
    await gh([
      "release",
      "view",
      options.tag,
      "--repo",
      options.repo,
      "--json",
      "isDraft,assets",
    ]),
  );
  if (remote.isDraft !== true || !Array.isArray(remote.assets))
    throw new Error("Expected a draft release with assets");
  const names = remote.assets
    .map((asset: { name: string }) => asset.name)
    .sort();
  if (JSON.stringify(names) !== JSON.stringify([...files].sort()))
    throw new Error("Draft release artifact set is incomplete");
  for (const asset of remote.assets) {
    if (asset.size !== (await stat(join(directory, asset.name))).size)
      throw new Error(`Draft asset size mismatch: ${asset.name}`);
  }
  await gh([
    "release",
    "edit",
    options.tag,
    "--repo",
    options.repo,
    "--draft=false",
    ...(options.latest === false ? ["--latest=false"] : []),
  ]);
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      directory: { type: "string" },
      tag: { type: "string" },
      repo: { type: "string" },
      product: { type: "string", default: "nas" },
      title: { type: "string" },
      "notes-file": { type: "string" },
      "not-latest": { type: "boolean", default: false },
    },
  });
  if (
    !values.directory ||
    !values.tag ||
    !values.repo ||
    !isProduct(values.product)
  )
    throw new Error(
      "usage: publish.ts --directory DIR --tag TAG --repo OWNER/REPO [--product nas|strait] [--title T] [--notes-file F] [--not-latest]",
    );
  await publishRelease({
    directory: values.directory,
    tag: values.tag,
    repo: values.repo,
    product: values.product,
    title: values.title,
    notesFile: values["notes-file"],
    latest: values["not-latest"] ? false : undefined,
  });
}
