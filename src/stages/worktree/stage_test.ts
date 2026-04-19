/**
 * WorktreeStage unit tests (no git / filesystem needed).
 *
 * Exercises the stage's orchestration: which service/prompt calls happen
 * in which order, how the stage reacts to existing worktrees, and how the
 * teardown plan is built from service + prompt results.
 *
 * Git behavior itself is tested in services/git_worktree_test.ts, and the
 * full wiring with real git is in stages/worktree_integration_test.ts.
 */

import { expect, test } from "bun:test";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import type { WorkspaceState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import {
  type CreateWorktreeParams,
  type GitWorktreeService,
  makeGitWorktreeServiceFake,
  type WorktreeEntry,
  type WorktreeHandle,
  type WorktreeTeardownPlan,
} from "./git_worktree_service.ts";
import { makePromptServiceFake, PromptService } from "./prompt_service.ts";
import { createWorktreeStage } from "./stage.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProfile(
  worktree: Profile["worktree"] = { base: "HEAD", onCreate: "" },
): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    worktree,
    nix: { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
  };
}

function makeInput(
  profile: Profile,
  workDir = "/repo",
  imageName = "nas:latest",
): StageInput & { workspace: WorkspaceState } {
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  return {
    config,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: {
      home: "/home/test",
      user: "test",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map(),
    },
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/audit",
    },
    workspace: { workDir, imageName },
  };
}

interface HandleCall {
  plan: WorktreeTeardownPlan;
}

function makeHandle(
  overrides: Partial<Omit<WorktreeHandle, "close">> & {
    onClose?: (plan: WorktreeTeardownPlan) => void;
  } = {},
): { handle: WorktreeHandle; closeCalls: HandleCall[] } {
  const closeCalls: HandleCall[] = [];
  const handle: WorktreeHandle = {
    worktreePath: overrides.worktreePath ?? "/repo/.nas/worktrees/nas-xyz",
    branchName: overrides.branchName ?? "nas/xyz",
    repoRoot: overrides.repoRoot ?? "/repo",
    baseBranch: overrides.baseBranch ?? "main",
    close: (plan) =>
      Effect.sync(() => {
        closeCalls.push({ plan });
        overrides.onClose?.(plan);
      }),
  };
  return { handle, closeCalls };
}

interface Recorder {
  resolveRepository: string[];
  resolveBaseBranch: Array<{ repoRoot: string; base: string }>;
  findNasWorktrees: string[];
  createWorktree: CreateWorktreeParams[];
  isWorktreeDirty: string[];
  getHead: string[];
  listBranchCommits: Array<{
    repoRoot: string;
    branchName: string;
    baseBranch: string;
    limit: number;
  }>;
}

function freshRecorder(): Recorder {
  return {
    resolveRepository: [],
    resolveBaseBranch: [],
    findNasWorktrees: [],
    createWorktree: [],
    isWorktreeDirty: [],
    getHead: [],
    listBranchCommits: [],
  };
}

function recordingGitLayer(
  recorder: Recorder,
  options: {
    repoRoot?: string;
    resolvedBase?: string;
    existingWorktrees?: WorktreeEntry[];
    handle?: WorktreeHandle;
    isDirty?: boolean;
    head?: string | null;
    commits?: string[];
  } = {},
): Layer.Layer<GitWorktreeService> {
  const repoRoot = options.repoRoot ?? "/repo";
  const resolvedBase = options.resolvedBase ?? "main";
  const existing = options.existingWorktrees ?? [];
  const handle = options.handle ?? makeHandle().handle;
  const isDirty = options.isDirty ?? false;
  const head = options.head ?? null;
  const commits = options.commits ?? [];

  return makeGitWorktreeServiceFake({
    resolveRepository: (workDir) => {
      recorder.resolveRepository.push(workDir);
      return Effect.succeed(repoRoot);
    },
    resolveBaseBranch: (root, base) => {
      recorder.resolveBaseBranch.push({ repoRoot: root, base });
      return Effect.succeed(resolvedBase);
    },
    findNasWorktrees: (root) => {
      recorder.findNasWorktrees.push(root);
      return Effect.succeed(existing);
    },
    createWorktree: (params) => {
      recorder.createWorktree.push(params);
      return Effect.succeed(handle);
    },
    isWorktreeDirty: (path) => {
      recorder.isWorktreeDirty.push(path);
      return Effect.succeed(isDirty);
    },
    getHead: (path) => {
      recorder.getHead.push(path);
      return Effect.succeed(head);
    },
    listBranchCommits: (opts) => {
      recorder.listBranchCommits.push(opts);
      return Effect.succeed(commits);
    },
  });
}

interface PromptRecorder {
  worktreeAction: Array<{ path: string; isDirty: boolean }>;
  dirtyWorktreeAction: Array<{ path: string }>;
  branchAction: Array<{ branchName: string | null; commitLines: string[] }>;
  reuseWorktree: WorktreeEntry[][];
  renameBranchPrompt: string[];
}

function freshPromptRecorder(): PromptRecorder {
  return {
    worktreeAction: [],
    dirtyWorktreeAction: [],
    branchAction: [],
    reuseWorktree: [],
    renameBranchPrompt: [],
  };
}

function recordingPromptLayer(
  recorder: PromptRecorder,
  config: Parameters<typeof makePromptServiceFake>[0] = {},
): Layer.Layer<PromptService> {
  const fakeLayer = makePromptServiceFake(config);
  // Wrap the fake to record calls — we override via another fake with the
  // same defaults but that records first.
  return Layer.succeed(PromptService, {
    worktreeAction: (opts) => {
      recorder.worktreeAction.push(opts);
      return Effect.flatMap(PromptService, (s) => s.worktreeAction(opts)).pipe(
        Effect.provide(fakeLayer),
      );
    },
    dirtyWorktreeAction: (opts) => {
      recorder.dirtyWorktreeAction.push(opts);
      return Effect.flatMap(PromptService, (s) =>
        s.dirtyWorktreeAction(opts),
      ).pipe(Effect.provide(fakeLayer));
    },
    branchAction: (opts) => {
      recorder.branchAction.push(opts);
      return Effect.flatMap(PromptService, (s) => s.branchAction(opts)).pipe(
        Effect.provide(fakeLayer),
      );
    },
    reuseWorktree: (entries) => {
      recorder.reuseWorktree.push([...entries]);
      return Effect.flatMap(PromptService, (s) =>
        s.reuseWorktree(entries),
      ).pipe(Effect.provide(fakeLayer));
    },
    renameBranchPrompt: (current) => {
      recorder.renameBranchPrompt.push(current);
      return Effect.flatMap(PromptService, (s) =>
        s.renameBranchPrompt(current),
      ).pipe(Effect.provide(fakeLayer));
    },
  });
}

async function runStage<A>(
  effect: Effect.Effect<A, unknown, Scope.Scope>,
  withTeardown = true,
): Promise<A> {
  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    effect.pipe(Effect.provideService(Scope.Scope, scope)),
  );
  if (withTeardown) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  return result;
}

// ---------------------------------------------------------------------------
// run(): skip path
// ---------------------------------------------------------------------------

test("run: returns workspace unchanged when worktree is undefined", async () => {
  const profile: Profile = { ...makeProfile(), worktree: undefined };
  const input = makeInput(profile, "/workdir");
  const stage = createWorktreeStage(input);

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder),
    recordingPromptLayer(promptRecorder),
  );

  const result = await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(result).toEqual({ workspace: input.workspace });
  // No service call should fire when worktree is not configured.
  expect(gitRecorder.resolveRepository.length).toEqual(0);
  expect(gitRecorder.createWorktree.length).toEqual(0);
  expect(promptRecorder.reuseWorktree.length).toEqual(0);
});

// ---------------------------------------------------------------------------
// run(): happy path — no existing worktrees
// ---------------------------------------------------------------------------

test("run: creates a new worktree when no existing worktrees are found", async () => {
  const profile = makeProfile({ base: "HEAD", onCreate: "echo hi" });
  const input = makeInput(profile, "/repo/subdir");
  const stage = createWorktreeStage(input);

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const { handle } = makeHandle({
    worktreePath: "/repo/.nas/worktrees/nas-2026",
    branchName: "nas/2026",
    repoRoot: "/repo",
    baseBranch: "main",
  });

  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      repoRoot: "/repo",
      resolvedBase: "main",
      handle,
    }),
    recordingPromptLayer(promptRecorder, { worktreeAction: "keep" }),
  );

  const result = await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(gitRecorder.resolveRepository).toEqual(["/repo/subdir"]);
  expect(gitRecorder.resolveBaseBranch).toEqual([
    { repoRoot: "/repo", base: "HEAD" },
  ]);
  expect(gitRecorder.findNasWorktrees).toEqual(["/repo"]);

  expect(gitRecorder.createWorktree.length).toEqual(1);
  const createParams = gitRecorder.createWorktree[0];
  expect(createParams.repoRoot).toEqual("/repo");
  expect(createParams.baseBranch).toEqual("main");
  expect(createParams.onCreate).toEqual("echo hi");
  expect(
    createParams.worktreePath.startsWith("/repo/.nas/worktrees/nas-"),
  ).toEqual(true);
  expect(createParams.branchName.startsWith("nas/")).toEqual(true);
  // branch name should share the timestamp with the worktree name
  const wtTs = createParams.worktreePath.slice(
    "/repo/.nas/worktrees/nas-".length,
  );
  expect(createParams.branchName).toEqual(`nas/${wtTs}`);

  expect(result.workspace.workDir).toEqual(createParams.worktreePath);
  expect(result.workspace.mountDir).toEqual("/repo");
  expect(result.workspace.imageName).toEqual("nas:latest");

  // No reuse prompt because no existing worktrees
  expect(promptRecorder.reuseWorktree.length).toEqual(0);
});

// ---------------------------------------------------------------------------
// run(): existing worktree — reuse path
// ---------------------------------------------------------------------------

test("run: reuses the worktree returned by the reuse prompt", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const existingEntry: WorktreeEntry = {
    path: "/repo/.nas/worktrees/nas-old",
    head: "abc123",
    branch: "nas/old",
    base: "main",
  };

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      repoRoot: "/repo",
      existingWorktrees: [existingEntry],
    }),
    recordingPromptLayer(promptRecorder, {
      reuseWorktree: existingEntry,
      worktreeAction: "keep",
    }),
  );

  const result = await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(promptRecorder.reuseWorktree).toEqual([[existingEntry]]);
  // createWorktree must NOT be called when the user reuses
  expect(gitRecorder.createWorktree.length).toEqual(0);
  expect(result.workspace.workDir).toEqual(existingEntry.path);
  expect(result.workspace.mountDir).toEqual("/repo");
});

test("run: creates a new worktree when reuse prompt declines", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const existingEntry: WorktreeEntry = {
    path: "/repo/.nas/worktrees/nas-old",
    head: "abc123",
    branch: "nas/old",
    base: "main",
  };

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      repoRoot: "/repo",
      existingWorktrees: [existingEntry],
    }),
    recordingPromptLayer(promptRecorder, {
      reuseWorktree: null, // user declines
      worktreeAction: "keep",
    }),
  );

  const result = await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(promptRecorder.reuseWorktree.length).toEqual(1);
  expect(gitRecorder.createWorktree.length).toEqual(1);
  expect(result.workspace.workDir).not.toEqual(existingEntry.path);
});

// ---------------------------------------------------------------------------
// Teardown plan building
// ---------------------------------------------------------------------------

test("teardown: user keeps worktree → plan has action='keep', no further prompts", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const { handle, closeCalls } = makeHandle();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      handle,
      isDirty: false,
      head: "deadbeef",
    }),
    recordingPromptLayer(promptRecorder, { worktreeAction: "keep" }),
  );

  await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(closeCalls.length).toEqual(1);
  expect(closeCalls[0].plan).toEqual({ action: "keep" });

  // Only the first prompt should have fired for keep.
  expect(promptRecorder.worktreeAction.length).toEqual(1);
  expect(promptRecorder.dirtyWorktreeAction.length).toEqual(0);
  expect(promptRecorder.branchAction.length).toEqual(0);
  expect(promptRecorder.renameBranchPrompt.length).toEqual(0);

  // Stage should still query head + dirty state before the prompt.
  expect(gitRecorder.getHead.length).toEqual(1);
  expect(gitRecorder.isWorktreeDirty.length).toEqual(1);
});

test("teardown: dirty worktree + user picks 'keep' for dirty → plan.action='keep'", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const { handle, closeCalls } = makeHandle();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, { handle, isDirty: true }),
    recordingPromptLayer(promptRecorder, {
      worktreeAction: "delete",
      dirtyWorktreeAction: "keep",
    }),
  );

  await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(closeCalls.length).toEqual(1);
  expect(closeCalls[0].plan).toEqual({
    action: "keep",
    dirtyAction: "keep",
  });

  // branchAction prompt must not be reached when dirtyAction is keep.
  expect(promptRecorder.branchAction.length).toEqual(0);
});

test("teardown: clean worktree + delete → plan has branchAction", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const { handle, closeCalls } = makeHandle();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      handle,
      isDirty: false,
      commits: ["abc123 feat: x", "def456 fix: y"],
    }),
    recordingPromptLayer(promptRecorder, {
      worktreeAction: "delete",
      branchAction: "delete",
    }),
  );

  await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  // listBranchCommits must be invoked with handle's branch + base.
  expect(gitRecorder.listBranchCommits).toEqual([
    { repoRoot: "/repo", branchName: "nas/xyz", baseBranch: "main", limit: 10 },
  ]);

  // branchAction prompt receives the commit lines from the service.
  expect(promptRecorder.branchAction).toEqual([
    {
      branchName: "nas/xyz",
      commitLines: ["abc123 feat: x", "def456 fix: y"],
    },
  ]);

  expect(closeCalls[0].plan).toEqual({
    action: "delete",
    dirtyAction: undefined,
    branchAction: "delete",
    newBranchName: null,
  });
});

test("teardown: rename branch → renameBranchPrompt fires and answer is forwarded", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const { handle, closeCalls } = makeHandle({ branchName: "nas/orig" });
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      handle,
      isDirty: false,
      commits: ["abc123 feat: x"],
    }),
    recordingPromptLayer(promptRecorder, {
      worktreeAction: "delete",
      branchAction: "rename",
      renameBranchPrompt: "feature/new",
    }),
  );

  await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(promptRecorder.renameBranchPrompt).toEqual(["nas/orig"]);
  expect(closeCalls[0].plan).toEqual({
    action: "delete",
    dirtyAction: undefined,
    branchAction: "rename",
    newBranchName: "feature/new",
  });
});

test("teardown: dirty + stash + cherry-pick → combined plan", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const { handle, closeCalls } = makeHandle();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      handle,
      isDirty: true,
      commits: ["abc123 wip"],
    }),
    recordingPromptLayer(promptRecorder, {
      worktreeAction: "delete",
      dirtyWorktreeAction: "stash",
      branchAction: "cherry-pick",
    }),
  );

  await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  expect(closeCalls[0].plan).toEqual({
    action: "delete",
    dirtyAction: "stash",
    branchAction: "cherry-pick",
    newBranchName: null,
  });
});

// ---------------------------------------------------------------------------
// Reuse path should skip teardown handle management
// ---------------------------------------------------------------------------

test("teardown: reuse path does not register a handle close finalizer", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createWorktreeStage(input);

  const existingEntry: WorktreeEntry = {
    path: "/repo/.nas/worktrees/nas-old",
    head: "abc123",
    branch: "nas/old",
    base: "main",
  };

  const gitRecorder = freshRecorder();
  const promptRecorder = freshPromptRecorder();
  const { handle, closeCalls } = makeHandle();
  const layer = Layer.mergeAll(
    recordingGitLayer(gitRecorder, {
      repoRoot: "/repo",
      existingWorktrees: [existingEntry],
      handle, // would be used if a new worktree was created
    }),
    recordingPromptLayer(promptRecorder, {
      reuseWorktree: existingEntry,
      worktreeAction: "delete", // would normally trigger close, but we're reusing
    }),
  );

  await runStage(
    stage.run({ workspace: input.workspace }).pipe(Effect.provide(layer)),
  );

  // No handle was created since we reused an existing worktree.
  expect(closeCalls.length).toEqual(0);
  // No teardown prompts should have fired.
  expect(promptRecorder.worktreeAction.length).toEqual(0);
});
