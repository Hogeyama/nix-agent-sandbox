/**
 * MaskFilterStage — mask.filter が有効な場合、nas-mask-filter の `--serve`
 * デーモンをセッションスコープで起動し、その socket のディレクトリと
 * フィルタバイナリをコンテナへバインドマウントして、stdout/stderr マスク用の
 * env を ContainerPlan にマージする。
 *
 * 解決済みシークレットのフレームはホスト側にだけ置き、コンテナへは socket
 * しか見せない (C1)。そのため socket はセッションディレクトリの「兄弟」の
 * ディレクトリに置く — マウントするのは socket の「あるディレクトリ」なので、
 * フレームと同居させるとフレームごとコンテナへ渡すことになる。
 *
 * デーモンのライフサイクル (フレーム書き込み・spawn・socket の listen 待ち・
 * Scope 終了時の後始末) は MaskFilterService が持つ。このステージはパスを
 * 決めて検証し、その計画をサービスへ渡すだけ。
 *
 * MaskFsStage (workspace スライス, FUSE デーモン) とは独立したステージ:
 * 必要とするスライスが container であり、別のデーモンを扱う。
 */

import { Effect } from "effect";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { formatElapsed, logDebug } from "../../log.ts";
import { selectAppliedSecrets } from "../../network/secrets.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";
import { MaskFilterService } from "./mask_filter_service.ts";

type StageResult = Pick<PipelineState, "container">;

const SOCKET_READY_TIMEOUT_MS = 10_000;
const SOCKET_READY_POLL_MS = 10;

/** sun_path は NUL 終端込みで 108 バイト。 */
const MAX_SOCKET_PATH_BYTES = 107;

/** テスト用フック */
export interface MaskFilterStageOptions {
  readonly resolveBinPath?: () => Promise<string | null>;
}

export function createMaskFilterStage(
  shared: StageInput,
  options: MaskFilterStageOptions = {},
): Stage<"container", Partial<StageResult>, MaskFilterService, unknown> {
  return {
    name: "MaskFilterStage",
    needs: ["container"],

    run(input) {
      const mask = shared.profile.mask;
      const applied = selectAppliedSecrets(shared.profile.secrets, mask?.apply);
      if (!mask?.filter || Object.keys(applied).length === 0) {
        return Effect.succeed({});
      }

      return Effect.gen(function* () {
        const svc = yield* MaskFilterService;

        const resolveBin = options.resolveBinPath ?? resolveMaskFilterBinPath;
        let phaseStart = performance.now();
        const binaryPath = yield* Effect.tryPromise({
          try: () => resolveBin(),
          catch: (e) => e,
        });
        logDebug(
          `[nas]   ↳ MaskFilterStage:resolve-binary done (${formatElapsed(phaseStart)})`,
        );
        if (!binaryPath) {
          return yield* Effect.fail(
            new Error(
              "[nas] mask: nas-mask-filter binary not found. Build it with `cd src/mask-filter && zig build` (dev) or reinstall nas (nix).",
            ),
          );
        }

        const runtimeDir = resolveRuntimeSubdir(shared.host, "mask-filter");
        // socket はセッションディレクトリの「兄弟」に置く。マウントするのは
        // socket のあるディレクトリなので、同居させるとフレームごとコンテナへ
        // 渡すことになる (C1)。
        const sessionDir = `${runtimeDir}/${shared.sessionId}`;
        const socketDir = `${runtimeDir}/${shared.sessionId}-sock`;
        const socketPath = `${socketDir}/mask.sock`;

        // 超過を放置するとデーモン内の bind(2) が不可解に失敗するだけで、
        // 運用者には原因が分からない。
        const socketPathBytes = new TextEncoder().encode(socketPath).byteLength;
        if (socketPathBytes > MAX_SOCKET_PATH_BYTES) {
          return yield* Effect.fail(
            new Error(
              `[nas] mask: socket path too long: ${socketPathBytes} bytes (max ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`,
            ),
          );
        }

        phaseStart = performance.now();
        const secrets = yield* svc.resolveSecrets(applied, shared.host);
        logDebug(
          `[nas]   ↳ MaskFilterStage:resolve-secrets done (${formatElapsed(phaseStart)})`,
        );
        phaseStart = performance.now();
        const result = yield* svc.prepareMaskFilter(
          {
            secretsFramePath: `${sessionDir}/mask-secrets`,
            filterBinaryHostPath: binaryPath,
            socketDir,
            socketPath,
            logFile: `${sessionDir}/serve.log`,
            timeoutMs: SOCKET_READY_TIMEOUT_MS,
            pollIntervalMs: SOCKET_READY_POLL_MS,
          },
          secrets,
        );
        logDebug(
          `[nas]   ↳ MaskFilterStage:prepare done (${formatElapsed(phaseStart)})`,
        );

        return {
          container: mergeContainerPlan(input.container, {
            mounts: result.mounts,
            env: { static: result.envVars },
          }),
        };
      });
    },
  };
}
