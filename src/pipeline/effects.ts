/**
 * Effect executor and ResourceHandle teardown management.
 *
 * Phase 0: only `directory-create` and `file-write` are implemented.
 * Other effect kinds throw "not yet implemented" errors.
 */

import type { DindSidecarEffect, ResourceEffect, StagePlan } from "./types.ts";
import {
  ensureNetwork,
  ensureSharedTmpWritable,
  startDindSidecar,
} from "../stages/dind.ts";
import {
  dockerIsRunning,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
  dockerVolumeRemove,
} from "../docker/client.ts";
import { logInfo, logWarn } from "../log.ts";

// ---------------------------------------------------------------------------
// ResourceHandle
// ---------------------------------------------------------------------------

/** Handle returned by executeEffect for teardown */
export interface ResourceHandle {
  kind: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// executeEffect
// ---------------------------------------------------------------------------

/** Execute a single ResourceEffect and return a handle for teardown. */
export async function executeEffect(
  effect: ResourceEffect,
): Promise<ResourceHandle> {
  switch (effect.kind) {
    case "directory-create":
      return await executeDirectoryCreate(effect);
    case "file-write":
      return await executeFileWrite(effect);
    case "dind-sidecar":
      return await executeDindSidecar(effect);
    case "docker-container":
    case "docker-network":
    case "docker-volume":
    case "symlink":
    case "process-spawn":
    case "unix-listener":
    case "wait-for-ready":
    case "docker-run-interactive":
      throw new Error(`Effect not yet implemented: ${effect.kind}`);
  }
}

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

/** Execute all effects in a StagePlan sequentially and return accumulated handles. */
export async function executePlan(plan: StagePlan): Promise<ResourceHandle[]> {
  const handles: ResourceHandle[] = [];
  for (const effect of plan.effects) {
    try {
      const handle = await executeEffect(effect);
      handles.push(handle);
    } catch (error) {
      try {
        await teardownHandles(handles);
      } catch {
        // teardown failed, but we still want to throw the original error
      }
      throw error;
    }
  }
  return handles;
}

// ---------------------------------------------------------------------------
// teardownHandles
// ---------------------------------------------------------------------------

/** Close handles in reverse order. Errors are collected and reported together. */
export async function teardownHandles(
  handles: ResourceHandle[],
): Promise<void> {
  const errors: { kind: string; error: unknown }[] = [];
  for (let i = handles.length - 1; i >= 0; i--) {
    try {
      await handles[i].close();
    } catch (error) {
      errors.push({ kind: handles[i].kind, error });
    }
  }
  if (errors.length > 0) {
    const messages = errors.map((e) =>
      `[${e.kind}] ${
        e.error instanceof Error ? e.error.message : String(e.error)
      }`
    ).join("; ");
    throw new Error(
      `Teardown failed for ${errors.length} handle(s): ${messages}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Effect implementations (Phase 0)
// ---------------------------------------------------------------------------

async function executeDirectoryCreate(
  effect: Extract<ResourceEffect, { kind: "directory-create" }>,
): Promise<ResourceHandle> {
  await Deno.mkdir(effect.path, { recursive: true, mode: effect.mode });
  return {
    kind: "directory-create",
    close: async () => {
      if (effect.removeOnTeardown) {
        await Deno.remove(effect.path, { recursive: true });
      }
    },
  };
}

async function executeFileWrite(
  effect: Extract<ResourceEffect, { kind: "file-write" }>,
): Promise<ResourceHandle> {
  await Deno.writeTextFile(effect.path, effect.content);
  try {
    await Deno.chmod(effect.path, effect.mode);
  } catch (error) {
    try {
      await Deno.remove(effect.path);
    } catch {
      // cleanup failed, but we still want to throw the original error
    }
    throw error;
  }
  return {
    kind: "file-write",
    close: async () => {
      await Deno.remove(effect.path);
    },
  };
}

// ---------------------------------------------------------------------------
// dind-sidecar effect
// ---------------------------------------------------------------------------

async function executeDindSidecar(
  effect: DindSidecarEffect,
): Promise<ResourceHandle> {
  const {
    containerName,
    sharedTmpVolume,
    networkName,
    shared,
    disableCache,
    readinessTimeoutMs,
  } = effect;

  const isReusingSharedSidecar = shared &&
    await dockerIsRunning(containerName);

  // 共有モード: 既に起動中ならサイドカー作成をスキップ
  let sidecarStarted = false;
  if (isReusingSharedSidecar) {
    logInfo(`[nas] DinD: reusing shared sidecar (${containerName})`);
  } else {
    // 共有モードで停止済みコンテナが残っている場合は削除して再作成
    if (shared) {
      await dockerRm(containerName).catch((e: unknown) =>
        logInfo(
          `[nas] DinD: failed to remove stale shared container: ${e}`,
        )
      );
    }

    // DinD rootless サイドカーをデフォルト bridge で起動
    await startDindSidecar(containerName, sharedTmpVolume, {
      disableCache,
      readinessTimeoutMs,
    });
    sidecarStarted = true;
  }

  try {
    // 共有 tmp を全ユーザーから書き込み可能にする
    await ensureSharedTmpWritable(containerName);

    // カスタムネットワーク作成（既存ならスキップ）& サイドカー接続
    await ensureNetwork(networkName, containerName);
  } catch (error) {
    // 途中で失敗した場合、起動済みサイドカーをクリーンアップしてから再 throw
    if (sidecarStarted && !shared) {
      try {
        await dockerStop(containerName, { timeoutSeconds: 0 });
      } catch (cleanupErr) {
        logWarn(
          `[nas] DinD: cleanup failed (stop): ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
      }
      try {
        await dockerRm(containerName);
      } catch (cleanupErr) {
        logWarn(
          `[nas] DinD: cleanup failed (rm): ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
      }
    }
    throw error;
  }

  return {
    kind: "dind-sidecar",
    close: async () => {
      if (shared) {
        logInfo(
          `[nas] DinD: keeping shared sidecar (${containerName})`,
        );
        return;
      }

      try {
        logInfo(`[nas] DinD: stopping sidecar ${containerName}`);
        await dockerStop(containerName, { timeoutSeconds: 0 });
      } catch {
        // コンテナが既に停止している場合は無視
      }
      try {
        await dockerRm(containerName);
      } catch {
        // コンテナが既に削除されている場合は無視
      }
      try {
        logInfo(`[nas] DinD: removing network ${networkName}`);
        await dockerNetworkRemove(networkName);
      } catch {
        // ネットワークが既に削除されている場合は無視
      }
      try {
        logInfo(`[nas] DinD: removing volume ${sharedTmpVolume}`);
        await dockerVolumeRemove(sharedTmpVolume);
      } catch {
        // ボリュームが既に削除されている場合は無視
      }
    },
  };
}
