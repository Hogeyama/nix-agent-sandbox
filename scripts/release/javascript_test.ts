import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJavaScriptMaterials } from "./javascript.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nas-js-materials-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function pkg(
  root: string,
  directory: string,
  name: string,
  version = "1.0.0",
  license = "MIT",
) {
  const dir = join(root, directory);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version, license }),
  );
  await writeFile(
    join(dir, "LICENSE"),
    "Original copyright and permission text\n",
  );
  await writeFile(join(dir, "index.js"), "export const x = 1;\n");
  return `${directory}/index.js`;
}
function graph(included: string[], unused: string[] = []) {
  return {
    inputs: Object.fromEntries(
      [...included, ...unused].map((p) => [p, { bytes: 1, imports: [] }]),
    ),
    outputs: {
      "out.js": {
        bytes: 1,
        inputs: Object.fromEntries(
          included.map((p) => [p, { bytesInOutput: 1 }]),
        ),
        imports: [],
        exports: [],
      },
    },
  };
}
test("uses emitted inputs, preserves scoped and nested package versions and original notices", async () => {
  const root = await fixture();
  const first = await pkg(root, "node_modules/@scope/dep", "@scope/dep");
  const second = await pkg(
    root,
    "node_modules/parent/node_modules/@scope/dep",
    "@scope/dep",
    "2.0.0",
  );
  const unused = await pkg(root, "node_modules/build-only", "build-only");
  await pkg(root, "node_modules/@scope/dep/node_modules/tool", "tool");
  await mkdir(join(root, "node_modules/@scope/dep/src"));
  await writeFile(
    join(root, "node_modules/@scope/dep/src/original.ts"),
    "export const x: number = 1;\n",
  );
  const destination = join(root, "materials");
  const result = await collectJavaScriptMaterials({
    root,
    destination,
    metafile: graph([first, second], [unused]),
  });
  expect(result.components.map((c) => c.version).sort()).toEqual([
    "1.0.0",
    "2.0.0",
  ]);
  expect(result.components.every((c) => c.requirements.includes("PKG-1"))).toBe(
    true,
  );
  for (const component of result.components) {
    expect(
      await readFile(join(destination, component.notices[0]), "utf8"),
    ).toBe("Original copyright and permission text\n");
    const source = join(destination, component.sources[0]);
    expect(await readFile(join(source, "index.js"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(await readdir(source)).not.toContain("node_modules");
  }
  expect(await readdir(join(destination, "sources"))).toHaveLength(2);
  const firstComponent = result.components.find((c) => c.version === "1.0.0");
  if (!firstComponent) throw new Error("missing emitted package");
  expect(
    await readFile(
      join(destination, firstComponent.sources[0], "src/original.ts"),
      "utf8",
    ),
  ).toBe("export const x: number = 1;\n");
});
test("includes explicitly copied font files even when the JS graph omits them", async () => {
  const root = await fixture();
  await pkg(root, "node_modules/font", "font", "1.0.0", "OFL-1.1");
  await writeFile(join(root, "node_modules/font/font.woff2"), "font bytes");
  const result = await collectJavaScriptMaterials({
    root,
    destination: join(root, "materials"),
    metafile: graph([]),
    extraInputs: ["node_modules/font/font.woff2"],
  });
  expect(result.components[0].requirements).toEqual(["FONT-1", "FONT-2"]);
  expect(
    result.inputs.some(
      (input) =>
        input.path.endsWith("font.woff2") &&
        /^[0-9a-f]{64}$/.test(input.sha256),
    ),
  ).toBe(true);
});
test("does not substitute package metadata for missing license text", async () => {
  const root = await fixture();
  const entry = await pkg(root, "node_modules/no-license", "no-license");
  await rm(join(root, "node_modules/no-license/LICENSE"));
  await expect(
    collectJavaScriptMaterials({
      root,
      destination: join(root, "materials"),
      metafile: graph([entry]),
    }),
  ).rejects.toThrow("permission text");
});
test("requires a component decision for an unfamiliar license", async () => {
  const root = await fixture();
  const entry = await pkg(
    root,
    "node_modules/unreviewed",
    "unreviewed",
    "1.0.0",
    "GPL-3.0-only",
  );
  await expect(
    collectJavaScriptMaterials({
      root,
      destination: join(root, "materials"),
      metafile: graph([entry]),
    }),
  ).rejects.toThrow("Unreviewed license");
});
test("captures nested source notices and rejects font byte changes in the input digest", async () => {
  const root = await fixture();
  const entry = await pkg(root, "node_modules/a", "a");
  await mkdir(join(root, "node_modules/a/legal"));
  await writeFile(
    join(root, "node_modules/a/legal/NOTICE.txt"),
    "Additional attribution",
  );
  const args = {
    root,
    destination: join(root, "materials"),
    metafile: graph([entry]),
  };
  const first = await collectJavaScriptMaterials(args);
  expect(first.components[0].notices).toHaveLength(2);
  await writeFile(join(root, entry), "changed bytes");
  const second = await collectJavaScriptMaterials(args);
  expect(first.inputs.find((f) => f.path === entry)?.sha256).not.toBe(
    second.inputs.find((f) => f.path === entry)?.sha256,
  );
});
