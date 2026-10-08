import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { loopbackEndpoint } from "../../../src/docker/embed/dind-bridge-protocol.mjs";

/** Wait for the daemon, not just the bridge's local listener, to be usable. */
export async function waitForDocker(
  dockerHost,
  { timeoutMs = 30_000, retryMs = 250 } = {},
) {
  let endpoint;
  if (dockerHost.startsWith("unix://")) {
    const socketPath = dockerHost.slice("unix://".length);
    if (!socketPath.startsWith("/") || socketPath.includes("\0"))
      throw new Error("Docker endpoint must be unix:///ABSOLUTE/PATH");
    endpoint = { socketPath };
  } else {
    endpoint = loopbackEndpoint(dockerHost, "Docker endpoint");
  }
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = request(
          { ...endpoint, path: "/_ping", agent: false },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
              if (body.length > 1024)
                res.destroy(new Error("Docker ping response exceeds limit"));
            });
            res.on("error", reject);
            res.on("end", () => {
              if (res.statusCode === 200 && body.trim() === "OK") resolve();
              else
                reject(new Error(`Docker ping failed: HTTP ${res.statusCode}`));
            });
          },
        );
        // A wall-clock timer also bounds a peer that accepts the connection
        // but never finishes its response (an idle socket timeout would not).
        const timer = setTimeout(
          () => req.destroy(new Error("Docker ping timed out")),
          Math.max(1, Math.min(1000, deadline - performance.now())),
        );
        req.on("close", () => clearTimeout(timer));
        req.on("error", reject);
        req.end();
      });
      return;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(retryMs, remaining));
  }
  throw new Error(
    `Docker did not become ready within ${timeoutMs}ms: ${lastError?.message ?? "deadline expired"}`,
  );
}
