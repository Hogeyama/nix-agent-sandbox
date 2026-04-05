import { assertEquals } from "@std/assert";
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
import {
  type BuildProbes,
  createDockerBuildStage,
  EMBED_HASH_LABEL,
} from "./docker_build.ts";

Deno.test("DockerBuildStage: returns docker-image-build effect when image does not exist", () => {
  const buildProbes: BuildProbes = {
    imageExists: false,
    currentEmbedHash: "abc123",
    imageEmbedHash: null,
  };
  const stage = createDockerBuildStage(buildProbes);
  const input = createTestInput();

  const plan = stage.plan(input);
  assertEquals(plan !== null, true);
  assertEquals(plan!.effects.length, 1);
  assertEquals(plan!.effects[0].kind, "docker-image-build");
  const effect = plan!.effects[0] as {
    kind: string;
    imageName: string;
    labels: Record<string, string>;
  };
  assertEquals(effect.imageName, "nas-sandbox");
  assertEquals(effect.labels[EMBED_HASH_LABEL], "abc123");
});

Deno.test("DockerBuildStage: returns empty effects when image exists and hash matches", () => {
  const buildProbes: BuildProbes = {
    imageExists: true,
    currentEmbedHash: "abc123",
    imageEmbedHash: "abc123",
  };
  const stage = createDockerBuildStage(buildProbes);
  const input = createTestInput();

  const plan = stage.plan(input);
  assertEquals(plan !== null, true);
  assertEquals(plan!.effects.length, 0);
});

Deno.test("DockerBuildStage: warns when cached image embed hash is outdated", () => {
  const buildProbes: BuildProbes = {
    imageExists: true,
    currentEmbedHash: "new-hash",
    imageEmbedHash: "stale-hash",
  };
  const stage = createDockerBuildStage(buildProbes);
  const input = createTestInput();

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const plan = stage.plan(input);
    assertEquals(plan !== null, true);
    assertEquals(plan!.effects.length, 0);
    assertEquals(
      logs.some((line) => line.includes("Docker image is outdated")),
      true,
    );
  } finally {
    console.log = originalLog;
  }
});

function createTestInput(
  priorOverrides: Partial<PriorStageOutputs> = {},
): StageInput {
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
