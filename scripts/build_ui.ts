/**
 * フロントエンドビルドスクリプト — Bun bundler
 *
 * Bun.build() で TSX → バンドル済み JS を生成し、
 * index.html と合わせて src/ui/dist/ に出力する。
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const FRONTEND_DIR = path.join(ROOT, "src/ui/frontend");
const DIST_DIR = path.join(ROOT, "src/ui/dist");

// Clean dist
try {
  await rm(DIST_DIR, { recursive: true });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
await mkdir(path.join(DIST_DIR, "assets"), { recursive: true });

// Bundle TSX
const result = await Bun.build({
  entrypoints: [path.join(FRONTEND_DIR, "src/main.tsx")],
  outdir: path.join(DIST_DIR, "assets"),
  format: "esm",
  minify: true,
  splitting: false,
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  throw new Error("Build failed");
}

// Find the output JS filename
const jsOutput = result.outputs.find((o) => o.path.endsWith(".js"));
if (!jsOutput) throw new Error("No JS output found");
const jsBasename = path.basename(jsOutput.path);

// Inline CSS so the app ships as two files only
const xtermCss = await readFile(
  path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css"),
  "utf8",
);
const appCss = await readFile(
  path.join(FRONTEND_DIR, "src/styles.css"),
  "utf8",
);
const css = `${xtermCss}\n${appCss}`;

// Generate index.html with correct script path
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>nas — Dashboard</title>
  <style>
${css}
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/${jsBasename}"></script>
</body>
</html>
`;

await writeFile(path.join(DIST_DIR, "index.html"), html);

// Print summary
const jsSize = (await stat(path.join(DIST_DIR, "assets", jsBasename))).size;
console.log(`dist/index.html`);
console.log(`dist/assets/${jsBasename}  ${(jsSize / 1024).toFixed(2)} kB`);
