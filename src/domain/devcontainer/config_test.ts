import { expect, test } from "bun:test";
import { renderDevcontainerConfig } from "./config.ts";
import { registrationFixture } from "./fixtures.ts";

test("managed config uses argv initialize and explicit user, lifetime and Claude wrapper contracts", () => {
  const registration = registrationFixture();
  const config = renderDevcontainerConfig(registration, "nas", "claude");
  expect(config).toMatchObject({
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

test("codex config points the Codex extension at the nas wrapper", () => {
  const registration = registrationFixture();
  const config = renderDevcontainerConfig(registration, "nas", "codex");
  expect(config.customizations).toEqual({
    vscode: {
      extensions: ["openai.chatgpt"],
      settings: {
        "chatgpt.cliExecutable": "/usr/local/bin/nas-devcontainer-codex",
      },
    },
  });
  // The shared contract fields do not change with the agent.
  expect(config).toMatchObject({
    service: "agent",
    remoteUser: "nas",
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
  });
});
