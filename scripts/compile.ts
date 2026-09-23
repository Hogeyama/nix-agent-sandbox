/** Compile nas with an explicitly selected runtime and retain the emitted input graph. */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectJavaScriptMaterials } from "./release/javascript.ts";

const ROOT = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    outfile: { type: "string", default: "nas" },
    runtime: { type: "string", default: process.execPath },
    "materials-dir": { type: "string", default: ".release/cli" },
  },
});
const destination = resolve(ROOT, values["materials-dir"]);
await mkdir(destination, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(ROOT, "main.ts")],
  target: "bun",
  compile: {
    executablePath: resolve(values.runtime),
    outfile: resolve(values.outfile),
  },
  metafile: true,
});
if (!result.success)
  throw new AggregateError(result.logs, "nas compilation failed");
if (!result.metafile)
  throw new Error("nas compilation did not produce an input graph");
await collectJavaScriptMaterials({
  root: ROOT,
  destination,
  metafile: result.metafile,
});
console.log(
  `Compiled ${values.outfile} with ${values.runtime}; materials: ${destination}`,
);
