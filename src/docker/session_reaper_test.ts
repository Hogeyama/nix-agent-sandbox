import { expect, test } from "bun:test";
import { sessionDockerResources } from "./nas_resources.ts";
import { reapSessionDockerResources } from "./session_reaper.ts";

test("sessionDockerResources: names every resource a session creates", () => {
  expect(sessionDockerResources("sess_abc123")).toEqual({
    agentContainer: "nas-agent-sess_abc123",
    dindContainer: "nas-dind-sess_abc123",
    registryMirrorContainer: "nas-registry-mirror-sess-abc123",
    dindDataVolume: "nas-dind-data-sess_abc123",
    dindTmpVolume: "nas-dind-tmp-sess_abc123",
    sessionNetwork: "nas-session-net-sess_abc123",
  });
});

test("reapSessionDockerResources: removes joiners before the network and keeps the shared proxy", async () => {
  const calls: string[] = [];
  const steps = await reapSessionDockerResources(
    sessionDockerResources("sess_abc123"),
    {
      stop: async (name) => void calls.push(`stop ${name}`),
      rm: async (name) => void calls.push(`rm ${name}`),
      networkDisconnect: async (network, container) =>
        void calls.push(`disconnect ${network} ${container}`),
      networkRemove: async (network) => void calls.push(`rm-net ${network}`),
      volumeRemove: async (volume) => void calls.push(`rm-vol ${volume}`),
    },
  );

  expect(calls).toEqual([
    "stop nas-agent-sess_abc123",
    "rm nas-agent-sess_abc123",
    "stop nas-dind-sess_abc123",
    "rm nas-dind-sess_abc123",
    "stop nas-registry-mirror-sess-abc123",
    "rm nas-registry-mirror-sess-abc123",
    "disconnect nas-session-net-sess_abc123 nas-proxy-shared",
    "rm-net nas-session-net-sess_abc123",
    "rm-vol nas-dind-data-sess_abc123",
    "rm-vol nas-dind-tmp-sess_abc123",
  ]);
  expect(steps.every((step) => step.error === undefined)).toBe(true);
});

test("reapSessionDockerResources: a missing resource does not stop later removals", async () => {
  const removedVolumes: string[] = [];
  const missing = async () => {
    throw new Error("No such container");
  };
  const steps = await reapSessionDockerResources(
    sessionDockerResources("sess_abc123"),
    {
      stop: missing,
      rm: missing,
      networkDisconnect: missing,
      networkRemove: async () => {},
      volumeRemove: async (volume) => void removedVolumes.push(volume),
    },
  );

  expect(removedVolumes).toEqual([
    "nas-dind-data-sess_abc123",
    "nas-dind-tmp-sess_abc123",
  ]);
  expect(steps.filter((step) => step.error).length).toBe(7);
});
