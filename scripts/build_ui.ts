/**
 * フロントエンドビルドスクリプト — esbuild + esbuild_deno_loader
 *
 * Vite を使わず、esbuild で TSX → バンドル済み JS を生成し、
 * index.html と合わせて src/ui/dist/ に出力する。
 */

import * as esbuild from "esbuild";
import { denoPlugins } from "esbuild-deno-loader";

const ROOT = new URL("../", import.meta.url).pathname;
const FRONTEND_DIR = `${ROOT}src/ui/frontend`;
const DIST_DIR = `${ROOT}src/ui/dist`;

// Clean dist
try {
  await Deno.remove(DIST_DIR, { recursive: true });
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
await Deno.mkdir(`${DIST_DIR}/assets`, { recursive: true });

// Bundle TSX
const result = await esbuild.build({
  plugins: [
    ...denoPlugins({ loader: "native", configPath: `${ROOT}deno.json` }),
  ],
  entryPoints: [`${FRONTEND_DIR}/src/main.tsx`],
  outdir: `${DIST_DIR}/assets`,
  bundle: true,
  format: "esm",
  minify: true,
  splitting: false,
  jsx: "automatic",
  jsxImportSource: "preact",
  metafile: true,
});

// Find the output JS filename
const outputs = Object.keys(result.metafile!.outputs);
const jsFile = outputs.find((f) => f.endsWith(".js"));
if (!jsFile) throw new Error("No JS output found");
const jsBasename = jsFile.split("/").pop()!;

// Generate index.html with correct script path
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>nas — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/${jsBasename}"></script>
</body>
</html>
`;

await Deno.writeTextFile(`${DIST_DIR}/index.html`, html);

esbuild.stop();

// Print summary
const jsSize = (await Deno.stat(`${DIST_DIR}/assets/${jsBasename}`)).size;
console.log(`dist/index.html`);
console.log(
  `dist/assets/${jsBasename}  ${(jsSize / 1024).toFixed(2)} kB`,
);
