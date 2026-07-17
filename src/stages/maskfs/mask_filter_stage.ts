/**
 * MaskFilterStage — mask.filter が有効な場合、nas-mask-filter バイナリと
 * 秘密フレームをコンテナへバインドマウントし、stdout/stderr マスク用の
 * env / bash ラッパーを ContainerPlan にマージする。
 *
 * MaskFsStage (workspace スライス, FUSE デーモンのライフサイクル管理) とは
 * 独立したステージ: 必要とするスライスが container であり、デーモンを
 * 持たない 1 回限りの準備作業のみを行う。
 */

import { Effect } from "effect";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";
import { MaskFilterService } from "./mask_filter_service.ts";

type StageResult = Pick<PipelineState, "container">;

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
      if (!mask?.filter || mask.values.length === 0) {
        return Effect.succeed({});
      }

      return Effect.gen(function* () {
        const svc = yield* MaskFilterService;

        const resolveBin = options.resolveBinPath ?? resolveMaskFilterBinPath;
        const binaryPath = yield* Effect.tryPromise({
          try: () => resolveBin(),
          catch: (e) => e,
        });
        if (!binaryPath) {
          return yield* Effect.fail(
            new Error(
              "[nas] mask: nas-mask-filter binary not found. Build it with `cd src/mask-filter && zig build` (dev) or reinstall nas (nix).",
            ),
          );
        }

        const runtimeDir = resolveRuntimeSubdir(shared.host, "mask-filter");
        const secretsFramePath = `${runtimeDir}/${shared.sessionId}/mask-secrets`;

        const result = yield* svc.prepareMaskFilter(
          { secretsFramePath, filterBinaryHostPath: binaryPath },
          mask.values,
          shared.host,
        );

        return {
          container: mergeContainerPlan(input.container, {
            mounts: result.mounts,
            env: {
              static: {
                ...result.envVars,
                NAS_MASK_FILTER_BASH_WRAPPER: result.bashWrapperScript,
              },
            },
          }),
        };
      });
    },
  };
}
