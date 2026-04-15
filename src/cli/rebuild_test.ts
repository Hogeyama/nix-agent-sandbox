import { expect, test } from "bun:test";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
} from "../config/types.ts";
import type { BuildProbes } from "../stages/docker_build.ts";
import type { HostEnv, ProbeResults } from "../pipeline/types.ts";
import { createRebuildPipelineBuilder, createRebuildPrior } from "./rebuild.ts";

test("createRebuildPrior: seeds workspace slice for docker build stage", () => {
  const prior = createRebuildPrior("/repo/worktree", "nas-sandbox");

  expect(prior.workDir).toEqual("/repo/worktree");
  expect(prior.imageName).toEqual("nas-sandbox");
  expect(prior.workspace).toEqual({
    workDir: "/repo/worktree",
    imageName: "nas-sandbox",
  });
});

test("createRebuildPipelineBuilder: runs docker build through workspace-gated state stage", () => {
  const profile: Profile = {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
  };
  const config: Config = {
    ui: { enable: false, port: 7777, idleTimeout: 300 },
    profiles: { dev: profile },
  };
  const host: HostEnv = {
    home: "/home/tester",
    user: "tester",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const probes: ProbeResults = {
    hasHostNix: false,
    xdgDbusProxyPath: null,
    dbusSessionAddress: null,
    gpgAgentSocket: null,
    auditDir: "/audit",
  };
  const initialPrior = createRebuildPrior("/repo/worktree", "nas-sandbox");
  const buildProbes: BuildProbes = {
    imageName: "nas-sandbox",
    imageExists: false,
    currentEmbedHash: "embed-hash",
    imageEmbedHash: null,
  };

  const builder = createRebuildPipelineBuilder({
    input: {
      config,
      profile,
      profileName: "dev",
      sessionId: "sess_test123",
      host,
      probes,
    },
    initialPrior,
    buildProbes,
  });

  expect(builder.getStages()).toHaveLength(1);
  expect(builder.getStages()[0]).toMatchObject({
    name: "DockerBuildStage",
    needs: ["workspace"],
  });
});
