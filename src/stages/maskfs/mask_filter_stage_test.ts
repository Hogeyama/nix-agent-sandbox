import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { StageInput } from "../../pipeline/types.ts";
import {
  type MaskFilterPreparePlan,
  makeMaskFilterServiceFake,
} from "./mask_filter_service.ts";
import { createMaskFilterStage } from "./mask_filter_stage.ts";

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

describe("createMaskFilterStage", () => {
  test("no mask config → container passthrough", async () => {
    const input = makeStageInput();
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const result = await Effect.runPromise(
      Effect.scoped(
        stage
          .run({ container })
          .pipe(Effect.provide(makeMaskFilterServiceFake())),
      ),
    );
    expect(result).toEqual({});
  });

  test("mask.filter=false → container passthrough", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: false,
      anthropicEgress: false,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const result = await Effect.runPromise(
      Effect.scoped(
        stage
          .run({ container })
          .pipe(Effect.provide(makeMaskFilterServiceFake())),
      ),
    );
    expect(result).toEqual({});
  });

  test("mask.filter=true → merges mounts and env into container", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
      anthropicEgress: false,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const fakeLayer = makeMaskFilterServiceFake({
      prepareMaskFilter: () =>
        Effect.succeed({
          mounts: [
            {
              source: "/tmp/secrets",
              target: "/run/nas/mask-secrets",
              readOnly: true,
            },
            {
              source: "/fake/nas-mask-filter",
              target: "/opt/nas/mask-filter/nas-mask-filter",
              readOnly: true,
            },
          ],
          envVars: {
            NAS_MASK_SECRETS_FILE: "/run/nas/mask-secrets",
            NAS_MASK_FILTER: "/opt/nas/mask-filter/nas-mask-filter",
          },
        }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(stage.run({ container }).pipe(Effect.provide(fakeLayer))),
    );
    expect(result.container).toBeDefined();
    expect(result.container?.mounts.length).toBe(2);
    expect(result.container?.env.static.NAS_MASK_SECRETS_FILE).toBe(
      "/run/nas/mask-secrets",
    );
  });

  test("mask.filter=true with empty values → container passthrough", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
      anthropicEgress: false,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const result = await Effect.runPromise(
      Effect.scoped(
        stage
          .run({ container })
          .pipe(Effect.provide(makeMaskFilterServiceFake())),
      ),
    );
    expect(result).toEqual({});
  });

  test("socket dir is a sibling of the frame dir, not inside it", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const plans: MaskFilterPreparePlan[] = [];
    const fakeLayer = makeMaskFilterServiceFake({
      prepareMaskFilter: (plan) => {
        plans.push(plan);
        return Effect.succeed({ mounts: [], envVars: {} });
      },
    });
    await Effect.runPromise(
      Effect.scoped(stage.run({ container }).pipe(Effect.provide(fakeLayer))),
    );

    expect(plans.length).toEqual(1);
    const plan = plans[0];
    if (!plan) return;
    const frameDir = path.dirname(plan.secretsFramePath);
    // マウントされるのは socketDir。フレームのディレクトリ配下にあると
    // フレームごとコンテナへ渡すことになる (C1)。
    expect(plan.socketDir.startsWith(`${frameDir}/`)).toEqual(false);
    expect(path.dirname(plan.socketDir)).toEqual(path.dirname(frameDir));
    expect(plan.socketPath).toEqual(`${plan.socketDir}/mask.sock`);
    expect(plan.logFile).toEqual(`${frameDir}/serve.log`);
  });

  test("socket path over 107 bytes → fails", async () => {
    const input = makeStageInput({
      host: {
        ...HOST,
        env: new Map([["XDG_RUNTIME_DIR", `/run/${"d".repeat(120)}`]]),
      },
    });
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => "/fake/nas-mask-filter",
    });
    const container = emptyContainerPlan("img", "/work");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        stage
          .run({ container })
          .pipe(Effect.provide(makeMaskFilterServiceFake())),
      ),
    );

    expect(Exit.isFailure(exit)).toEqual(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toEqual("Some");
      if (failure._tag === "Some") {
        const err = failure.value as Error;
        expect(err.message).toContain("socket path too long");
      }
    }
  });

  test("binary not found → fails", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
      anthropicEgress: false,
    };
    const stage = createMaskFilterStage(input, {
      resolveBinPath: async () => null,
    });
    const container = emptyContainerPlan("img", "/work");
    await expect(
      Effect.runPromise(
        Effect.scoped(
          stage
            .run({ container })
            .pipe(Effect.provide(makeMaskFilterServiceFake())),
        ),
      ),
    ).rejects.toThrow(/binary not found/);
  });
});
