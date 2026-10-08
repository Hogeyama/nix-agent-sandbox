// Bundle dind-bridge into one executable file for Node.js 22 or later.
//   bun contrib/dind-bridge/build.ts [--outfile PATH]
import { chmod, readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function buildDindBridge(outfile: string): Promise<string> {
  const version = (
    await readFile(join(import.meta.dir, "VERSION"), "utf8")
  ).trim();
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/main.mjs")],
    target: "node",
    outdir: dirname(outfile),
    naming: `${basename(outfile)}.js`,
    define: { DIND_BRIDGE_VERSION: JSON.stringify(version) },
    banner: "#!/usr/bin/env node",
  });
  if (!result.success)
    throw new AggregateError(result.logs, "dind-bridge bundle failed");
  const [output] = result.outputs;
  if (!output || result.outputs.length !== 1)
    throw new Error(
      `dind-bridge bundle produced ${result.outputs.length} files, expected 1`,
    );
  await rename(output.path, outfile);
  await chmod(outfile, 0o755);
  return version;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--outfile");
  const outfile =
    (at >= 0 ? args[at + 1] : undefined) ??
    join(import.meta.dir, "dist/dind-bridge");
  const version = await buildDindBridge(outfile);
  console.log(`built ${outfile} (dind-bridge ${version})`);
}
