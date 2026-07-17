/**
 * MaskFilterService — nas-mask-filter バイナリと秘密フレームをコンテナに
 * 供給するための準備 (ファイル書き込み + マウント/env 計算) を行う。
 *
 * MaskFsService (FUSE デーモン) とは異なりデーモンのライフサイクルは持たず、
 * 「秘密フレームをホスト上のファイルへ書き出し、コンテナへバインドマウント
 * する」という 1 回限りの準備作業のみを行う。
 */

import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import type { MaskValueConfig } from "../../config/types.ts";
import { resolveMaskSecrets } from "../../lib/mask_secrets.ts";
import type { MountSpec } from "../../pipeline/state.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import { FsService } from "../../services/fs.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

export const MASK_FILTER_CONTAINER_PATH =
  "/opt/nas/mask-filter/nas-mask-filter";
export const MASK_SECRETS_CONTAINER_PATH = "/run/nas/mask-secrets";

export interface MaskFilterPreparePlan {
  readonly secretsFramePath: string;
  readonly filterBinaryHostPath: string;
}

export interface MaskFilterResult {
  readonly mounts: readonly MountSpec[];
  readonly envVars: Readonly<Record<string, string>>;
}

export class MaskFilterService extends Context.Tag("nas/MaskFilterService")<
  MaskFilterService,
  {
    readonly prepareMaskFilter: (
      plan: MaskFilterPreparePlan,
      secrets: string[],
    ) => Effect.Effect<MaskFilterResult, unknown>;
    readonly resolveSecrets: (
      values: MaskValueConfig[],
      host: HostEnv,
    ) => Effect.Effect<string[], unknown>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const MaskFilterServiceLive: Layer.Layer<
  MaskFilterService,
  never,
  FsService
> = Layer.effect(
  MaskFilterService,
  Effect.gen(function* () {
    const fs = yield* FsService;

    return MaskFilterService.of({
      prepareMaskFilter: (plan, secrets) =>
        Effect.gen(function* () {
          const frame = encodeMaskSecrets(secrets);
          yield* fs.mkdir(path.dirname(plan.secretsFramePath), {
            recursive: true,
            mode: 0o700,
          });
          yield* fs.writeFile(plan.secretsFramePath, frame, { mode: 0o600 });

          const mounts: MountSpec[] = [
            {
              source: plan.secretsFramePath,
              target: MASK_SECRETS_CONTAINER_PATH,
              readOnly: true,
            },
            {
              source: plan.filterBinaryHostPath,
              target: MASK_FILTER_CONTAINER_PATH,
              readOnly: true,
            },
          ];

          const envVars: Record<string, string> = {
            NAS_MASK_SECRETS_FILE: MASK_SECRETS_CONTAINER_PATH,
            NAS_MASK_FILTER: MASK_FILTER_CONTAINER_PATH,
          };

          return { mounts, envVars };
        }),

      resolveSecrets: (values, host) =>
        Effect.tryPromise({
          try: () => {
            const env: Record<string, string | undefined> = {};
            for (const [k, v] of host.env) env[k] = v;
            return resolveMaskSecrets(values, env);
          },
          catch: (e) => e,
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface MaskFilterServiceFakeConfig {
  readonly prepareMaskFilter?: (
    plan: MaskFilterPreparePlan,
    secrets: string[],
  ) => Effect.Effect<MaskFilterResult, unknown>;
  readonly resolveSecrets?: (
    values: MaskValueConfig[],
    host: HostEnv,
  ) => Effect.Effect<string[], unknown>;
}

export function makeMaskFilterServiceFake(
  overrides: MaskFilterServiceFakeConfig = {},
): Layer.Layer<MaskFilterService> {
  return Layer.succeed(
    MaskFilterService,
    MaskFilterService.of({
      prepareMaskFilter:
        overrides.prepareMaskFilter ??
        (() => Effect.succeed({ mounts: [], envVars: {} })),
      resolveSecrets: overrides.resolveSecrets ?? (() => Effect.succeed([])),
    }),
  );
}
