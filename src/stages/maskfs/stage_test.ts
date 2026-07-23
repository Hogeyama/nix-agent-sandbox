import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { WorkspaceState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import type { MountProbes } from "../mount/mount_probes.ts";
import {
  type MaskFsStartPlan,
  makeMaskFsServiceFake,
} from "./maskfs_service.ts";
import { createMaskFsStage, resolveMaskFsRuntimeDir } from "./stage.ts";

const HOST = {
  home: "/home/u",
  user: "u",
  uid: 1000,
  gid: 1000,
  isWSL: false,
  env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
} as const;

function makeStageInput(overrides: Partial<StageInput> = {}): StageInput {
  return {
    config: {
      ui: { enable: false, port: 0, idleTimeout: 0 },
      observability: { enable: false, retention: null },
      profiles: {},
    },
    profile: {
      agent: "claude",
      agentArgs: [],
      session: { multiplex: false, detachKey: "^\\" },
      nix: { enable: false, mountSocket: false, extraPackages: [] },
      docker: { enable: false, shared: false },
      gcloud: { mountConfig: false },
      aws: { mountConfig: false },
      gpg: { forwardAgent: false },
      network: {
        reviewRules: [],
        credentials: [],
        proxy: { forwardPorts: [] },
        pendingTimeoutSeconds: 300,
        pendingDefaultScope: "host-port",
        pendingNotify: "off",
      },
      dbus: {
        session: {
          enable: false,
          see: [],
          talk: [],
          own: [],
          calls: [],
          broadcasts: [],
        },
      },
      display: { sandbox: "none", size: "1920x1080" },
      extraMounts: [],
      env: [],
      hook: { notify: "off" },
    },
    profileName: "test",
    sessionId: "sess_test1",
    host: HOST,
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/audit",
    },
    ...overrides,
  } as StageInput;
}

const WORKSPACE: WorkspaceState = {
  workDir: "/repo/sub",
  mountDir: "/repo",
  imageName: "nas-img",
};

const MOUNT_PROBES = { gitWorktreeMainRoot: null } as unknown as MountProbes;

describe("resolveMaskFsRuntimeDir", () => {
  test("uses XDG_RUNTIME_DIR when set", () => {
    expect(resolveMaskFsRuntimeDir(HOST)).toEqual("/run/user/1000/nas/maskfs");
  });
});

describe("createMaskFsStage", () => {
  test("no mask config → workspace passthrough, no daemon start", async () => {
    let started = 0;
    const layer = makeMaskFsServiceFake({
      startMaskFs: () =>
        Effect.sync(() => {
          started += 1;
          return { kill: () => {} };
        }),
    });
    const stage = createMaskFsStage(makeStageInput(), MOUNT_PROBES);
    const result = await Effect.runPromise(
      Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.workspace.maskedRoot).toBeUndefined();
    expect(started).toEqual(0);
  });

  test("mask.maskfs=false → workspace passthrough, no daemon start", async () => {
    let started = 0;
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_MASK_SECRET" }],
      writePolicy: "readonly",
      maskfs: false,
      proxy: true,
      filter: true,
    };
    const layer = makeMaskFsServiceFake({
      startMaskFs: () =>
        Effect.sync(() => {
          started += 1;
          return { kill: () => {} };
        }),
    });
    const stage = createMaskFsStage(input, MOUNT_PROBES);
    const result = await Effect.runPromise(
      Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.workspace.maskedRoot).toBeUndefined();
    expect(started).toEqual(0);
  });

  test("mask config → resolves secrets, starts daemon, sets maskedRoot", async () => {
    const plans: MaskFsStartPlan[] = [];
    const layer = makeMaskFsServiceFake({
      startMaskFs: (plan) =>
        Effect.sync(() => {
          plans.push(plan);
          return { kill: () => {} };
        }),
      resolveSecrets: () => Effect.succeed(["hunter2secret"]),
    });
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_MASK_SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const hostEnv = new Map(HOST.env);
    hostEnv.set("NAS_TEST_MASK_SECRET", "hunter2secret");
    (input as { host: unknown }).host = { ...HOST, env: hostEnv };

    const stage = createMaskFsStage(input, MOUNT_PROBES, {
      resolveBinPath: async () => "/fake/nas-maskfs",
    });
    const result = await Effect.runPromise(
      Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(plans.length).toEqual(1);
    expect(plans[0].sourceDir).toEqual("/repo"); // mountDir が優先される
    expect(plans[0].writePolicy).toEqual("readonly");
    expect(result.workspace.maskedRoot).toEqual(
      "/run/user/1000/nas/maskfs/sessions/sess_test1/mnt",
    );
    // フレームに秘密値が入っている (先頭 count=1, len=13)
    const view = new DataView(plans[0].secretsFrame.buffer);
    expect(view.getUint32(0, true)).toEqual(1);
    expect(view.getUint32(4, true)).toEqual(13);
  });

  test("secret shorter than 4 bytes → fails (fail-closed)", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_SHORT" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const hostEnv = new Map(HOST.env);
    hostEnv.set("NAS_TEST_SHORT", "abc");
    (input as { host: unknown }).host = { ...HOST, env: hostEnv };

    const stage = createMaskFsStage(input, MOUNT_PROBES, {
      resolveBinPath: async () => "/fake/nas-maskfs",
    });
    await expect(
      Effect.runPromise(
        Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
          Effect.provide(
            makeMaskFsServiceFake({
              resolveSecrets: () =>
                Effect.fail(
                  new Error(
                    "[nas] mask: mask.values[0] resolved value must be at least 4 bytes (got 3); short values would mass-mask unrelated content",
                  ),
                ),
            }),
          ),
        ),
      ),
    ).rejects.toThrow(/at least 4 bytes/);
  });

  test("binary not found → fails (fail-closed)", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_MASK_SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const hostEnv = new Map(HOST.env);
    hostEnv.set("NAS_TEST_MASK_SECRET", "hunter2secret");
    (input as { host: unknown }).host = { ...HOST, env: hostEnv };

    const stage = createMaskFsStage(input, MOUNT_PROBES, {
      resolveBinPath: async () => null,
    });
    await expect(
      Effect.runPromise(
        Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
          Effect.provide(makeMaskFsServiceFake()),
        ),
      ),
    ).rejects.toThrow(/binary not found/);
  });

  test("unresolvable secret source → fails (fail-closed)", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:NAS_TEST_DOES_NOT_EXIST" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const stage = createMaskFsStage(input, MOUNT_PROBES, {
      resolveBinPath: async () => "/fake/nas-maskfs",
    });
    await expect(
      Effect.runPromise(
        Effect.scoped(stage.run({ workspace: WORKSPACE })).pipe(
          Effect.provide(
            makeMaskFsServiceFake({
              resolveSecrets: () =>
                Effect.fail(
                  new Error(
                    '[nas] mask: failed to resolve mask.values[0].source ("env:NAS_TEST_DOES_NOT_EXIST"): not found',
                  ),
                ),
            }),
          ),
        ),
      ),
    ).rejects.toThrow();
  });
});
