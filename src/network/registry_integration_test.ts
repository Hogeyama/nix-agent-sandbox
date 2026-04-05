import { assertEquals } from "@std/assert";
import { resolveNetworkRuntimePaths } from "./registry.ts";

Deno.test("resolveNetworkRuntimePaths: normalizes existing directory modes", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "nas-registry-" });
  const runtimeDir = `${rootDir}/network`;
  const sessionsDir = `${runtimeDir}/sessions`;
  const pendingDir = `${runtimeDir}/pending`;
  const brokersDir = `${runtimeDir}/brokers`;

  try {
    await Deno.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await Deno.mkdir(sessionsDir, { recursive: true, mode: 0o755 });
    await Deno.mkdir(pendingDir, { recursive: true, mode: 0o755 });
    await Deno.mkdir(brokersDir, { recursive: true, mode: 0o755 });

    const paths = await resolveNetworkRuntimePaths(runtimeDir);

    assertEquals(paths.runtimeDir, runtimeDir);
    assertEquals(await modeOf(runtimeDir), 0o755);
    assertEquals(await modeOf(sessionsDir), 0o700);
    assertEquals(await modeOf(pendingDir), 0o700);
    assertEquals(await modeOf(brokersDir), 0o700);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

async function modeOf(targetPath: string): Promise<number> {
  return ((await Deno.stat(targetPath)).mode ?? 0) & 0o777;
}
