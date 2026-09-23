import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareRelease } from "./prepare.ts";
import { verifyRelease } from "./verify.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nas-release-test-"));
  temporary.push(root);
  const inputs = path.join(root, "release-inputs");
  const payload = path.join(root, "payload");
  await mkdir(path.join(inputs, "licenses/bun/cargo-inputs"), {
    recursive: true,
  });
  await mkdir(path.join(inputs, "sources"));
  await mkdir(
    path.join(payload, "share/nas/assets/licenses/bun/cargo-inputs"),
    { recursive: true },
  );
  await mkdir(path.join(payload, "orig"));
  await writeFile(path.join(inputs, "licenses/COPYING"), "License notice\n");
  await writeFile(
    path.join(inputs, "licenses/bun/cargo-inputs/NOTICE"),
    "Source-only notice\n",
  );
  await writeFile(
    path.join(inputs, "sources/code.tar.gz"),
    "actual source bytes\n",
  );
  await copyFile(
    path.join(inputs, "licenses/COPYING"),
    path.join(payload, "share/nas/assets/licenses/COPYING"),
  );
  await copyFile(
    path.join(inputs, "licenses/bun/cargo-inputs/NOTICE"),
    path.join(payload, "share/nas/assets/licenses/bun/cargo-inputs/NOTICE"),
  );
  await writeFile(
    path.join(payload, "orig/nas"),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]),
  );
  const metadata = {
    schemaVersion: 1,
    system: "x86_64-linux",
    components: [
      {
        id: "dtach",
        version: "0.9",
        license: "GPL-2.0-or-later",
        origin: "fixture",
        requirements: ["DT-1", "DT-2"],
        decision: "DT-2 source supplied",
        notices: ["licenses/COPYING"],
        sources: ["sources/code.tar.gz"],
      },
    ],
    payloadOrigins: { "orig/nas": "dtach" } as Record<string, string>,
  };
  await writeFile(
    path.join(inputs, "components.json"),
    JSON.stringify(metadata),
  );
  const binary = path.join(root, "bundle");
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" != "--extract" ]; then exit 2; fi\nmkdir -p "$2"\ncp -R '${payload}/.' "$2/"\n`,
  );
  await chmod(binary, 0o755);
  return {
    root,
    inputs,
    payload,
    binary,
    metadata,
    out: path.join(root, "stage"),
  };
}

test("stages exact material bytes and verifies both archives", async () => {
  const f = await fixture();
  const inventory = await prepareRelease({
    inputs: f.inputs,
    binary: f.binary,
    out: f.out,
    tag: "v1.2.3",
  });
  expect(inventory.payloadElf["orig/nas"]?.component).toBe("dtach");
  expect(
    await readFile(path.join(f.out, "materials/sources/code.tar.gz"), "utf8"),
  ).toBe("actual source bytes\n");
  expect(
    await readFile(
      path.join(f.out, "binary/licenses/bun/cargo-inputs/NOTICE"),
      "utf8",
    ),
  ).toBe("Source-only notice\n");
  expect(
    await readFile(path.join(f.out, inventory.componentsArtifact), "utf8"),
  ).toContain("GPL-2.0-or-later");
  await verifyRelease({ stage: f.out });
});

test("archives name their members without a root entry", async () => {
  // A `./` member makes tar reset the target directory's mode and mtime,
  // which fails when extracting into a shared directory such as /tmp.
  const f = await fixture();
  const inventory = await prepareRelease({
    inputs: f.inputs,
    binary: f.binary,
    out: f.out,
    tag: "v1.2.3",
  });
  for (const archive of [inventory.binaryArchive, inventory.materialsArchive]) {
    const list = Bun.spawnSync(["tar", "-tzf", path.join(f.out, archive)]);
    const members = list.stdout.toString().trim().split("\n");
    expect(members.filter((m) => m === "./" || m.startsWith("./"))).toEqual([]);
  }
  expect(
    Bun.spawnSync(["tar", "-tzf", path.join(f.out, inventory.binaryArchive)])
      .stdout.toString()
      .split("\n"),
  ).toContain("nas");
});

test("missing source and changed embedded notice block staging", async () => {
  const f = await fixture();
  await rm(path.join(f.inputs, "sources/code.tar.gz"));
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("missing required file");
  await writeFile(path.join(f.inputs, "sources/code.tar.gz"), "source\n");
  await writeFile(
    path.join(f.payload, "share/nas/assets/licenses/COPYING"),
    "changed\n",
  );
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("embedded notice mismatch");
});

test("rejects unsafe material paths, missing source references, and unknown ELF origins", async () => {
  const f = await fixture();
  f.metadata.components[0].sources = [];
  await writeFile(
    path.join(f.inputs, "components.json"),
    JSON.stringify(f.metadata),
  );
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("requires source material");
  f.metadata.components[0].sources = ["sources/../code.tar.gz"];
  await writeFile(
    path.join(f.inputs, "components.json"),
    JSON.stringify(f.metadata),
  );
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("unsafe relative path");
  f.metadata.components[0].sources = ["sources/code.tar.gz"];
  await rm(path.join(f.inputs, "sources/code.tar.gz"));
  await symlink(
    path.join(f.root, "outside"),
    path.join(f.inputs, "sources/code.tar.gz"),
  );
  await writeFile(
    path.join(f.inputs, "components.json"),
    JSON.stringify(f.metadata),
  );
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("symlink is forbidden");
  await rm(path.join(f.inputs, "sources/code.tar.gz"));
  await writeFile(path.join(f.inputs, "sources/code.tar.gz"), "source\n");
  f.metadata.payloadOrigins = { "orig/unknown": "dtach" };
  await writeFile(
    path.join(f.inputs, "components.json"),
    JSON.stringify(f.metadata),
  );
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("unregistered ELF payload");
});

test("rejects unsupported architecture, unknown component, and altered archive", async () => {
  const f = await fixture();
  f.metadata.system = "riscv64-linux";
  await writeFile(
    path.join(f.inputs, "components.json"),
    JSON.stringify(f.metadata),
  );
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("unsupported architecture");
  f.metadata.system = "x86_64-linux";
  f.metadata.payloadOrigins = { "orig/nas": "unknown" };
  await writeFile(
    path.join(f.inputs, "components.json"),
    JSON.stringify(f.metadata),
  );
  await expect(
    prepareRelease({
      inputs: f.inputs,
      binary: f.binary,
      out: f.out,
      tag: "v1",
    }),
  ).rejects.toThrow("unknown payload origin");
  f.metadata.payloadOrigins = { "orig/nas": "dtach" };
  await writeFile(
    path.join(f.inputs, "components.json"),
    JSON.stringify(f.metadata),
  );
  const inventory = await prepareRelease({
    inputs: f.inputs,
    binary: f.binary,
    out: f.out,
    tag: "v1",
  });
  await writeFile(path.join(f.out, inventory.binaryArchive), "broken archive");
  await expect(verifyRelease({ stage: f.out })).rejects.toThrow(
    "archive listing failed",
  );
});
