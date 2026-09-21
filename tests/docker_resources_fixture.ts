import { afterAll } from "bun:test";
import { sharedDockerResources } from "../src/docker/shared_resources.ts";

/** Each E2E module owns its shared proxy and build tag, including failed runs. */
export function isolatedNasResources(): () => {
  NAS_RESOURCE_NAMESPACE: string;
} {
  const env = { NAS_RESOURCE_NAMESPACE: `test-${crypto.randomUUID()}` };
  const resources = sharedDockerResources(env);
  let used = false;
  afterAll(async () => {
    if (!used) return;
    for (const args of [
      ["rm", "-f", "-v", resources.proxyContainer],
      ["image", "rm", resources.sandboxImage],
    ]) {
      try {
        await Bun.spawn(["docker", ...args], {
          stdout: "ignore",
          stderr: "ignore",
          timeout: 10_000,
        }).exited;
      } catch {}
    }
  });
  // Mark use lazily: a fully skipped module never contacts Docker for cleanup.
  return () => {
    used = true;
    return env;
  };
}
