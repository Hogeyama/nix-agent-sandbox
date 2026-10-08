import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const { waitForDocker } = await import(
  join(import.meta.dirname, "docker_ready.mjs")
);
const { closeServer, listen } = await import(
  join(
    import.meta.dirname,
    "../../../src/docker/embed/dind-bridge-protocol.mjs",
  )
);

for (const transport of ["unix", "tcp"]) {
  test(`readiness waits for a late ${transport} listener and a successful Docker ping`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dind-ready-"));
    const socket = join(directory, "docker.sock");
    let healthy = false;
    let resolved = false;
    let requests = 0;
    const server = createServer((req, res) => {
      assert.equal(req.url, "/_ping");
      requests++;
      res.writeHead(healthy ? 200 : 503);
      res.end(healthy ? "OK" : "starting");
    });
    let endpoint: string | { host: string; port: number } = socket;
    let dockerHost = `unix://${socket}`;
    if (transport === "tcp") {
      const reservation = createServer();
      await listen(reservation, { host: "127.0.0.1", port: 0 });
      const address = reservation.address();
      if (!address || typeof address === "string")
        throw new Error("no TCP port");
      endpoint = { host: "127.0.0.1", port: address.port };
      dockerHost = `tcp://127.0.0.1:${address.port}`;
      await closeServer(reservation);
    }
    const waiting = waitForDocker(dockerHost, {
      timeoutMs: 2000,
      retryMs: 10,
    }).then(() => {
      resolved = true;
    });
    try {
      await delay(30);
      assert.equal(resolved, false);
      await listen(server, endpoint);
      for (let i = 0; requests === 0 && i < 100; i++) await delay(10);
      assert.ok(requests > 0);
      assert.equal(resolved, false);
      healthy = true;
      await waiting;
      assert.equal(resolved, true);
    } finally {
      healthy = true;
      await waiting.catch(() => {});
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("readiness rejects a missing Docker socket within its deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dind-ready-"));
  try {
    await assert.rejects(
      waitForDocker(`unix://${join(directory, "missing.sock")}`, {
        timeoutMs: 50,
        retryMs: 10,
      }),
      /Docker did not become ready within 50ms/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness bounds an unfinished HTTP response, even while data arrives", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write("O");
    const timer = setInterval(() => res.write(" "), 10);
    res.on("close", () => clearInterval(timer));
  });
  await listen(server, { host: "127.0.0.1", port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  try {
    await assert.rejects(
      waitForDocker(`tcp://127.0.0.1:${address.port}`, {
        timeoutMs: 100,
        retryMs: 10,
      }),
      /Docker did not become ready within 100ms/,
    );
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

test("readiness does not accept an arbitrary HTTP 200 response", async () => {
  const server = createServer((_req, res) => res.end("not Docker"));
  await listen(server, { host: "127.0.0.1", port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  try {
    await assert.rejects(
      waitForDocker(`tcp://127.0.0.1:${address.port}`, {
        timeoutMs: 50,
        retryMs: 10,
      }),
      /Docker did not become ready/,
    );
  } finally {
    await closeServer(server);
  }
});
