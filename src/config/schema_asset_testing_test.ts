import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { useRepoSchemaAsset } from "./schema_asset_testing.ts";

// An installed nas (the Nix store, or an extracted release) serves its asset
// tree read-only. Copying it must not carry that over, or replacing the relay
// script and removing the copy at restore both fail with EACCES.
test("useRepoSchemaAsset: works over a read-only installed asset tree", async () => {
  const installed = await mkdtemp(path.join(tmpdir(), "nas-installed-asset-"));
  const embed = path.join(installed, "docker", "embed");
  await mkdir(embed, { recursive: true });
  await writeFile(path.join(embed, "port-relay.mjs"), "// stale relay\n");
  await chmod(path.join(embed, "port-relay.mjs"), 0o444);
  await chmod(embed, 0o555);
  await chmod(path.join(installed, "docker"), 0o555);

  const previous = process.env.NAS_ASSET_DIR;
  process.env.NAS_ASSET_DIR = installed;
  try {
    const restore = await useRepoSchemaAsset();
    const assetDir = process.env.NAS_ASSET_DIR;
    expect(assetDir).not.toBe(installed);
    const relay = await readFile(
      path.join(assetDir ?? "", "docker", "embed", "port-relay.mjs"),
      "utf8",
    );
    expect(relay).not.toBe("// stale relay\n");

    await restore();
    expect(process.env.NAS_ASSET_DIR).toBe(installed);
    await expect(stat(assetDir ?? "")).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.NAS_ASSET_DIR;
    else process.env.NAS_ASSET_DIR = previous;
    await chmod(path.join(installed, "docker"), 0o755);
    await chmod(embed, 0o755);
    await rm(installed, { recursive: true, force: true });
  }
});
