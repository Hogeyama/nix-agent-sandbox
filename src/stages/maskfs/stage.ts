/**
 * MaskFs ステージ — mask 設定があるとき nas-maskfs デーモンを起動し、
 * WorkspaceState.maskedRoot にマスク済みビューのルートを記録する。
 * MountStage はこの値をバインドソースとして優先する。
 *
 * フェイルクローズ: 秘密値の解決失敗・値が短すぎる・バイナリ欠如・
 * mount ready タイムアウトはすべてステージ失敗 = セッション起動中止。
 */

import { Effect } from "effect";
import type { MaskValueConfig } from "../../config/types.ts";
import { SecretStore } from "../../hostexec/secret_store.ts";
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
const MIN_SECRET_BYTES = 4;

/** テスト用フック */
export interface MaskFsStageOptions {
  readonly resolveBinPath?: () => Promise<string | null>;
  readonly resolveSecrets?: (
    values: MaskValueConfig[],
    host: HostEnv,
  ) => Promise<string[]>;
}

export function resolveMaskFsRuntimeDir(host: HostEnv): string {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return `${xdg}/nas/maskfs`;
  }
  const uid = host.uid ?? "unknown";
  return `/tmp/nas-${uid}/maskfs`;
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
        const resolveSecrets = options.resolveSecrets ?? resolveMaskSecrets;
        const secrets = yield* Effect.tryPromise({
          try: () => resolveSecrets(mask.values, shared.host),
          catch: (e) => e,
        });

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

/**
 * デフォルトの秘密値解決実装 (本番用)。node:fs 経由の IO (file:/dotenv: ソース) を行う。
 * テストでは MaskFsStageOptions.resolveSecrets 経由でこの関数をフェイクに差し替える。
 */
async function resolveMaskSecrets(
  values: MaskValueConfig[],
  host: HostEnv,
): Promise<string[]> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of host.env) env[k] = v;

  const store = new SecretStore(
    Object.fromEntries(
      values.map((v, i) => [String(i), { from: v.source, required: true }]),
    ),
    { env },
  );

  const secrets: string[] = [];
  for (const [i, value] of values.entries()) {
    let resolved: string;
    try {
      resolved = await store.require(String(i));
    } catch (e) {
      throw new Error(
        `[nas] mask: failed to resolve mask.values[${i}].source ("${value.source}"): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const bytes = new TextEncoder().encode(resolved);
    if (bytes.byteLength < MIN_SECRET_BYTES) {
      throw new Error(
        `[nas] mask: mask.values[${i}] resolved value must be at least 4 bytes (got ${bytes.byteLength}); short values would mass-mask unrelated content`,
      );
    }
    secrets.push(resolved);
  }
  return secrets;
}
