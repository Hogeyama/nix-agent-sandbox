/**
 * MaskFsService — nas-maskfs デーモンのライフサイクル管理。
 *
 * 責務: マウントポイント作成 → preflight (fusermount3 / user_allow_other) →
 * デーモン spawn (秘密値は stdin) → mount ready 待機 → Scope 終了時に
 * fusermount3 -u + SIGTERM。
 *
 * Live は FsService + ProcessService に委譲する (dbus_proxy_service.ts と同型)。
 *
 * preflight と mount-ready 判定は one-shot のチェックであり、他の Effect と
 * 合成されないため D1 primitive 相当として plain async のまま実装している
 * (effect-separation skill 参照)。テストからは MaskFsStartOptions 経由で
 * 差し替え可能。
 */

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import { FsService } from "../../services/fs.ts";
import { ProcessService } from "../../services/process.ts";

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
  readonly preflight?: () => Promise<void>;
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
// Preflight helpers (one-shot plain async checks; see file header)
// ---------------------------------------------------------------------------

async function assertFusermountAvailable(): Promise<string> {
  const found = Bun.which("fusermount3");
  if (!found) {
    throw new Error(
      "[nas] mask: fusermount3 not found on PATH. Install fuse3 (NixOS: environment.systemPackages = [ pkgs.fuse3 ])",
    );
  }
  return found;
}

async function assertAllowOtherPermitted(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  let text = "";
  try {
    text = await readFile("/etc/fuse.conf", "utf8");
  } catch {
    // missing fuse.conf → user_allow_other 無効扱い
  }
  const ok = text
    .split("\n")
    .some((line) => line.trim() === "user_allow_other");
  if (!ok) {
    throw new Error(
      "[nas] mask: FUSE allow_other requires 'user_allow_other' in /etc/fuse.conf " +
        "(NixOS: programs.fuse.userAllowOther = true)",
    );
  }
}

async function defaultPreflight(): Promise<void> {
  await assertFusermountAvailable();
  await assertAllowOtherPermitted();
}

/** mountpoint の st_dev が親ディレクトリと異なれば FUSE マウント完了 */
async function isMounted(mountpoint: string): Promise<boolean> {
  try {
    const [self, parent] = await Promise.all([
      stat(mountpoint),
      stat(path.dirname(mountpoint)),
    ]);
    return self.dev !== parent.dev;
  } catch {
    return false;
  }
}

function defaultWaitReady(plan: MaskFsStartPlan): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + plan.timeoutMs;
      while (Date.now() < deadline) {
        if (await isMounted(plan.mountpoint)) return;
        await new Promise((r) => setTimeout(r, plan.pollIntervalMs));
      }
      let logTail = "";
      try {
        logTail = (await readFile(plan.logFile, "utf8")).slice(-2000);
      } catch {
        // no log
      }
      throw new Error(
        `[nas] mask: maskfs mount did not become ready within ${plan.timeoutMs}ms at ${plan.mountpoint}\n${logTail}`,
      );
    },
    catch: (e) => e,
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

          const preflight = options?.preflight ?? defaultPreflight;
          yield* Effect.tryPromise({ try: preflight, catch: (e) => e });

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
                // defect too, not just the error channel.
                Effect.catchAllCause(() => Effect.void),
                Effect.andThen(Effect.sync(() => handle.kill())),
              ),
          );

          const waitReady = options?.waitReady ?? defaultWaitReady;
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
