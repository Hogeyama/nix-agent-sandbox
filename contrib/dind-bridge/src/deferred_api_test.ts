import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const { startRelay } = await import(
  new URL("../../../src/docker/embed/dind-bridge-runtime.mjs", import.meta.url)
    .href
);

test("relay startup does not wait; Docker requests share readiness and retry after failure", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let attempts = 0;
  let release: (error: Error) => void = () => {};
  const waiting = new Promise<void>((_resolve, reject) => {
    release = reject;
  });
  const relay = await startRelay({
    socketPath: `/missing-dind-bridge-${process.pid}`,
    api: { host: "127.0.0.1", port: address.port },
    waitForInitialSync: false,
    beforeFirstRequest: () => {
      attempts++;
      if (attempts === 1) return waiting;
      throw new Error("readiness retried");
    },
  });
  const get = () =>
    new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/_ping",
            agent: false,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
  try {
    assert.equal(attempts, 0);
    let completed = false;
    const responses = Promise.all([get(), get()]).then((value) => {
      completed = true;
      return value;
    });
    for (let i = 0; attempts === 0 && i < 100; i++) await delay(10);
    await delay(30);
    assert.equal(attempts, 1);
    assert.equal(completed, false);
    release(new Error("Docker not ready"));
    for (const response of await responses) {
      assert.equal(response.status, 502);
      assert.match(response.body, /Docker not ready/);
    }
    assert.match((await get()).body, /readiness retried/);
    assert.equal(attempts, 2);
  } finally {
    release(new Error("test cleanup"));
    await relay.close();
  }
});
