import { expect, test } from "bun:test";
import {
  renderDevcontainerConfig,
  renderDevcontainerMetadata,
} from "./config.ts";
import { devcontainerProfile, registrationFixture } from "./fixtures.ts";

test("managed config uses argv initialize and explicit user and lifetime contracts, agent-independent", () => {
  const registration = registrationFixture();
  const config = renderDevcontainerConfig(registration, "nas");
  expect(config).toEqual({
    name: "nas",
    initializeCommand: [
      ...registration.command,
      "devcontainer",
      "up",
      "--workspace",
      registration.workspace,
    ],
    dockerComposeFile: [registration.composePath],
    service: "agent",
    workspaceFolder: registration.workspace,
    remoteUser: "nas",
    updateRemoteUserUID: false,
    overrideCommand: false,
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
  });
  // Agent-dependent customizations live in renderDevcontainerMetadata now.
  expect(config).not.toHaveProperty("customizations");
});

test("metadata carries the shared launch contract alongside a single agent's customizations", () => {
  const metadata = renderDevcontainerMetadata(devcontainerProfile(), "nas");
  expect(metadata).toEqual({
    remoteUser: "nas",
    updateRemoteUserUID: false,
    overrideCommand: false,
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
    customizations: {
      vscode: {
        extensions: ["anthropic.claude-code"],
        settings: {
          "claudeCode.claudeProcessWrapper":
            "/usr/local/bin/nas-devcontainer-claude",
        },
      },
    },
  });
});

test("metadata points the Codex extension at the nas wrapper", () => {
  const metadata = renderDevcontainerMetadata(
    { ...devcontainerProfile(), agent: "codex" },
    "nas",
  );
  expect(metadata.customizations).toEqual({
    vscode: {
      extensions: ["openai.chatgpt"],
      settings: {
        "chatgpt.cliExecutable": "/usr/local/bin/nas-devcontainer-codex",
      },
    },
  });
  // The shared contract fields do not change with the agent.
  expect(metadata).toMatchObject({
    remoteUser: "nas",
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
  });
});

test("metadata configures both extensions for a primary Codex with an extra Claude, in fixed order", () => {
  const metadata = renderDevcontainerMetadata(
    { ...devcontainerProfile(), agent: "codex", extraAgents: ["claude"] },
    "nas",
  );
  expect(metadata.customizations).toEqual({
    vscode: {
      extensions: ["anthropic.claude-code", "openai.chatgpt"],
      settings: {
        "claudeCode.claudeProcessWrapper":
          "/usr/local/bin/nas-devcontainer-claude",
        "chatgpt.cliExecutable": "/usr/local/bin/nas-devcontainer-codex",
      },
    },
  });
});

test("metadata is unaffected by extraAgents' declared order or a Copilot-only addition", () => {
  const reordered = renderDevcontainerMetadata(
    { ...devcontainerProfile(), agent: "claude", extraAgents: ["codex"] },
    "nas",
  );
  const copilotOnly = renderDevcontainerMetadata(
    { ...devcontainerProfile(), agent: "claude", extraAgents: ["copilot"] },
    "nas",
  );
  expect(reordered.customizations.vscode.extensions).toEqual([
    "anthropic.claude-code",
    "openai.chatgpt",
  ]);
  expect(copilotOnly.customizations.vscode.extensions).toEqual([
    "anthropic.claude-code",
  ]);
});
