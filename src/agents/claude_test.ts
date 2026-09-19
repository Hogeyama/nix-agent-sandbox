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
    protectSettings: false,
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
      protectSettings: false,
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
    protectSettings: false,
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
  protectSettings: false,
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

test("protectSettings fails closed when the protected state was not prepared", () => {
  expect(() => configureClaude({ ...input, protectSettings: true })).toThrow(
    "Protected Claude state must be prepared",
  );
});

const protectedState = {
  runtimeDir: "/private/claude-state",
  claudeJson: "/host/home/.claude.json",
  entries: [
    { source: "/host/home/.claude/plugins", name: "plugins", readOnly: true },
    {
      source: "/host/home/.claude/.credentials.json",
      name: ".credentials.json",
      readOnly: false,
    },
    {
      source: "/host/home/.claude/projects",
      name: "projects",
      readOnly: false,
    },
  ],
};

for (const mode of ["terminal", "acp"] as const) {
  test(`protected ${mode} mounts a private root and never mounts the host state directory`, () => {
    const result = configureClaude({
      ...input,
      protectSettings: true,
      mode,
      protectedClaudeState: protectedState,
    });
    expect(result.mounts).toContainEqual({
      source: protectedState.runtimeDir,
      target: "/home/nas/.claude",
    });
    expect(result.mounts).toContainEqual({
      source: "/host/home/.claude/plugins",
      target: "/home/nas/.claude/plugins",
      readOnly: true,
    });
    expect(result.mounts).toContainEqual({
      source: "/host/home/.claude/.credentials.json",
      target: "/home/nas/.claude/.credentials.json",
      readOnly: false,
    });
    expect(
      result.mounts?.some((mount) => mount.source === "/host/home/.claude"),
    ).toBe(false);
    expect(result.dockerArgs).not.toContain(
      "/host/home/.claude:/home/nas/.claude",
    );
    expect(result.dockerArgs).toContain(
      "/host/claude:/home/nas/.local/bin/claude:ro",
    );
  });
}

test("protected Dev Container uses the same layout without a native binary mount", () => {
  const result = configureClaude({
    ...input,
    protectSettings: true,
    claudeState: {
      claudeDir: "/host/home/.claude",
      claudeJson: "/host/home/.claude.json",
    },
    protectedClaudeState: protectedState,
  });
  expect(result.mounts).toEqual(
    configureClaude({
      ...input,
      protectSettings: true,
      protectedClaudeState: protectedState,
    }).mounts,
  );
  expect(result.dockerArgs).toEqual([]);
});
