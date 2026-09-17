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

test("fingerprint covers source identity, selected profile, implementation, assets, IDs and exact bytes", async () => {
  const { computeDevcontainerFingerprint } = await import("./config.ts");
  const { devcontainerProfile } = await import("./fixtures.ts");
  const host = {
    home: "/home/a",
    user: "a",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map<string, string>(),
  };
  const inputs = {
    profile: devcontainerProfile(),
    profileName: "claude",
    trustHash: "trusted",
    configDir: "/workspace/.nas",
    implementation: "nas-v1",
    embedHash: "assets-v1",
    command: ["/bin/nas"],
  };
  const base = computeDevcontainerFingerprint("bytes", inputs, host);
  for (const change of [
    { configDir: "/parent/.nas" },
    { profileName: "other" },
    { trustHash: "changed" },
    { implementation: "nas-v2" },
    { embedHash: "assets-v2" },
    { command: ["/other/nas"] },
  ])
    expect(
      computeDevcontainerFingerprint("bytes", { ...inputs, ...change }, host),
    ).not.toBe(base);
  expect(computeDevcontainerFingerprint("bytes\n", inputs, host)).not.toBe(
    base,
  );
  expect(
    computeDevcontainerFingerprint("bytes", inputs, { ...host, gid: 1001 }),
  ).not.toBe(base);
  expect(
    computeDevcontainerFingerprint("bytes", inputs, { ...host, uid: 1001 }),
  ).not.toBe(base);
});
