/**
 * Bun build script.
 * Replaces the old deno compile workflow.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.resolve(new URL("../", import.meta.url).pathname);
const pkgJson = JSON.parse(
  await readFile(path.join(ROOT, "package.json"), "utf8"),
);
const name = pkgJson.name ?? "nas";

const result = await Bun.build({
  entrypoints: [path.join(ROOT, "main.ts")],
  outdir: ROOT,
  naming: name,
  target: "bun",
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built ${name} successfully`);
