import { expect, test } from "bun:test";
import {
  CLAUDE_AGENT_ACP_COMMAND,
  type ClaudeProbes,
  configureClaude,
  NAS_PROXY_CA_CERT_PATH,
} from "./claude.ts";

const installedClaude: ClaudeProbes = {
  claudeDirExists: true,
  claudeJsonExists: true,
  claudeBinPath: "/nix/store/claude/bin/claude",
  claudeSettingsFiles: [],
};

test("configureClaude: ACP reuses Claude mounts and invokes the adapter from PATH", () => {
  const result = configureClaude({
    mode: "acp",
    containerHome: "/home/nas",
    hostHome: "/home/host",
    probes: installedClaude,
    protectSettings: true,
    priorDockerArgs: ["--read-only"],
    priorEnvVars: { HTTPS_PROXY: "http://localhost:18080" },
  });

  expect(result.agentCommand).toEqual([CLAUDE_AGENT_ACP_COMMAND]);
  expect(result.dockerArgs).toEqual([
    "--read-only",
    "-v",
    "/home/host/.claude:/home/nas/.claude",
    "-v",
    "/home/host/.claude.json:/home/nas/.claude.json",
    "-v",
    "/nix/store/claude/bin/claude:/home/nas/.local/bin/claude:ro",
  ]);
  expect(result.envVars.CLAUDE_CODE_EXECUTABLE).toEqual(
    "/home/nas/.local/bin/claude",
  );
  expect(result.envVars.NODE_EXTRA_CA_CERTS).toEqual(NAS_PROXY_CA_CERT_PATH);
  expect(result.envVars.HTTPS_PROXY).toEqual("http://localhost:18080");
});

test("configureClaude: ACP requires a native host Claude installation", () => {
  expect(() =>
    configureClaude({
      mode: "acp",
      containerHome: "/home/nas",
      hostHome: "/home/host",
      probes: { ...installedClaude, claudeBinPath: null },
      protectSettings: true,
      priorDockerArgs: [],
      priorEnvVars: {},
    }),
  ).toThrow("requires Claude Code installed on the host");
});

test("configureClaude: absent mode preserves terminal behavior", () => {
  const result = configureClaude({
    containerHome: "/home/nas",
    hostHome: "/home/host",
    probes: installedClaude,
    protectSettings: true,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.agentCommand).toEqual(["claude"]);
  expect(result.envVars.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
});

const input = {
  containerHome: "/home/nas",
  hostHome: "/host/home",
  probes: {
    claudeDirExists: true,
    claudeJsonExists: true,
    claudeBinPath: "/host/claude",
    claudeSettingsFiles: [],
  },
  protectSettings: true,
  priorDockerArgs: [],
  priorEnvVars: {},
};
test("dedicated state preserves structured paths and excludes host authentication and executable", () => {
  const result = configureClaude({
    ...input,
    claudeState: {
      claudeDir: "/state:$x/claude",
      claudeJson: "/state:$x/claude.json",
    },
  });
  expect(result.mounts).toEqual([
    { source: "/state:$x/claude", target: "/home/nas/.claude" },
    { source: "/state:$x/claude.json", target: "/home/nas/.claude.json" },
  ]);
  expect(result.dockerArgs).toEqual([]);
  expect(result.agentCommand).toEqual(["claude"]);
});
test("normal Claude CLI retains host mounts and executable", () => {
  const result = configureClaude(input);
  expect(result.dockerArgs).toEqual([
    "-v",
    "/host/home/.claude:/home/nas/.claude",
    "-v",
    "/host/home/.claude.json:/home/nas/.claude.json",
    "-v",
    "/host/claude:/home/nas/.local/bin/claude:ro",
  ]);
  expect(result.agentCommand).toEqual(["claude"]);
});

// `~/.claude` stays writable for credentials and session history, so the
// settings files that hooks would run from are re-mounted read-only on top of
// it. Without this an agent can plant a `PreToolUse` hook that runs on the
// host the next time the user starts Claude there.
const withSettings = {
  ...input,
  probes: {
    ...input.probes,
    claudeSettingsFiles: ["settings.json", "settings.local.json"],
  },
};

test("protectSettings re-mounts the host settings files read-only", () => {
  const result = configureClaude(withSettings);
  expect(result.dockerArgs).toEqual([
    "-v",
    "/host/home/.claude:/home/nas/.claude",
    "-v",
    "/host/home/.claude/settings.json:/home/nas/.claude/settings.json:ro",
    "-v",
    "/host/home/.claude/settings.local.json:/home/nas/.claude/settings.local.json:ro",
    "-v",
    "/host/home/.claude.json:/home/nas/.claude.json",
    "-v",
    "/host/claude:/home/nas/.local/bin/claude:ro",
  ]);
});

test("protectSettings = false leaves the settings files writable", () => {
  const result = configureClaude({ ...withSettings, protectSettings: false });
  expect(result.dockerArgs.filter((arg) => arg.endsWith(":ro"))).toEqual([
    "/host/claude:/home/nas/.local/bin/claude:ro",
  ]);
});

test("protectSettings covers the dedicated state directory too", () => {
  const result = configureClaude({
    ...withSettings,
    claudeState: {
      claudeDir: "/state:$x/claude",
      claudeJson: "/state:$x/claude.json",
    },
  });
  expect(result.mounts).toEqual([
    { source: "/state:$x/claude", target: "/home/nas/.claude" },
    {
      source: "/state:$x/claude/settings.json",
      target: "/home/nas/.claude/settings.json",
      readOnly: true,
    },
    {
      source: "/state:$x/claude/settings.local.json",
      target: "/home/nas/.claude/settings.local.json",
      readOnly: true,
    },
    { source: "/state:$x/claude.json", target: "/home/nas/.claude.json" },
  ]);
});

// The ACP adapter reuses the terminal mounts, so it must inherit the overlay.
test("protectSettings applies in ACP mode", () => {
  const result = configureClaude({ ...withSettings, mode: "acp" });
  expect(result.dockerArgs).toContain(
    "/host/home/.claude/settings.json:/home/nas/.claude/settings.json:ro",
  );
});
