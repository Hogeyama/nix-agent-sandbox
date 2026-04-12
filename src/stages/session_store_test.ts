import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Exit, type Layer, Scope } from "effect";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import type {
  EffectStageResult,
  HostEnv,
  PriorStageOutputs,
  StageInput,
} from "../pipeline/types.ts";
import {
  type CreateSessionInput,
  makeSessionStoreServiceFake,
  SessionStoreServiceLive,
} from "../services/session_store_service.ts";
import type { SessionRuntimePaths } from "../sessions/store.ts";
import { readSession, resolveSessionRuntimePaths } from "../sessions/store.ts";
import {
  createSessionStoreStage,
  IN_CONTAINER_NAS_BIN_PATH,
  IN_CONTAINER_SESSION_STORE_DIR,
} from "./session_store.ts";

let tmpRoot: string;
const savedEnv = process.env.NAS_SESSION_STORE_DIR;
const savedNasBinPath = process.env.NAS_BIN_PATH;
const savedPath = process.env.PATH;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-session-store-stage-"));
  // Point the store at a temp dir for the duration of each test.
  process.env.NAS_SESSION_STORE_DIR = path.join(tmpRoot, "sessions");
  // Pin nas-binary detection: by default, no binary available so tests are
  // deterministic regardless of whether the dev has a `nas` on PATH. Tests
  // that exercise the mount opt in explicitly.
  delete process.env.NAS_BIN_PATH;
  process.env.PATH = tmpRoot; // isolated, no `nas` binary inside
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
    if (savedNasBinPath === undefined) {
      delete process.env.NAS_BIN_PATH;
    } else {
      process.env.NAS_BIN_PATH = savedNasBinPath;
    }
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
  }
});

/** Run the EffectStage, returning the result and a close handle for the scope. */
async function runStage(
  input: StageInput,
  layer: Layer.Layer<
    import("../services/session_store_service.ts").SessionStoreService
  > = SessionStoreServiceLive,
): Promise<{ result: EffectStageResult; closeScope: Effect.Effect<void> }> {
  const stage = createSessionStoreStage();
  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(input)
      .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(layer)),
  );
  return { result, closeScope: Scope.close(scope, Exit.void) };
}

test("SessionStoreStage run writes a SessionRecord to the store dir", async () => {
  const input = createTestInput({ sessionId: "sess_abc123" });

  await runStage(input);

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

test("SessionStoreStage run outputs bind-mount dockerArgs and store env var", async () => {
  const input = createTestInput({ sessionId: "sess_xyz" });

  const { result } = await runStage(input);

  const paths = await resolveSessionRuntimePaths(undefined);
  expect(result.dockerArgs).toEqual([
    "-v",
    `${paths.sessionsDir}:${IN_CONTAINER_SESSION_STORE_DIR}`,
  ]);
  expect(result.envVars).toEqual({
    NAS_SESSION_STORE_DIR: IN_CONTAINER_SESSION_STORE_DIR,
  });
  // Must NOT set NAS_SESSION_ID — cli.ts owns that.
  expect(result.envVars?.NAS_SESSION_ID).toBeUndefined();
});

test("SessionStoreStage run appends the nas binary mount when NAS_BIN_PATH is set", async () => {
  const fakeNas = path.join(tmpRoot, "nas");
  await writeFile(fakeNas, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.NAS_BIN_PATH = fakeNas;

  const { result } = await runStage(createTestInput({ sessionId: "sess_n1" }));

  expect(result.dockerArgs).toContain(
    `${fakeNas}:${IN_CONTAINER_NAS_BIN_PATH}:ro`,
  );
});

test("SessionStoreStage run omits the nas binary mount when no binary is available", async () => {
  // beforeEach already unset NAS_BIN_PATH and pointed PATH at an empty dir.
  const { result } = await runStage(createTestInput({ sessionId: "sess_n2" }));

  const hasNasMount = (result.dockerArgs ?? []).some((a) =>
    a.endsWith(`:${IN_CONTAINER_NAS_BIN_PATH}:ro`),
  );
  expect(hasNasMount).toBe(false);
});

test("SessionStoreStage finalizer removes the record on scope close", async () => {
  const input = createTestInput({ sessionId: "sess_to_delete" });

  const { closeScope } = await runStage(input);
  const paths = await resolveSessionRuntimePaths(undefined);
  expect(await readSession(paths, "sess_to_delete")).not.toBeNull();

  await Effect.runPromise(closeScope);
  expect(await readSession(paths, "sess_to_delete")).toBeNull();
});

test("SessionStoreStage finalizer on an already-missing record does not throw", async () => {
  const input = createTestInput({ sessionId: "sess_gone" });

  const { closeScope } = await runStage(input);
  const paths = await resolveSessionRuntimePaths(undefined);

  // Delete the file out-of-band, simulating something else cleaning up.
  const { deleteSession } = await import("../sessions/store.ts");
  await deleteSession(paths, "sess_gone");

  // Must complete without throwing.
  await Effect.runPromise(closeScope);
  expect(await readSession(paths, "sess_gone")).toBeNull();
});

test("SessionStoreStage run invokes SessionStoreService methods", async () => {
  const calls: string[] = [];
  const fakePaths: SessionRuntimePaths = {
    runtimeDir: "/tmp/nas-fake",
    sessionsDir: "/tmp/nas-fake/sessions",
  };
  const fakeLayer = makeSessionStoreServiceFake({
    ensurePaths: () => {
      calls.push("ensurePaths");
      return Effect.succeed(fakePaths);
    },
    create: (_paths: SessionRuntimePaths, _record: CreateSessionInput) => {
      calls.push("create");
      return Effect.void;
    },
    delete: (_paths: SessionRuntimePaths, _sessionId: string) => {
      calls.push("delete");
      return Effect.void;
    },
  });

  const input = createTestInput({ sessionId: "sess_fake" });
  const { closeScope } = await runStage(input, fakeLayer);

  expect(calls).toEqual(["ensurePaths", "create"]);

  await Effect.runPromise(closeScope);
  expect(calls).toEqual(["ensurePaths", "create", "delete"]);
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
