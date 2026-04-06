import { expect, test } from "bun:test";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  StageInput,
} from "../pipeline/types.ts";
import { createLaunchStage } from "./launch.ts";

test("LaunchStage: produces docker-run-interactive effect with composed command", () => {
  const stage = createLaunchStage(["--user-arg"]);
  const input = createTestInput({
    imageName: "custom-image",
    agentCommand: ["agent-bin", "serve"],
    dockerArgs: ["--network", "sandbox-net", "-v", "/tmp:/workspace"],
    envVars: { TOKEN: "secret", MODE: "test" },
  });
  input.profile.agentArgs = ["--profile-arg"];

  const plan = stage.plan(input);
  expect(plan !== null).toEqual(true);
  expect(plan!.effects.length).toEqual(1);
  expect(plan!.effects[0].kind).toEqual("docker-run-interactive");

  const effect = plan!.effects[0] as {
    kind: string;
    image: string;
    args: string[];
    envVars: Record<string, string>;
    command: string[];
    name: string;
  };
  expect(effect.image).toEqual("custom-image");
  expect(effect.args).toEqual([
    "--network",
    "sandbox-net",
    "-v",
    "/tmp:/workspace",
  ]);
  expect(effect.envVars).toEqual({ TOKEN: "secret", MODE: "test" });
  expect(effect.command).toEqual([
    "agent-bin",
    "serve",
    "--profile-arg",
    "--user-arg",
  ]);
  expect(effect.name.startsWith("nas-agent-")).toEqual(true);
});

function createTestInput(
  priorOverrides: Partial<PriorStageOutputs> = {},
): StageInput & { profile: Profile } {
  const profile: Profile = {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
  };
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const host: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: {},
    workDir: "/workspace",
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...priorOverrides,
  };
  return {
    config,
    profile,
    profileName: "test",
    sessionId: "sess_test123",
    host,
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/audit",
    },
    prior,
  };
}
