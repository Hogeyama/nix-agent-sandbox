import { expect, spyOn, test } from "bun:test";
import type {
  DevcontainerRegistration,
  DevcontainerStatus,
} from "../domain/devcontainer.ts";
import {
  type DevcontainerCommandClient,
  runDevcontainerCommand,
} from "./devcontainer.ts";

const registration: DevcontainerRegistration = {
  version: 1,
  workspaceId: "workspace-id",
  workspace: "/work",
  profileName: "claude",
  configPath: "/work/.devcontainer/devcontainer.json",
  composePath: "/state/compose.json",
  stateRoot: "/state/workspace",
  command: ["nas"],
};
const ready: DevcontainerStatus = {
  workspaceId: "workspace-id",
  profileName: "claude",
  phase: "ready",
  sessionId: "dc_1",
  containerId: "container-1",
  diagnostic: null,
};

function client(calls: string[]): DevcontainerCommandClient {
  return {
    init: async (workspace, profile) => {
      calls.push(`init:${workspace}:${profile}`);
      return registration;
    },
    up: async (workspace) => {
      calls.push(`up:${workspace}`);
      return ready;
    },
    down: async (workspace) => {
      calls.push(`down:${workspace}`);
      return { ...ready, phase: "stopped", containerId: null };
    },
    status: async (workspace) => {
      calls.push(`status:${workspace}`);
      return ready;
    },
  };
}

test("CLI delegates init and renders the generated entry", async () => {
  const calls: string[] = [];
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runDevcontainerCommand(
      ["init", "--profile", "claude"],
      "/work",
      client(calls),
    );
    expect(calls).toEqual(["init:/work:claude"]);
    expect(log.mock.calls.flat().join("\n")).toContain(registration.configPath);
  } finally {
    log.mockRestore();
  }
});

test("CLI renders status JSON without private supervisor fields", async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((value) =>
    lines.push(String(value)),
  );
  try {
    await runDevcontainerCommand(["status", "--json"], "/work", client(calls));
    expect(calls).toEqual(["status:/work"]);
    expect(JSON.parse(lines.join("\n"))).toEqual(ready);
    expect(lines.join("\n")).not.toContain("controlSocket");
  } finally {
    log.mockRestore();
  }
});
