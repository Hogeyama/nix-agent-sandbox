import { expect, test } from "bun:test";
import { renderDevcontainerConfig } from "./config.ts";
import { registrationFixture } from "./fixtures.ts";

test("managed config uses argv initialize and explicit user, lifetime and Claude wrapper contracts", () => {
  const registration = registrationFixture();
  const config = renderDevcontainerConfig(registration, "nas");
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
          "remote.autoForwardPorts": false,
        },
      },
    },
  });
});
