import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Exit, type Layer, Scope } from "effect";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import type { WorkspaceState } from "../pipeline/state.ts";
import type { HostEnv, StageInput, StageResult } from "../pipeline/types.ts";
import {
  type CreateSessionInput,
  makeSessionStoreServiceFake,
  SessionStoreServiceLive,
} from "../services/session_store_service.ts";
import type { SessionRuntimePaths } from "../sessions/store.ts";
import { readSession, resolveSessionRuntimePaths } from "../sessions/store.ts";
import { createSessionStoreStage } from "./session_store.ts";

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

/** Run the EffectStage, returning the result and a close handle for the scope. */
async function runStage(
  input: StageInput,
  workspace: WorkspaceState,
  layer: Layer.Layer<
    import("../services/session_store_service.ts").SessionStoreService
  > = SessionStoreServiceLive,
): Promise<{ result: StageResult; closeScope: Effect.Effect<void> }> {
  const stage = createSessionStoreStage(input);
  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run({ workspace })
      .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(layer)),
  );
  return { result, closeScope: Scope.close(scope, Exit.void) };
}

test("SessionStoreStage run writes a SessionRecord to the store dir", async () => {
  const { input, workspace } = createTestInput({ sessionId: "sess_abc123" });

  await runStage(input, workspace);

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

test("SessionStoreStage run outputs only the session slice", async () => {
  const { input, workspace } = createTestInput({ sessionId: "sess_xyz" });

  const { result } = await runStage(input, workspace);

  expect(result).toEqual({ session: { sessionId: "sess_xyz" } });
});

test("SessionStoreStage finalizer removes the record on scope close", async () => {
  const { input, workspace } = createTestInput({ sessionId: "sess_to_delete" });

  const { closeScope } = await runStage(input, workspace);
  const paths = await resolveSessionRuntimePaths(undefined);
  expect(await readSession(paths, "sess_to_delete")).not.toBeNull();

  await Effect.runPromise(closeScope);
  expect(await readSession(paths, "sess_to_delete")).toBeNull();
});

test("SessionStoreStage finalizer on an already-missing record does not throw", async () => {
  const { input, workspace } = createTestInput({ sessionId: "sess_gone" });

  const { closeScope } = await runStage(input, workspace);
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

  const { input, workspace } = createTestInput({ sessionId: "sess_fake" });
  const { closeScope } = await runStage(input, workspace, fakeLayer);

  expect(calls).toEqual(["ensurePaths", "create"]);

  await Effect.runPromise(closeScope);
  expect(calls).toEqual(["ensurePaths", "create", "delete"]);
});

test("SessionStoreStage run prefers workspace slice worktree and emits named session slice", async () => {
  let capturedRecord: CreateSessionInput | undefined;
  const fakeLayer = makeSessionStoreServiceFake({
    create: (_paths, record) =>
      Effect.sync(() => {
        capturedRecord = record;
      }),
  });

  const { input, workspace } = createTestInput({
    sessionId: "sess_workspace",
    sessionName: "named session",
    workspace: {
      workDir: "/workspace-from-slice",
      imageName: "nas-sandbox",
    },
  });

  const { result } = await runStage(input, workspace, fakeLayer);

  expect(capturedRecord?.worktree).toBe("/workspace-from-slice");
  expect(result.session).toEqual({
    sessionId: "sess_workspace",
    sessionName: "named session",
  });
});

// ---------------------------------------------------------------------------

function createTestInput(opts: {
  sessionId: string;
  sessionName?: string;
  workspace?: WorkspaceState;
}): { input: StageInput; workspace: WorkspaceState } {
  const profile: Profile = {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
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
  const workspace = opts.workspace ?? {
    workDir: "/workspace",
    imageName: "nas-sandbox",
  };
  return {
    input: {
      config,
      profile,
      profileName: "test-profile",
      sessionId: opts.sessionId,
      sessionName: opts.sessionName,
      host,
      probes: {
        hasHostNix: false,
        xdgDbusProxyPath: null,
        dbusSessionAddress: null,
        gpgAgentSocket: null,
        auditDir: "/tmp/audit",
      },
    },
    workspace,
  };
}
