import { expect, test } from "bun:test";
import { runProxyContainer } from "./proxy_container_fixture.ts";

const options = { name: "test-proxy", image: "unused", args: [], envVars: {} };
const collision = new Error(
  "error while calling RootlessKit PortManager.AddPort(): listen tcp4 127.0.0.1:32820: bind: address already in use",
);

test("removes a container whose published port collided before recreating it", async () => {
  const events: string[] = [];
  await runProxyContainer(options, {
    async run(received) {
      expect(received.publishedPorts).toEqual(["127.0.0.1::8080"]);
      events.push("run");
      if (events.length === 1) throw collision;
    },
    async remove(name) {
      events.push(`remove ${name}`);
    },
  });
  expect(events).toEqual(["run", "remove test-proxy", "run"]);
});

test("does not retry unrelated Docker failures", async () => {
  const failure = new Error("permission denied");
  const events: string[] = [];
  await expect(
    runProxyContainer(options, {
      async run() {
        events.push("run");
        throw failure;
      },
      async remove() {
        events.push("remove");
      },
    }),
  ).rejects.toBe(failure);
  expect(events).toEqual(["run"]);
});

test("bounds port collision retries and propagates cleanup failures", async () => {
  const events: string[] = [];
  const docker = {
    async run() {
      events.push("run");
      throw collision;
    },
    async remove() {
      events.push("remove");
    },
  };
  await expect(runProxyContainer(options, docker)).rejects.toBe(collision);
  expect(events).toEqual(["run", "remove", "run", "remove", "run"]);

  events.length = 0;
  const failure = new Error("could not remove failed container");
  docker.remove = async () => {
    events.push("remove");
    throw failure;
  };
  await expect(runProxyContainer(options, docker)).rejects.toBe(failure);
  expect(events).toEqual(["run", "remove"]);
});
