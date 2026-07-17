import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { makeMaskFilterServiceFake } from "./mask_filter_service.ts";
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
          bashWrapperScript: '#!/bin/bash\nexec /bin/bash "$@"',
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

  test("binary not found → fails", async () => {
    const input = makeStageInput();
    input.profile.mask = {
      values: [{ source: "env:SECRET" }],
      writePolicy: "readonly",
      maskfs: true,
      proxy: true,
      filter: true,
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
