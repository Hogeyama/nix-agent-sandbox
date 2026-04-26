/**
 * Frontend build for the Solid-based control room.
 *
 * Bundles src/ui/frontend-next/src/main.tsx with the Solid Babel plugin
 * and emits index.html + assets/ into src/ui/dist-next/. The
 * `{{NAS_WS_TOKEN}}` placeholder is preserved for daemon-side
 * materializeAssets to substitute at runtime.
 */

import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { solidPlugin } from "./solid_plugin.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const FRONTEND_DIR = path.join(ROOT, "src/ui/frontend-next");
const DIST_DIR = path.join(ROOT, "src/ui/dist-next");
const ASSETS_DIR = path.join(DIST_DIR, "assets");
const FONT_SRC_DIR = path.join(
  ROOT,
  "node_modules/@fontsource-variable/geist-mono/files",
);
const FONT_OUT_DIR = path.join(ASSETS_DIR, "fonts");

const watch = process.argv.includes("--watch");

async function buildOnce(): Promise<void> {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(ASSETS_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [path.join(FRONTEND_DIR, "src/main.tsx")],
    outdir: ASSETS_DIR,
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
    plugins: [solidPlugin],
    loader: { ".woff2": "file" },
  });

  if (!result.success) {
    for (const msg of result.logs) console.error(msg);
    throw new Error("frontend-next build failed");
  }

  const jsOutput = result.outputs.find((o) => o.path.endsWith(".js"));
  if (!jsOutput) throw new Error("frontend-next build: no JS output");
  const jsBasename = path.basename(jsOutput.path);

  const tmpl = await readFile(
    path.join(FRONTEND_DIR, "index.html.tmpl"),
    "utf8",
  );
  const styles = await readFile(
    path.join(FRONTEND_DIR, "src/styles.css"),
    "utf8",
  );

  // Inline the bundled CSS produced by Bun.build (e.g. fontsource @font-face
  // rules with woff2 data URIs) BEFORE our handwritten styles. Keeping the
  // font face declarations first guarantees `font-family: 'Geist Mono Variable'`
  // resolves by the time component rules apply it. Without this inline step
  // the emitted index.html never links assets/main.css and Geist Mono
  // silently falls back to ui-monospace.
  const cssOutputs = result.outputs.filter((o) => o.path.endsWith(".css"));
  if (cssOutputs.length === 0) {
    throw new Error(
      "frontend-next build: no CSS output emitted by Bun.build. " +
        "Geist Mono @font-face rules would be missing and the font would " +
        "silently fall back to ui-monospace. Suspect: fontsource import " +
        "removed from src/main.tsx, Bun CSS-in-JS handling changed, or " +
        "solidPlugin no longer forwarding CSS imports.",
    );
  }
  // Prepend xterm's base stylesheet so terminal panes render correctly when
  // mounted. Placing it first lets src/ui/frontend-next/src/styles.css
  // override xterm defaults via standard CSS cascade.
  const xtermCssPath = path.join(
    ROOT,
    "node_modules/@xterm/xterm/css/xterm.css",
  );
  let xtermCss: string;
  try {
    xtermCss = await readFile(xtermCssPath, "utf8");
  } catch (e) {
    throw new Error(
      `xterm css not found at ${xtermCssPath}: ${(e as Error).message}`,
    );
  }
  let bundledCss = xtermCss;
  for (const out of cssOutputs) {
    bundledCss += await readFile(out.path, "utf8");
  }
  const css = bundledCss + styles;

  // Order matters: substitute {{CSS}} and {{JS}} but leave {{NAS_WS_TOKEN}}
  // for the daemon. The build-time assertion below catches accidental
  // double-substitution or template drift.
  const html = tmpl.replace("{{CSS}}", css).replace("{{JS}}", jsBasename);

  if (!html.includes("{{NAS_WS_TOKEN}}")) {
    throw new Error(
      "NAS_WS_TOKEN placeholder lost during build (template drift?)",
    );
  }

  await writeFile(path.join(DIST_DIR, "index.html"), html);

  // Copy fontsource woff2 files into assets/fonts/. Whether they are loaded
  // at runtime depends on which CSS the HTML template links: the bundled
  // fontsource CSS (assets/main.css) declares @font-face with url('./files/...')
  // resolved into this directory. Templates that want self-hosted Geist Mono
  // must either link assets/main.css or declare their own @font-face
  // referencing /assets/fonts/<name>.
  await mkdir(FONT_OUT_DIR, { recursive: true });
  let fontCount = 0;
  try {
    const entries = await readdir(FONT_SRC_DIR);
    for (const name of entries) {
      if (!name.endsWith(".woff2")) continue;
      await cp(path.join(FONT_SRC_DIR, name), path.join(FONT_OUT_DIR, name));
      fontCount++;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    throw new Error(
      `geist-mono font directory not found: ${FONT_SRC_DIR}. Run \`bun install\` first.`,
    );
  }
  if (fontCount === 0) {
    throw new Error(
      `no .woff2 files copied from ${FONT_SRC_DIR}; geist-mono package layout may have changed`,
    );
  }

  // Bundle third-party license texts so distributions (including the
  // bun-compile + nix-bundle-elf binary) carry the notices required by
  // OFL (Geist Mono) and MIT (xterm.js). Without these the woff2 files
  // and inlined xterm.css would ship without their license terms.
  const licenseDir = path.join(ASSETS_DIR, "licenses");
  await mkdir(licenseDir, { recursive: true });
  const licenseSources: Array<{ src: string; dst: string; label: string }> = [
    {
      src: path.join(
        ROOT,
        "node_modules/@fontsource-variable/geist-mono/LICENSE",
      ),
      dst: path.join(licenseDir, "Geist-OFL.txt"),
      label: "geist-mono",
    },
    {
      src: path.join(ROOT, "node_modules/@xterm/xterm/LICENSE"),
      dst: path.join(licenseDir, "xterm-MIT.txt"),
      label: "xterm",
    },
  ];
  for (const { src, dst, label } of licenseSources) {
    try {
      await cp(src, dst);
    } catch (e) {
      throw new Error(
        `${label} LICENSE not found at ${src}: ${(e as Error).message}`,
      );
    }
  }

  const jsSize = (await stat(path.join(ASSETS_DIR, jsBasename))).size;
  console.log(`dist-next/index.html`);
  console.log(
    `dist-next/assets/${jsBasename}  ${(jsSize / 1024).toFixed(2)} kB`,
  );
  console.log(`dist-next/assets/fonts/  ${fontCount} woff2 file(s)`);
  console.log(`dist-next/assets/licenses/  ${licenseSources.length} file(s)`);
}

await buildOnce();

if (watch) {
  // Bun.build has no built-in watcher option; poll the source tree and
  // rebuild on change. Keeps the script free of an extra dep.
  const watchRoots = [
    path.join(FRONTEND_DIR, "src"),
    path.join(FRONTEND_DIR, "index.html.tmpl"),
  ];
  let lastBuild = Date.now();
  console.log("watching", watchRoots.join(", "));

  async function newestMtime(root: string): Promise<number> {
    let max = 0;
    const st = await stat(root).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!st) return 0;
    if (st.isFile()) return st.mtimeMs;
    const entries = await readdir(root, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(root, ent.name);
      const m = ent.isDirectory()
        ? await newestMtime(full)
        : (await stat(full)).mtimeMs;
      if (m > max) max = m;
    }
    return max;
  }

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let newest = 0;
    for (const root of watchRoots) {
      const m = await newestMtime(root);
      if (m > newest) newest = m;
    }
    if (newest > lastBuild) {
      lastBuild = Date.now();
      try {
        await buildOnce();
      } catch (e) {
        console.error(e);
      }
    }
  }
}
