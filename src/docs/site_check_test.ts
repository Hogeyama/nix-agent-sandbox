import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectSiteErrors } from "./site_check.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createSite(files: Record<string, string | Uint8Array> = {}) {
  const siteDir = await mkdtemp(join(tmpdir(), "nas-docs-"));
  temporaryDirectories.push(siteDir);

  const fixture = {
    "index.html": '<a href="/nix-agent-sandbox/guide/#known">Guide</a>',
    "guide/index.html": '<h1 id="known">Guide</h1>',
    "images/example.png": new Uint8Array(),
    "pagefind/pagefind.js": "export {};",
    "pagefind/index/guide.pf_index": "index",
    ...files,
  };

  await Promise.all(
    Object.entries(fixture).map(async ([file, contents]) => {
      const path = join(siteDir, file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, contents);
    }),
  );

  return siteDir;
}

function collect(siteDir: string) {
  return collectSiteErrors({ siteDir, basePath: "/nix-agent-sandbox" });
}

test("accepts base-prefixed pages, assets, and fragments", async () => {
  const siteDir = await createSite({
    "index.html": `
      <a href="/nix-agent-sandbox/guide/?source=home#known">Guide</a>
      <img src="/nix-agent-sandbox/images/example.png" alt="Example">
    `,
  });

  expect(await collect(siteDir)).toEqual([]);
});

test("reports a missing internal page", async () => {
  const siteDir = await createSite({
    "index.html": '<a href="/nix-agent-sandbox/missing/">Missing</a>',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing target missing/index.html",
  ]);
});

test("reports a missing image", async () => {
  const siteDir = await createSite({
    "index.html":
      '<img src="/nix-agent-sandbox/images/missing.png" alt="Missing">',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing target images/missing.png",
  ]);
});

test("reports paths below a file as missing targets", async () => {
  const siteDir = await createSite({
    blocked: "not a directory",
    "index.html":
      '<img src="/nix-agent-sandbox/blocked/missing.png" alt="Missing">',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing target blocked/missing.png",
  ]);
});

test("allows in-site paths whose names begin with two dots", async () => {
  const siteDir = await createSite({
    "..assets/example.png": new Uint8Array(),
    "index.html":
      '<img src="/nix-agent-sandbox/..assets/example.png" alt="Example">',
  });

  expect(await collect(siteDir)).toEqual([]);
});

test("reports a missing heading fragment", async () => {
  const siteDir = await createSite({
    "index.html":
      '<a href="/nix-agent-sandbox/guide/#missing-heading">Missing</a>',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing fragment #missing-heading in guide/index.html",
  ]);
});

test("ignores data-href and data-src attributes", async () => {
  const siteDir = await createSite({
    "index.html": `
      <div data-href="/nix-agent-sandbox/missing/"></div>
      <img data-src="/nix-agent-sandbox/images/missing.png" alt="Placeholder">
    `,
  });

  expect(await collect(siteDir)).toEqual([]);
});

test("does not treat data-id as a heading fragment", async () => {
  const siteDir = await createSite({
    "index.html":
      '<h1 data-id="not-a-heading">Home</h1><a href="#not-a-heading">Here</a>',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing fragment #not-a-heading in index.html",
  ]);
});

test("ignores references in comments, scripts, and text", async () => {
  const siteDir = await createSite({
    "index.html": `
      <!-- <a href="/nix-agent-sandbox/missing/">Comment</a> -->
      <script>const template = 'href="/nix-agent-sandbox/missing/"';</script>
      <p>href="/nix-agent-sandbox/missing/"</p>
    `,
  });

  expect(await collect(siteDir)).toEqual([]);
});

test("does not treat ids in comments, scripts, or text as fragments", async () => {
  const siteDir = await createSite({
    "index.html": `
      <!-- <h1 id="inert">Comment</h1> -->
      <script>const template = 'id="inert"';</script>
      <p>id="inert"</p>
      <a href="#inert">Missing</a>
    `,
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing fragment #inert in index.html",
  ]);
});

test("decodes HTML character references in generated URLs", async () => {
  const siteDir = await createSite({
    "images/a&b.png": new Uint8Array(),
    "index.html":
      '<img src="/nix-agent-sandbox/images/a&amp;b.png" alt="Image">',
  });

  expect(await collect(siteDir)).toEqual([]);
});

test("keeps literal percent escapes in element IDs", async () => {
  const siteDir = await createSite({
    "index.html":
      '<h1 id="foo%20bar">Heading</h1><a href="#foo%20bar">Link</a>',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing fragment #foo bar in index.html",
  ]);
});

test("validates same-page fragments and ignores external, mailto, and data references", async () => {
  const siteDir = await createSite({
    "index.html": `
      <h1 id="same-page">Home</h1>
      <a href="#same-page">Here</a>
      <a href="#missing-same-page">Missing here</a>
      <a href="https://example.com/missing">External</a>
      <a href="mailto:docs@example.com">Email</a>
      <img src="data:image/png;base64,AAAA" alt="Inline">
      <a href="//example.com/missing">Protocol relative</a>
    `,
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing fragment #missing-same-page in index.html",
  ]);
});

test("requires Pagefind JavaScript and at least one index shard", async () => {
  const siteDir = await createSite();
  await rm(join(siteDir, "pagefind/pagefind.js"));
  await rm(join(siteDir, "pagefind/index/guide.pf_index"));

  expect(await collect(siteDir)).toEqual([
    "site: missing Pagefind JavaScript pagefind/pagefind.js",
    "site: missing Pagefind index shard (*.pf_index)",
  ]);
});

test("requires the Pagefind index shard to be inside the Pagefind directory", async () => {
  const siteDir = await createSite();
  await rm(join(siteDir, "pagefind/index/guide.pf_index"));
  await mkdir(join(siteDir, "unrelated"));
  await writeFile(join(siteDir, "unrelated/guide.pf_index"), "index");

  expect(await collect(siteDir)).toEqual([
    "site: missing Pagefind index shard (*.pf_index)",
  ]);
});

test("accepts a README within the configured inclusive line range", async () => {
  for (const lineCount of [100, 150]) {
    const siteDir = await createSite({
      "README.md": `${Array(lineCount).fill("line").join("\n")}\n`,
    });

    expect(
      await collectSiteErrors({
        siteDir,
        basePath: "/nix-agent-sandbox",
        readme: {
          path: join(siteDir, "README.md"),
          minLines: 100,
          maxLines: 150,
        },
      }),
    ).toEqual([]);
  }
});

test("reports a README shorter or longer than the configured range", async () => {
  for (const lineCount of [99, 151]) {
    const siteDir = await createSite({
      "README.md": `${Array(lineCount).fill("line").join("\n")}\n`,
    });

    expect(
      await collectSiteErrors({
        siteDir,
        basePath: "/nix-agent-sandbox",
        readme: {
          path: join(siteDir, "README.md"),
          minLines: 100,
          maxLines: 150,
        },
      }),
    ).toEqual([`README: expected 100-150 lines, found ${lineCount}`]);
  }
});

test("counts an empty README as zero physical lines", async () => {
  const siteDir = await createSite({ "README.md": "" });

  expect(
    await collectSiteErrors({
      siteDir,
      basePath: "/nix-agent-sandbox",
      readme: { path: join(siteDir, "README.md"), minLines: 0, maxLines: 0 },
    }),
  ).toEqual([]);
});

test("decodes encoded targets and reports malformed escapes without throwing", async () => {
  const siteDir = await createSite({
    "guide/index.html": '<h1 id="known-heading">Guide</h1>',
    "index.html": `
      <a href="/nix-agent-sandbox/guide/%69ndex.html#known%2Dheading">Guide</a>
      <a href="/nix-agent-sandbox/%ZZ">Malformed</a>
    `,
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing target %ZZ/index.html",
  ]);
});

test("rejects base prefixes that are not a complete path segment", async () => {
  const siteDir = await createSite({
    "index.html":
      '<img src="/nix-agent-sandbox-extra/missing.png" alt="Missing">',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: root-relative reference is outside base path /nix-agent-sandbox-extra/missing.png",
  ]);
});

test("rejects root-relative pages and assets outside the configured base", async () => {
  const siteDir = await createSite({
    "index.html": `
      <a href="/guide/">Guide</a>
      <img src="/images/example.png" alt="Example">
    `,
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: root-relative reference is outside base path /guide/",
    "index.html: root-relative reference is outside base path /images/example.png",
  ]);
});

test("accepts root-relative references when the configured base is root", async () => {
  const siteDir = await createSite({
    "index.html": `
      <a href="/guide/">Guide</a>
      <img src="/images/example.png" alt="Example">
    `,
  });

  expect(await collectSiteErrors({ siteDir, basePath: "/" })).toEqual([]);
});

test("reports traversal outside the generated site", async () => {
  const siteDir = await createSite({
    "index.html": '<a href="../../outside/">Outside</a>',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: target escapes site directory ../../outside/",
  ]);
});

test("does not let malformed escapes hide encoded traversal", async () => {
  const siteDir = await createSite({
    "index.html":
      '<a href="/nix-agent-sandbox/%2e%2e/%ZZ/outside/">Outside</a>',
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: target escapes site directory /nix-agent-sandbox/%2e%2e/%ZZ/outside/",
  ]);
});

test("resolves relative extensionless routes", async () => {
  const siteDir = await createSite({
    "guide/child/index.html": "<h1>Child</h1>",
    "guide/index.html": '<h1 id="known">Guide</h1><a href="child">Child</a>',
  });

  expect(await collect(siteDir)).toEqual([]);
});

test("returns multiple generated-site errors in stable order", async () => {
  const siteDir = await createSite({
    "index.html": `
      <a href="/nix-agent-sandbox/z-missing/">Page</a>
      <img src="/nix-agent-sandbox/a-missing.png" alt="Image">
    `,
  });

  expect(await collect(siteDir)).toEqual([
    "index.html: missing target a-missing.png",
    "index.html: missing target z-missing/index.html",
  ]);
});

test("collects nested unquoted href, src, and id attributes", async () => {
  const siteDir = await createSite({
    "index.html": `
      <section>
        <h1 id=nested-heading>Heading</h1>
        <a href=#nested-heading>Fragment</a>
        <img src=/nix-agent-sandbox/images/example.png alt=Example>
      </section>
    `,
  });

  expect(await collect(siteDir)).toEqual([]);
});
