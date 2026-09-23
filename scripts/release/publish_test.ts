import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "./manifest.ts";
import { prepareRelease } from "./prepare.ts";
import { publicationFiles, publishRelease } from "./publish.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nas-publish-"));
  dirs.push(root);
  const dir = join(root, "publish");
  await mkdir(dir);
  const assets: Array<{ name: string; size: number }> = [];
  for (const system of ["x86_64-linux", "aarch64-linux"]) {
    const base = `nas-v1.2.3_${system}`;
    const inputs = join(root, `inputs-${system}`);
    const payload = join(root, `payload-${system}`);
    const stage = join(root, `stage-${system}`);
    await mkdir(join(inputs, "licenses"), { recursive: true });
    await mkdir(join(inputs, "sources"));
    await mkdir(join(payload, "share/nas/assets/licenses"), {
      recursive: true,
    });
    await mkdir(join(payload, "orig"));
    await writeFile(join(inputs, "licenses/COPYING"), "license\n");
    await writeFile(join(inputs, "sources/code.tar.gz"), "source\n");
    await writeFile(
      join(payload, "share/nas/assets/licenses/COPYING"),
      "license\n",
    );
    await writeFile(
      join(payload, "orig/nas"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    );
    await writeFile(
      join(inputs, "components.json"),
      JSON.stringify({
        schemaVersion: 1,
        system,
        components: [
          {
            id: "nas",
            version: "1.2.3",
            license: "MIT",
            origin: "fixture",
            requirements: ["DT-2"],
            decision: "source supplied",
            notices: ["licenses/COPYING"],
            sources: ["sources/code.tar.gz"],
          },
        ],
        payloadOrigins: { "orig/nas": "nas" },
      }),
    );
    const binary = join(root, `binary-${system}`);
    await writeFile(
      binary,
      `#!/bin/sh\nmkdir -p "$2"\ncp -R '${payload}/.' "$2/"\n`,
    );
    await chmod(binary, 0o755);
    await prepareRelease({
      inputs,
      binary,
      out: stage,
      tag: "v1.2.3",
    });
    const files = [
      `${base}.tar.gz`,
      `${base}-sources.tar.gz`,
      `${base}-components.json`,
    ];
    for (const file of files)
      await copyFile(join(stage, file), join(dir, file));
    await writeFile(
      join(dir, `${base}-sha256.txt`),
      (
        await Promise.all(
          files.map(
            async (file) => `${await hashFile(join(dir, file))}  ${file}\n`,
          ),
        )
      ).join(""),
    );
    for (const name of [...files, `${base}-sha256.txt`])
      assets.push({ name, size: (await stat(join(dir, name))).size });
  }
  await writeFile(
    join(dir, "remote.json"),
    JSON.stringify({ isDraft: true, assets }),
  );
  await writeFile(
    join(dir, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\nif [ "$2" = upload ] && [ "\${FAIL_UPLOAD:-}" = 1 ]; then exit 1; fi\nif [ "$2" = view ]; then cat "$REMOTE"; fi\n`,
  );
  await chmod(join(dir, "gh"), 0o755);
  return {
    dir,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CALLS: join(dir, "calls"),
      REMOTE: join(dir, "remote.json"),
    },
  };
}
test("publishes only after both architectures, successful upload and complete remote assets", async () => {
  const { dir, env } = await fixture();
  await publishRelease({
    directory: dir,
    tag: "v1.2.3",
    repo: "owner/repo",
    env,
  });
  const calls = (await readFile(env.CALLS, "utf8")).trim().split("\n");
  expect(calls.map((line) => line.split(" ")[1])).toEqual([
    "create",
    "upload",
    "view",
    "edit",
  ]);
  expect(calls[0]).toContain("--draft");
  expect(calls[1]).toContain("aarch64-linux-sources.tar.gz");
  expect(calls[3]).toContain("--draft=false");
});
test("upload failure leaves the release unpublished", async () => {
  const { dir, env } = await fixture();
  await expect(
    publishRelease({
      directory: dir,
      tag: "v1.2.3",
      repo: "owner/repo",
      env: { ...env, FAIL_UPLOAD: "1" },
    }),
  ).rejects.toThrow("failed");
  expect(await readFile(env.CALLS, "utf8")).not.toContain("release edit");
});

test("missing source or changed bytes fail before any network command", async () => {
  const { dir, env } = await fixture();
  await rm(join(dir, "nas-v1.2.3_aarch64-linux-sources.tar.gz"));
  await expect(
    publishRelease({
      directory: dir,
      tag: "v1.2.3",
      repo: "owner/repo",
      env,
    }),
  ).rejects.toThrow();
  expect(await Bun.file(env.CALLS).exists()).toBe(false);
  await writeFile(
    join(dir, "nas-v1.2.3_aarch64-linux-sources.tar.gz"),
    "altered source",
  );
  await expect(publicationFiles(dir, "v1.2.3")).rejects.toThrow(
    "checksum mismatch",
  );
});
test("tampered archive with a matching checksum fails before draft creation", async () => {
  const { dir, env } = await fixture();
  const base = "nas-v1.2.3_x86_64-linux";
  const archive = `${base}.tar.gz`;
  await writeFile(join(dir, archive), "not a tar archive");
  const files = [archive, `${base}-sources.tar.gz`, `${base}-components.json`];
  await writeFile(
    join(dir, `${base}-sha256.txt`),
    (
      await Promise.all(
        files.map(
          async (file) => `${await hashFile(join(dir, file))}  ${file}\n`,
        ),
      )
    ).join(""),
  );
  await expect(
    publishRelease({ directory: dir, tag: "v1.2.3", repo: "owner/repo", env }),
  ).rejects.toThrow("archive listing failed");
  expect(await Bun.file(env.CALLS).exists()).toBe(false);
});
test("incomplete remote set remains draft", async () => {
  const { dir, env } = await fixture();
  await writeFile(env.REMOTE, JSON.stringify({ isDraft: true, assets: [] }));
  await expect(
    publishRelease({
      directory: dir,
      tag: "v1.2.3",
      repo: "owner/repo",
      env,
    }),
  ).rejects.toThrow("incomplete");
  expect(await readFile(env.CALLS, "utf8")).not.toContain("release edit");
});
