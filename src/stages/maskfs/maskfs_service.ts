/**
 * MaskFsService — nas-maskfs デーモンのライフサイクル管理。
 *
 * 責務: マウントポイント作成 → preflight (fusermount3 / user_allow_other) →
 * デーモン spawn (秘密値は stdin) → mount ready 待機 → Scope 終了時に
 * fusermount3 -u + SIGTERM。
 *
 * Live は FsService + ProcessService に委譲する (dbus_proxy_service.ts と同型)。
 * preflight (fusermount3 / user_allow_other チェック) と mount-ready 判定の
 * IO も FsService 経由で行い、D2 合成 Effect のレイヤー境界を守る。
 * テストからは MaskFsStartOptions 経由で差し替え可能。
 */

import * as path from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import { FsService } from "../../services/fs.ts";
import { ProcessService } from "../../services/process.ts";

type Fs = Context.Tag.Service<typeof FsService>;

export interface MaskFsStartPlan {
  readonly binaryPath: string;
  readonly sourceDir: string;
  readonly mountpoint: string;
  readonly writePolicy: "readonly" | "passthrough";
  readonly secretsFrame: Uint8Array;
  readonly logFile: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface MaskFsHandle {
  readonly kill: () => void;
}

/** テストから preflight / readiness 判定を差し替えるためのオプション */
export interface MaskFsStartOptions {
  readonly preflight?: () => Effect.Effect<void, unknown>;
  readonly waitReady?: (plan: MaskFsStartPlan) => Effect.Effect<void, unknown>;
}

export class MaskFsService extends Context.Tag("nas/MaskFsService")<
  MaskFsService,
  {
    readonly startMaskFs: (
      plan: MaskFsStartPlan,
      options?: MaskFsStartOptions,
    ) => Effect.Effect<MaskFsHandle, unknown, Scope.Scope>;
  }
>() {}

// ---------------------------------------------------------------------------
// Preflight helpers (default implementations; IO routed through FsService)
// ---------------------------------------------------------------------------

function assertFusermountAvailable(): Effect.Effect<string, Error> {
  // Bun.which is a synchronous lookup, so wrapping it in Effect.sync is fine
  // even though the rest of this module routes IO through FsService.
  return Effect.sync(() => Bun.which("fusermount3")).pipe(
    Effect.flatMap((found) =>
      found
        ? Effect.succeed(found)
        : Effect.fail(
            new Error(
              "[nas] mask: fusermount3 not found on PATH. Install fuse3 (NixOS: environment.systemPackages = [ pkgs.fuse3 ])",
            ),
          ),
    ),
  );
}

function assertAllowOtherPermitted(fs: Fs): Effect.Effect<void, Error> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return Effect.void;
  }
  return fs.readFile("/etc/fuse.conf").pipe(
    // missing fuse.conf → user_allow_other 無効扱い
    Effect.catchAllCause(() => Effect.succeed("")),
    Effect.flatMap((text) => {
      const ok = text
        .split("\n")
        .some((line) => line.trim() === "user_allow_other");
      return ok
        ? Effect.void
        : Effect.fail(
            new Error(
              "[nas] mask: FUSE allow_other requires 'user_allow_other' in /etc/fuse.conf",
            ),
          );
    }),
  );
}

function defaultPreflight(fs: Fs): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* assertFusermountAvailable();
    yield* assertAllowOtherPermitted(fs);
  });
}

/** mountpoint の st_dev が親ディレクトリと異なれば FUSE マウント完了 */
function isMounted(fs: Fs, mountpoint: string): Effect.Effect<boolean> {
  return Effect.all([
    fs.stat(mountpoint),
    fs.stat(path.dirname(mountpoint)),
  ]).pipe(
    Effect.map(([self, parent]) => self.dev !== parent.dev),
    Effect.catchAllCause(() => Effect.succeed(false)),
  );
}

function defaultWaitReady(
  fs: Fs,
  plan: MaskFsStartPlan,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const deadline = Date.now() + plan.timeoutMs;
    while (Date.now() < deadline) {
      if (yield* isMounted(fs, plan.mountpoint)) return;
      yield* Effect.sleep(plan.pollIntervalMs);
    }
    const logTail = yield* fs.readFile(plan.logFile).pipe(
      Effect.map((s) => s.slice(-2000)),
      Effect.catchAllCause(() => Effect.succeed("")),
    );
    yield* Effect.fail(
      new Error(
        `[nas] mask: maskfs mount did not become ready within ${plan.timeoutMs}ms at ${plan.mountpoint}\n${logTail}`,
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const MaskFsServiceLive: Layer.Layer<
  MaskFsService,
  never,
  FsService | ProcessService
> = Layer.effect(
  MaskFsService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;

    return MaskFsService.of({
      startMaskFs: (plan, options) =>
        Effect.gen(function* () {
          yield* fs.mkdir(path.dirname(plan.mountpoint), {
            recursive: true,
            mode: 0o700,
          });
          yield* fs.mkdir(plan.mountpoint, { recursive: true, mode: 0o700 });

          const preflight = options?.preflight ?? (() => defaultPreflight(fs));
          yield* preflight();

          const spawnHandle = yield* Effect.acquireRelease(
            proc.spawn(
              plan.binaryPath,
              [
                plan.sourceDir,
                plan.mountpoint,
                `--write-policy=${plan.writePolicy}`,
                "--allow-other",
              ],
              {
                logFile: plan.logFile,
                stdinData: plan.secretsFrame,
              },
            ),
            (handle) =>
              proc.exec(["fusermount3", "-u", plan.mountpoint]).pipe(
                // fusermount3 -u may fail (already unmounted, race, etc.) —
                // the cleanup must never fail, and ProcessService.exec dies
                // (rather than fails) on non-zero exit, so we must catch the
                // defect too, not just the error channel. Log rather than
                // swallow so unexpected unmount failures are still visible.
                Effect.catchAllCause(() =>
                  Effect.logWarning("maskfs: fusermount3 unmount failed"),
                ),
                Effect.andThen(Effect.sync(() => handle.kill())),
              ),
          );

          const waitReady =
            options?.waitReady ?? ((p) => defaultWaitReady(fs, p));
          yield* waitReady(plan);

          return {
            kill: () => spawnHandle.kill(),
          } satisfies MaskFsHandle;
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface MaskFsServiceFakeConfig {
  readonly startMaskFs?: (
    plan: MaskFsStartPlan,
    options?: MaskFsStartOptions,
  ) => Effect.Effect<MaskFsHandle, unknown, Scope.Scope>;
}

const defaultHandle: MaskFsHandle = { kill: () => {} };

export function makeMaskFsServiceFake(
  overrides: MaskFsServiceFakeConfig = {},
): Layer.Layer<MaskFsService> {
  return Layer.succeed(
    MaskFsService,
    MaskFsService.of({
      startMaskFs:
        overrides.startMaskFs ?? (() => Effect.succeed(defaultHandle)),
    }),
  );
}
