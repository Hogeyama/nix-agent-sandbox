import { expect, test } from "bun:test";
import { containerRemovalWarning } from "./removal_outcome.ts";

test("ACP removal accepts success and the exact already-removed container", () => {
  expect(
    containerRemovalWarning("session", { exitCode: 0, stderr: "" }),
  ).toBeUndefined();
  expect(
    containerRemovalWarning("session", {
      exitCode: 1,
      stderr: "Error response from daemon: No such container: session\n",
    }),
  ).toBeUndefined();
  expect(
    containerRemovalWarning("session", {
      exitCode: 1,
      stderr: "Error: No such container: session\n",
    }),
  ).toBeUndefined();
});

test("ACP removal reports daemon, unexpected-container and mixed failures", () => {
  for (const stderr of [
    "Cannot connect to the Docker daemon",
    "Error response from daemon: No such container: different-session",
    "Error: No such container: session\nCannot connect to the Docker daemon",
    "",
  ]) {
    expect(
      containerRemovalWarning("session", { exitCode: 1, stderr }),
    ).toContain("may still be running");
  }
  expect(
    containerRemovalWarning("session", { error: new Error("spawn failed") }),
  ).toContain("spawn failed");
});
