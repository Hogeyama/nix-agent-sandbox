import { expect, test } from "bun:test";
import { buildDockerRunArgs } from "./client.ts";

test("ACP forces Docker -i even when the host has a TTY", () => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    const opts = {
      image: "sandbox",
      args: [],
      envVars: {},
      command: ["adapter"],
      interactive: true,
    };
    expect(buildDockerRunArgs({ ...opts, mode: "acp" })).toEqual([
      "docker",
      "run",
      "--rm",
      "-i",
      "sandbox",
      "adapter",
    ]);
    expect(buildDockerRunArgs(opts)).toContain("-it");
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
});
