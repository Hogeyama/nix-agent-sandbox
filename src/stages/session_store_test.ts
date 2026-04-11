import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
import { readSession, resolveSessionRuntimePaths } from "../sessions/store.ts";
import {
  IN_CONTAINER_SESSION_STORE_DIR,
  SessionStoreStage,
} from "./session_store.ts";

let tmpRoot: string;
const savedEnv = process.env.NAS_SESSION_STORE_DIR;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-session-store-stage-"));
  // Point the store at a temp dir for the duration of each test.
  process.env.NAS_SESSION_STORE_DIR = path.join(tmpRoot, "sessions");
});

afterEach(async () => {
  try {
    await rm(tmpRoot, { recursive: true, force: true });
  } finally {
    if (savedEnv === undefined) {
      delete process.env.NAS_SESSION_STORE_DIR;
    } else {
      process.env.NAS_SESSION_STORE_DIR = savedEnv;
    }
  }
});

test("SessionStoreStage.execute writes a SessionRecord to the store dir", async () => {
  const stage = new SessionStoreStage();
  const input = createTestInput({ sessionId: "sess_abc123" });

  await stage.execute(input);

  const paths = await resolveSessionRuntimePaths(undefined);
  const record = await readSession(paths, "sess_abc123");
  expect(record).not.toBeNull();
  expect(record!.sessionId).toBe("sess_abc123");
  expect(record!.agent).toBe("claude");
  expect(record!.profile).toBe("test-profile");
  expect(record!.worktree).toBe("/workspace");
  expect(record!.turn).toBe("user-turn");
  expect(typeof record!.startedAt).toBe("string");
});

test("SessionStoreStage.execute outputs bind-mount dockerArgs and store env var", async () => {
  const stage = new SessionStoreStage();
  const input = createTestInput({ sessionId: "sess_xyz" });

  const result = await stage.execute(input);

  const paths = await resolveSessionRuntimePaths(undefined);
  expect(result.outputOverrides.dockerArgs).toEqual([
    "-v",
    `${paths.sessionsDir}:${IN_CONTAINER_SESSION_STORE_DIR}`,
  ]);
  expect(result.outputOverrides.envVars).toEqual({
    NAS_SESSION_STORE_DIR: IN_CONTAINER_SESSION_STORE_DIR,
  });
  // Must NOT set NAS_SESSION_ID — cli.ts owns that.
  expect(result.outputOverrides.envVars?.NAS_SESSION_ID).toBeUndefined();
});

test("SessionStoreStage.teardown removes the record", async () => {
  const stage = new SessionStoreStage();
  const input = createTestInput({ sessionId: "sess_to_delete" });

  await stage.execute(input);
  const paths = await resolveSessionRuntimePaths(undefined);
  expect(await readSession(paths, "sess_to_delete")).not.toBeNull();

  await stage.teardown(input);
  expect(await readSession(paths, "sess_to_delete")).toBeNull();
});

test("SessionStoreStage.teardown on an already-missing record does not throw", async () => {
  const stage = new SessionStoreStage();
  const input = createTestInput({ sessionId: "sess_gone" });

  await stage.execute(input);
  const paths = await resolveSessionRuntimePaths(undefined);

  // Delete the file out-of-band, simulating something else cleaning up.
  const { deleteSession } = await import("../sessions/store.ts");
  await deleteSession(paths, "sess_gone");

  // Must complete without throwing.
  await stage.teardown(input);
  expect(await readSession(paths, "sess_gone")).toBeNull();
});

// ---------------------------------------------------------------------------

function createTestInput(opts: { sessionId: string }): StageInput {
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
    default: "test-profile",
    profiles: { "test-profile": profile },
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
  };
  return {
    config,
    profile,
    profileName: "test-profile",
    sessionId: opts.sessionId,
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
