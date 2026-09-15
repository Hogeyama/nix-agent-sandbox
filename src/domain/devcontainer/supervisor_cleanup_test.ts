import { expect, test } from "bun:test";
import type { runDockerCommand } from "../../docker/client.ts";
import { cleanupOwnedDevcontainer } from "./supervisor.ts";
import type {
  DevcontainerRegistration,
  DevcontainerSessionRecord,
} from "./types.ts";

const registration = {} as DevcontainerRegistration;
const session = {
  containerId: "missing-container",
} as DevcontainerSessionRecord;

for (const diagnostic of [
  "error: no such object: missing-container",
  "Error: No such object: missing-container",
  "Error response from daemon: No such container: missing-container",
]) {
  test(`cleanup accepts an already removed container: ${diagnostic}`, async () => {
    const calls: string[][] = [];
    const run: typeof runDockerCommand = async (args) => {
      calls.push([...args]);
      throw new Error(
        `docker inspect exited with code 1\n\nstderr:\n${diagnostic}`,
      );
    };
    await cleanupOwnedDevcontainer(registration, session, run);
    expect(calls).toEqual([["inspect", "missing-container"]]);
  });
}

test("cleanup preserves Docker daemon failures", async () => {
  const run: typeof runDockerCommand = async () => {
    throw new Error("Cannot connect to the Docker daemon");
  };
  await expect(
    cleanupOwnedDevcontainer(registration, session, run),
  ).rejects.toThrow("Cannot connect to the Docker daemon");
});
