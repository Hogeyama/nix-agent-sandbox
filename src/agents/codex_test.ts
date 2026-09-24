import { expect, test } from "bun:test";
import { configureCodex, provisionCodex } from "./codex.ts";

const input = {
  containerHome: "/home/nas",
  hostHome: "/host/home",
  probes: {
    codexDirExists: true,
    codexBinPath: "/host/codex",
    codexCodeModeHostBinPath: null,
    codexSettingsFiles: [] as readonly string[],
  },
  protectSettings: true,
  priorDockerArgs: [] as readonly string[],
  priorEnvVars: {},
};

test("dedicated state mounts ~/.codex read-write and never the host binary", () => {
  const result = configureCodex({
    ...input,
    codexState: { codexDir: "/state:$x/codex" },
  });
  // Structured mounts only — colon-bearing paths cannot ride -v strings.
  expect(result.mounts).toEqual([
    { source: "/state:$x/codex", target: "/home/nas/.codex" },
  ]);
  expect(result.dockerArgs).toEqual([]);
  // "codex" keeps canApplyAgentObservabilityConfig true; the Compose path
  // discards agentCommand anyway — the wrapper supplies the real argv.
  expect(result.agentCommand).toEqual(["codex"]);
});

test("protectSettings overlays config.toml read-only on the dedicated state", () => {
  const result = configureCodex({
    ...input,
    probes: { ...input.probes, codexSettingsFiles: ["config.toml"] },
    codexState: { codexDir: "/state:$x/codex" },
  });
  expect(result.mounts).toEqual([
    { source: "/state:$x/codex", target: "/home/nas/.codex" },
    {
      source: "/state:$x/codex/config.toml",
      target: "/home/nas/.codex/config.toml",
      readOnly: true,
    },
  ]);
});

test("protectSettings = false leaves the codex state fully writable", () => {
  const result = configureCodex({
    ...input,
    probes: { ...input.probes, codexSettingsFiles: ["config.toml"] },
    protectSettings: false,
    codexState: { codexDir: "/state:$x/codex" },
  });
  expect(result.mounts).toEqual([
    { source: "/state:$x/codex", target: "/home/nas/.codex" },
  ]);
});

test("normal Codex CLI retains host mounts and the host binary", () => {
  const result = configureCodex(input);
  expect(result.dockerArgs).toEqual([
    "-v",
    "/host/home/.codex:/home/nas/.codex",
    "-v",
    "/host/codex:/usr/local/bin/codex:ro",
  ]);
  expect(result.agentCommand).toEqual([
    "codex",
    "-c",
    "shell_environment_policy.inherit=all",
  ]);
});

test("provisionCodex: mounts the dummy auth.json after the host ~/.codex", () => {
  const result = provisionCodex({
    ...input,
    codexAuthFile: "/tmp/nas-codex-credentials-x/auth.json",
  });
  expect(result.dockerArgs).toContain("/host/home/.codex:/home/nas/.codex");
  expect(result.mounts).toEqual([
    {
      source: "/tmp/nas-codex-credentials-x/auth.json",
      target: "/home/nas/.codex/auth.json",
    },
  ]);
});

test("provisionCodex: shares the host auth.json when no dummy is given", () => {
  const result = provisionCodex(input);
  expect(result.mounts).toBeUndefined();
});

test("provisionCodex: rejects a dummy auth.json for Dev Container state", () => {
  expect(() =>
    provisionCodex({
      ...input,
      codexState: { codexDir: "/host/home/.codex" },
      codexAuthFile: "/tmp/x/auth.json",
    }),
  ).toThrow("Dummy Codex credentials");
});
