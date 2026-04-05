import { assertEquals, assertRejects } from "@std/assert";
import { createProxySessionNetworkHandle } from "./proxy.ts";

Deno.test("createProxySessionNetworkHandle: tears down created network when envoy connect fails", async () => {
  const calls: string[] = [];

  await assertRejects(
    () =>
      createProxySessionNetworkHandle(
        {
          sessionNetworkName: "net-a",
          envoyContainerName: "envoy-a",
          envoyAlias: "nas-envoy",
        },
        {
          createSessionNetwork: (networkName) => {
            calls.push(`create:${networkName}`);
            return Promise.resolve();
          },
          connectNetwork: (_networkName, containerName) => {
            calls.push(`connect:${containerName}`);
            if (containerName === "envoy-a") {
              return Promise.reject(new Error("envoy connect boom"));
            }
            return Promise.resolve();
          },
          disconnectNetwork: (networkName, containerName) => {
            calls.push(`disconnect:${networkName}:${containerName}`);
            return Promise.resolve();
          },
          removeNetwork: (networkName) => {
            calls.push(`remove:${networkName}`);
            return Promise.resolve();
          },
        },
      ),
    Error,
    "failed to connect envoy",
  );

  assertEquals(calls, [
    "create:net-a",
    "connect:envoy-a",
    "remove:net-a",
  ]);
});

Deno.test("createProxySessionNetworkHandle: disconnects envoy and removes network when dind connect fails", async () => {
  const calls: string[] = [];

  await assertRejects(
    () =>
      createProxySessionNetworkHandle(
        {
          sessionNetworkName: "net-b",
          envoyContainerName: "envoy-b",
          envoyAlias: "nas-envoy",
          dindContainerName: "dind-b",
        },
        {
          createSessionNetwork: (networkName) => {
            calls.push(`create:${networkName}`);
            return Promise.resolve();
          },
          connectNetwork: (_networkName, containerName) => {
            calls.push(`connect:${containerName}`);
            if (containerName === "dind-b") {
              return Promise.reject(new Error("dind connect boom"));
            }
            return Promise.resolve();
          },
          disconnectNetwork: (networkName, containerName) => {
            calls.push(`disconnect:${networkName}:${containerName}`);
            return Promise.resolve();
          },
          removeNetwork: (networkName) => {
            calls.push(`remove:${networkName}`);
            return Promise.resolve();
          },
        },
      ),
    Error,
    "failed to connect dind",
  );

  assertEquals(calls, [
    "create:net-b",
    "connect:envoy-b",
    "connect:dind-b",
    "disconnect:net-b:envoy-b",
    "remove:net-b",
  ]);
});

Deno.test("createProxySessionNetworkHandle: closes successful network attachments in reverse dependency order", async () => {
  const calls: string[] = [];

  const handle = await createProxySessionNetworkHandle(
    {
      sessionNetworkName: "net-c",
      envoyContainerName: "envoy-c",
      envoyAlias: "nas-envoy",
      dindContainerName: "dind-c",
    },
    {
      createSessionNetwork: (networkName) => {
        calls.push(`create:${networkName}`);
        return Promise.resolve();
      },
      connectNetwork: (_networkName, containerName) => {
        calls.push(`connect:${containerName}`);
        return Promise.resolve();
      },
      disconnectNetwork: (networkName, containerName) => {
        calls.push(`disconnect:${networkName}:${containerName}`);
        return Promise.resolve();
      },
      removeNetwork: (networkName) => {
        calls.push(`remove:${networkName}`);
        return Promise.resolve();
      },
    },
  );

  await handle.close();

  assertEquals(calls, [
    "create:net-c",
    "connect:envoy-c",
    "connect:dind-c",
    "disconnect:net-c:dind-c",
    "disconnect:net-c:envoy-c",
    "remove:net-c",
  ]);
});
