import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveNetworkRuntimePaths } from "./registry.ts";

test("resolveNetworkRuntimePaths: normalizes existing directory modes", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "nas-registry-"));
  const runtimeDir = `${rootDir}/network`;
  const sessionsDir = `${runtimeDir}/sessions`;
  const pendingDir = `${runtimeDir}/pending`;
  const brokersDir = `${runtimeDir}/brokers`;

  try {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await mkdir(sessionsDir, { recursive: true, mode: 0o755 });
    await mkdir(pendingDir, { recursive: true, mode: 0o755 });
    await mkdir(brokersDir, { recursive: true, mode: 0o755 });

    const paths = await resolveNetworkRuntimePaths(runtimeDir);

    expect(paths.runtimeDir).toEqual(runtimeDir);
    expect(await modeOf(runtimeDir)).toEqual(0o755);
    expect(await modeOf(sessionsDir)).toEqual(0o700);
    expect(await modeOf(pendingDir)).toEqual(0o700);
    expect(await modeOf(brokersDir)).toEqual(0o700);
  } finally {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function modeOf(targetPath: string): Promise<number> {
  return ((await stat(targetPath)).mode ?? 0) & 0o777;
}
