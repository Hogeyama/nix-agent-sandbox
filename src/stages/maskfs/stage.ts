/**
 * MaskFs ステージ — mask 設定があるとき nas-maskfs デーモンを起動し、
 * WorkspaceState.maskedRoot にマスク済みビューのルートを記録する。
 * MountStage はこの値をバインドソースとして優先する。
 *
 * フェイルクローズ: 秘密値の解決失敗・値が短すぎる・バイナリ欠如・
 * mount ready タイムアウトはすべてステージ失敗 = セッション起動中止。
 */

import { Effect } from "effect";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { WorkspaceState } from "../../pipeline/state.ts";
import type { HostEnv, StageInput } from "../../pipeline/types.ts";
import type { MountProbes } from "../mount/mount_probes.ts";
import { resolveWorkspaceMountSource } from "../mount/stage.ts";
import { resolveMaskFsBinPath } from "./maskfs_path.ts";
import { MaskFsService } from "./maskfs_service.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

const MOUNT_READY_TIMEOUT_MS = 10_000;
const MOUNT_READY_POLL_MS = 50;

/** テスト用フック */
export interface MaskFsStageOptions {
  readonly resolveBinPath?: () => Promise<string | null>;
}

export function resolveMaskFsRuntimeDir(host: HostEnv): string {
  return resolveRuntimeSubdir(host, "maskfs");
}

export function createMaskFsStage(
  shared: StageInput,
  mountProbes: MountProbes,
  options: MaskFsStageOptions = {},
): Stage<"workspace", { workspace: WorkspaceState }, MaskFsService, unknown> {
  return {
    name: "MaskFsStage",
    needs: ["workspace"],

    run(input) {
      const mask = shared.profile.mask;
      if (!mask || mask.values.length === 0) {
        return Effect.succeed({ workspace: input.workspace });
      }

      return Effect.gen(function* () {
        const maskFs = yield* MaskFsService;

        // --- 秘密値の解決 (fail-closed: 全値 required) ---
        const secrets = yield* maskFs.resolveSecrets(mask.values, shared.host);

        // --- バイナリパス ---
        const resolveBin = options.resolveBinPath ?? resolveMaskFsBinPath;
        const binaryPath = yield* Effect.tryPromise({
          try: () => resolveBin(),
          catch: (e) => e,
        });
        if (!binaryPath) {
          return yield* Effect.fail(
            new Error(
              "[nas] mask: nas-maskfs binary not found. Build it with `cd src/maskfs && zig build` (dev) or reinstall nas (nix).",
            ),
          );
        }

        const sourceDir = resolveWorkspaceMountSource(
          input.workspace,
          mountProbes,
        );
        const runtimeDir = resolveMaskFsRuntimeDir(shared.host);
        const sessionDir = `${runtimeDir}/sessions/${shared.sessionId}`;
        const mountpoint = `${sessionDir}/mnt`;

        yield* maskFs.startMaskFs({
          binaryPath,
          sourceDir,
          mountpoint,
          writePolicy: mask.writePolicy,
          secretsFrame: encodeMaskSecrets(secrets),
          logFile: `${sessionDir}/maskfs.log`,
          timeoutMs: MOUNT_READY_TIMEOUT_MS,
          pollIntervalMs: MOUNT_READY_POLL_MS,
        });

        return {
          workspace: { ...input.workspace, maskedRoot: mountpoint },
        };
      });
    },
  };
}
