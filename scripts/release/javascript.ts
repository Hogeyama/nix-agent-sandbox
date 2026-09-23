/** Material inventory for inputs actually emitted by Bun and explicitly copied assets. */
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

interface JavaScriptComponent {
  id: string;
  version: string;
  license: string;
  origin: string;
  requirements: string[];
  decision: string;
  notices: string[];
  sources: string[];
}
interface InputFile {
  path: string;
  sha256: string;
}
const permissionName = /^(?:licen[cs]e|copying|ofl)(?:[._-].*)?$/i;
const noticeName =
  /^(?:licen[cs]e|copying|ofl|notice|authors|copyright)(?:[._-].*)?$/i;
const supported = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "OFL-1.1"]);
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function packageRoot(
  file: string,
  root: string,
): Promise<string | undefined> {
  if (!relative(root, file).split("/").includes("node_modules")) return;
  let directory = dirname(file);
  while (directory !== root && directory !== dirname(directory)) {
    try {
      const json = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (typeof json.name === "string" && typeof json.version === "string")
        return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  throw new Error(`No package metadata for emitted dependency ${file}`);
}

async function licenseFiles(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await licenseFiles(root, file)));
    else if (noticeName.test(entry.name)) {
      const actual = await realpath(file);
      const rel = relative(await realpath(root), actual);
      if (rel.startsWith("../") || isAbsolute(rel))
        throw new Error(`Notice escapes package: ${file}`);
      if (!(await stat(actual)).isFile())
        throw new Error(`Notice is not a file: ${file}`);
      if ((await readFile(file)).length === 0)
        throw new Error(`Empty notice: ${file}`);
      found.push(file);
    }
  }
  return found.sort();
}

export async function collectJavaScriptMaterials(options: {
  root: string;
  destination: string;
  metafile: Bun.BuildMetafile;
  extraInputs?: string[];
}): Promise<{ components: JavaScriptComponent[]; inputs: InputFile[] }> {
  const root = resolve(options.root);
  const emitted = new Set(options.extraInputs ?? []);
  for (const output of Object.values(options.metafile.outputs)) {
    for (const [file, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput > 0) emitted.add(file);
    }
  }
  const packages = new Map<string, Set<string>>();
  for (const name of [...emitted].sort()) {
    const file = resolve(root, name);
    const pkgRoot = await packageRoot(file, root);
    if (!pkgRoot) continue;
    const files = packages.get(pkgRoot) ?? new Set<string>();
    files.add(file);
    packages.set(pkgRoot, files);
  }
  const components: JavaScriptComponent[] = [];
  const inputs: InputFile[] = [];
  await mkdir(options.destination, { recursive: true });
  for (const [pkgRoot, files] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const packageFile = join(pkgRoot, "package.json");
    const pkg = JSON.parse(await readFile(packageFile, "utf8"));
    if (!supported.has(pkg.license)) {
      throw new Error(
        `Unreviewed license for ${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.license)}`,
      );
    }
    const notices = await licenseFiles(pkgRoot);
    if (!notices.some((p) => permissionName.test(basename(p)))) {
      throw new Error(`Missing permission text for ${pkg.name}@${pkg.version}`);
    }
    const id = `npm-${`${pkg.name}-${pkg.version}`.replace(/[^a-zA-Z0-9._-]/g, "-")}-${hash(relative(root, pkgRoot)).slice(0, 12)}`;
    const sourcePath = `sources/${id}`;
    await cp(pkgRoot, join(options.destination, sourcePath), {
      recursive: true,
      dereference: true,
      filter: (file) => !["node_modules", ".git"].includes(basename(file)),
    });
    const noticePaths: string[] = [];
    for (const notice of notices) {
      const destination = `licenses/${id}/${relative(pkgRoot, notice)}`;
      await mkdir(dirname(join(options.destination, destination)), {
        recursive: true,
      });
      await cp(notice, join(options.destination, destination), {
        dereference: true,
      });
      noticePaths.push(destination);
    }
    for (const file of [
      ...new Set([...files, packageFile, ...notices]),
    ].sort()) {
      inputs.push({
        path: relative(root, file),
        sha256: hash(await readFile(file)),
      });
    }
    const font = pkg.license === "OFL-1.1";
    components.push({
      id,
      version: pkg.version,
      license: pkg.license,
      origin: `npm:${pkg.name}@${pkg.version} (${relative(root, pkgRoot)})`,
      requirements: font ? ["FONT-1", "FONT-2"] : ["PKG-1"],
      decision: font
        ? "FONT-1/FONT-2: ship original font bytes and upstream copyright/OFL texts as part of nas"
        : "PKG-1: preserve upstream permission and attribution texts for emitted package inputs",
      notices: noticePaths,
      sources: [sourcePath],
    });
  }
  const result = {
    components,
    inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeFile(
    join(options.destination, "components.json"),
    `${JSON.stringify({ components }, null, 2)}\n`,
  );
  await writeFile(
    join(options.destination, "inputs.json"),
    `${JSON.stringify(result.inputs, null, 2)}\n`,
  );
  await writeFile(
    join(options.destination, "metafile.json"),
    `${JSON.stringify(options.metafile, null, 2)}\n`,
  );
  return result;
}
