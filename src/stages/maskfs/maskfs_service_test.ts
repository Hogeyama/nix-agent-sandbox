/**
 * MaskFsService unit tests.
 *
 * Drives MaskFsServiceLive with FsServiceFake + ProcessServiceFake to verify
 * daemon spawn arguments (source, mountpoint, write policy, stdin secrets
 * frame) and fail-closed behavior when mount readiness never arrives.
 *
 * `preflight` and `waitReady` are injected via MaskFsStartOptions so these
 * tests don't depend on a real fusermount3 / fuse.conf being present on the
 * host running the test suite.
 */

import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { makeFsServiceFake } from "../../services/fs.ts";
import { makeProcessServiceFake } from "../../services/process.ts";
import {
  MaskFsService,
  MaskFsServiceLive,
  type MaskFsStartPlan,
} from "./maskfs_service.ts";

function makePlan(overrides: Partial<MaskFsStartPlan> = {}): MaskFsStartPlan {
  return {
    binaryPath: "/opt/nas/maskfs/nas-maskfs",
    sourceDir: "/repo",
    mountpoint: "/run/user/1000/nas/maskfs/sessions/s1/mnt",
    writePolicy: "readonly",
    secretsFrame: new Uint8Array([1, 0, 0, 0, 4, 0, 0, 0, 116, 101, 115, 116]),
    logFile: "/run/user/1000/nas/maskfs/sessions/s1/maskfs.log",
    timeoutMs: 100,
    pollIntervalMs: 10,
    ...overrides,
  };
}

const skipPreflight = () => Effect.void;

describe("MaskFsService", () => {
  test("spawns daemon with source, mountpoint, policy and stdin frame", async () => {
    const spawned: {
      command: string;
      args: string[];
      stdinData?: Uint8Array;
    }[] = [];
    const procFake = makeProcessServiceFake({
      spawn: (command, args, opts) =>
        Effect.sync(() => {
          spawned.push({ command, args, stdinData: opts?.stdinData });
          return { kill: () => {}, exited: Effect.succeed(0), pid: 1 };
        }),
    });
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(Layer.merge(makeFsServiceFake().layer, procFake)),
    );
    const plan = makePlan();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(plan, {
            preflight: skipPreflight,
            waitReady: () => Effect.void,
          });
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(spawned.length).toEqual(1);
    expect(spawned[0].command).toEqual(plan.binaryPath);
    expect(spawned[0].args).toEqual([
      "/repo",
      plan.mountpoint,
      "--write-policy=readonly",
      "--allow-other",
    ]);
    expect(spawned[0].stdinData).toEqual(plan.secretsFrame);
  });

  test("creates the mountpoint directory before spawning", async () => {
    const fsFake = makeFsServiceFake();
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(Layer.merge(fsFake.layer, makeProcessServiceFake())),
    );
    const plan = makePlan();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(plan, {
            preflight: skipPreflight,
            waitReady: () => Effect.void,
          });
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(fsFake.store.has(plan.mountpoint)).toEqual(true);
  });

  test("fails when readiness never arrives (fail-closed)", async () => {
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(
        Layer.merge(makeFsServiceFake().layer, makeProcessServiceFake()),
      ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(makePlan(), {
            preflight: skipPreflight,
            waitReady: () => Effect.fail(new Error("timeout")),
          });
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toEqual(true);
  });

  test("fails when preflight rejects (fusermount3 missing)", async () => {
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(
        Layer.merge(makeFsServiceFake().layer, makeProcessServiceFake()),
      ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(makePlan(), {
            preflight: () => Effect.fail(new Error("fusermount3 not found")),
            waitReady: () => Effect.void,
          });
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toEqual(true);
  });

  test("release: unmounts and kills the daemon when the scope closes", async () => {
    const execCalls: string[][] = [];
    let killed = false;
    const procFake = makeProcessServiceFake({
      spawn: () =>
        Effect.sync(() => ({
          kill: () => {
            killed = true;
          },
          exited: Effect.succeed(0),
          pid: 1,
        })),
      exec: (cmd) =>
        Effect.sync(() => {
          execCalls.push(cmd);
          return "";
        }),
    });
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(Layer.merge(makeFsServiceFake().layer, procFake)),
    );
    const plan = makePlan();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(plan, {
            preflight: skipPreflight,
            waitReady: () => Effect.void,
          });
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(execCalls).toEqual([["fusermount3", "-u", plan.mountpoint]]);
    expect(killed).toEqual(true);
  });

  test("release: still kills the daemon when fusermount3 -u fails", async () => {
    let killed = false;
    const procFake = makeProcessServiceFake({
      spawn: () =>
        Effect.sync(() => ({
          kill: () => {
            killed = true;
          },
          exited: Effect.succeed(0),
          pid: 1,
        })),
      exec: () => Effect.die(new Error("fusermount3: not mounted")),
    });
    const layer = MaskFsServiceLive.pipe(
      Layer.provide(Layer.merge(makeFsServiceFake().layer, procFake)),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFsService;
          yield* svc.startMaskFs(makePlan(), {
            preflight: skipPreflight,
            waitReady: () => Effect.void,
          });
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(killed).toEqual(true);
  });
});
