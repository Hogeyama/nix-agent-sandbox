import { expect, test } from "bun:test";
import {
  CLAUDE_AGENT_ACP_PATH,
  type ClaudeProbes,
  configureClaude,
  NAS_PROXY_CA_CERT_PATH,
  NODE_EXECUTABLE_PATH,
} from "./claude.ts";

const installedClaude: ClaudeProbes = {
  claudeDirExists: true,
  claudeJsonExists: true,
  claudeBinPath: "/nix/store/claude/bin/claude",
};

test("configureClaude: ACP reuses Claude mounts and invokes pinned image adapter", () => {
  const result = configureClaude({
    mode: "acp",
    containerHome: "/home/nas",
    hostHome: "/home/host",
    probes: installedClaude,
    priorDockerArgs: ["--read-only"],
    priorEnvVars: { HTTPS_PROXY: "http://localhost:18080" },
  });

  expect(result.agentCommand).toEqual([
    NODE_EXECUTABLE_PATH,
    CLAUDE_AGENT_ACP_PATH,
  ]);
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
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.agentCommand).toEqual(["claude"]);
  expect(result.envVars.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
});
