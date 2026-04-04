/**
 * Effect executor and ResourceHandle teardown management.
 *
 * Phase 0: only `directory-create` and `file-write` are implemented.
 * Other effect kinds throw "not yet implemented" errors.
 */

import type {
  DbusProxyEffect,
  DindSidecarEffect,
  ProcessSpawnEffect,
  ResourceEffect,
  StagePlan,
  SymlinkEffect,
  UnixListenerEffect,
  WaitForReadyEffect,
} from "./types.ts";
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
import { gcDbusRuntime } from "../dbus/registry.ts";
import { HostExecBroker } from "../hostexec/broker.ts";
import {
  removeHostExecPendingDir,
  removeHostExecSessionRegistry,
  writeHostExecSessionRegistry,
} from "../hostexec/registry.ts";
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
    case "dbus-proxy":
      return await executeDbusProxy(effect);
    case "process-spawn":
      return await executeProcessSpawn(effect);
    case "wait-for-ready":
      return await executeWaitForReady(effect);
    case "symlink":
      return await executeSymlink(effect);
    case "unix-listener":
      return await executeUnixListener(effect);
    case "docker-container":
    case "docker-network":
    case "docker-volume":
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
      } catch (teardownErr) {
        logWarn(
          `[nas] executePlan: teardown failed during error recovery: ${
            teardownErr instanceof Error
              ? teardownErr.message
              : String(teardownErr)
          }`,
        );
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
    } catch (cleanupErr) {
      if (!(cleanupErr instanceof Deno.errors.NotFound)) {
        logWarn(
          `[nas] file-write: cleanup failed after chmod error: ${
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
      } catch (e: unknown) {
        logWarn(
          `[nas] DinD teardown: failed to stop container: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      try {
        await dockerRm(containerName);
      } catch (e: unknown) {
        logWarn(
          `[nas] DinD teardown: failed to remove container: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      try {
        logInfo(`[nas] DinD: removing network ${networkName}`);
        await dockerNetworkRemove(networkName);
      } catch (e: unknown) {
        logWarn(
          `[nas] DinD teardown: failed to remove network: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      try {
        logInfo(`[nas] DinD: removing volume ${sharedTmpVolume}`);
        await dockerVolumeRemove(sharedTmpVolume);
      } catch (e: unknown) {
        logWarn(
          `[nas] DinD teardown: failed to remove volume: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// dbus-proxy effect
// ---------------------------------------------------------------------------

async function executeDbusProxy(
  effect: DbusProxyEffect,
): Promise<ResourceHandle> {
  const {
    proxyBinaryPath,
    runtimeDir,
    sessionsDir,
    sessionDir,
    socketPath,
    pidFile,
    args,
    timeoutMs,
    pollIntervalMs,
  } = effect;

  // GC stale sessions before starting
  await gcDbusRuntime({ runtimeDir, sessionsDir }).catch((e: unknown) =>
    logWarn(
      `[nas] dbus-proxy: GC failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  );

  // Create directories
  await Deno.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  await Deno.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await Deno.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  // Spawn xdg-dbus-proxy
  const command = new Deno.Command(proxyBinaryPath, {
    args,
    stdout: "null",
    stderr: "piped",
  });
  const child = command.spawn();

  // Write PID file
  await Deno.writeTextFile(pidFile, String(child.pid));
  await Deno.chmod(pidFile, 0o600);

  // Capture stderr in background for diagnostics
  let stderrText = "";
  const stderrCapture = (async () => {
    if (!child.stderr) return;
    try {
      stderrText = await new Response(child.stderr).text();
    } catch (e: unknown) {
      logWarn(
        `[nas] dbus-proxy: stderr capture failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  })();

  // Wait for socket with early exit detection via Promise.race
  try {
    await Promise.race([
      waitForSocket(socketPath, timeoutMs, pollIntervalMs),
      child.status.then((status) => {
        if (!status.success) {
          throw new Error(
            `[nas] xdg-dbus-proxy exited early with code ${status.code}${
              stderrText ? `: ${stderrText}` : ""
            }`,
          );
        }
      }),
    ]);
  } catch (error) {
    // On failure, include stderr in the error message if available
    // Wait briefly for stderr capture to complete
    await stderrCapture.catch(() => {});
    const enrichedMessage = stderrText
      ? `${
        error instanceof Error ? error.message : String(error)
      } (stderr: ${stderrText})`
      : (error instanceof Error ? error.message : String(error));

    // Clean up on failure
    try {
      child.kill("SIGTERM");
    } catch (e: unknown) {
      if (!(e instanceof Deno.errors.NotFound)) {
        logWarn(
          `[nas] dbus-proxy: cleanup kill failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    await child.status.catch(() => {});
    await Deno.remove(sessionDir, { recursive: true }).catch((e: unknown) =>
      logWarn(
        `[nas] dbus-proxy: cleanup session dir failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    );
    throw new Error(enrichedMessage);
  }

  return {
    kind: "dbus-proxy",
    close: async () => {
      try {
        child.kill("SIGTERM");
      } catch (e: unknown) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
        // Process already exited
      }
      await child.status.catch((e: unknown) =>
        logInfo(
          `[nas] dbus-proxy teardown: failed to await child status: ${e}`,
        )
      );
      await stderrCapture.catch((e: unknown) =>
        logInfo(
          `[nas] dbus-proxy teardown: failed to capture stderr: ${e}`,
        )
      );
      await Deno.remove(sessionDir, { recursive: true }).catch((e: unknown) =>
        logWarn(
          `[nas] dbus-proxy teardown: failed to remove session dir: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      );
    },
  };
}

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await Deno.stat(socketPath);
      return;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `[nas] Timed out waiting for dbus proxy socket: ${socketPath} (${timeoutMs}ms)`,
  );
}

// ---------------------------------------------------------------------------
// process-spawn effect
// ---------------------------------------------------------------------------

function executeProcessSpawn(
  effect: ProcessSpawnEffect,
): Promise<ResourceHandle> {
  const command = new Deno.Command(effect.command, {
    args: effect.args,
    stdout: "null",
    stderr: "piped",
  });
  const child = command.spawn();

  // Capture stderr in background for diagnostics
  let stderrText = "";
  const stderrCapture = (async () => {
    if (!child.stderr) return;
    try {
      stderrText = await new Response(child.stderr).text();
    } catch (e: unknown) {
      logWarn(
        `[nas] process-spawn (${effect.id}): stderr capture failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      stderrText = "";
    }
  })();

  // Suppress unused variable warning — stderrText is captured for diagnostics
  void stderrText;

  return Promise.resolve({
    kind: "process-spawn",
    close: async () => {
      try {
        child.kill("SIGTERM");
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
        // Process already exited
      }
      await child.status.catch((e: unknown) =>
        logInfo(
          `[nas] process-spawn teardown (${effect.id}): failed to await child status: ${e}`,
        )
      );
      await stderrCapture.catch((e: unknown) =>
        logInfo(
          `[nas] process-spawn teardown (${effect.id}): failed to capture stderr: ${e}`,
        )
      );
    },
  });
}

// ---------------------------------------------------------------------------
// wait-for-ready effect
// ---------------------------------------------------------------------------

async function executeWaitForReady(
  effect: WaitForReadyEffect,
): Promise<ResourceHandle> {
  const { check, timeoutMs, pollIntervalMs } = effect;

  switch (check.kind) {
    case "file-exists":
      await waitForFileExists(check.path, timeoutMs, pollIntervalMs);
      break;
    case "tcp-port":
    case "http-ok":
    case "docker-healthy":
      throw new Error(
        `wait-for-ready check not yet implemented: ${check.kind}`,
      );
  }

  return {
    kind: "wait-for-ready",
    close: async () => {
      // No teardown needed for readiness checks
    },
  };
}

async function waitForFileExists(
  filePath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await Deno.stat(filePath);
      return;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `[nas] Timed out waiting for file: ${filePath} (${timeoutMs}ms)`,
  );
}

// ---------------------------------------------------------------------------
// symlink effect
// ---------------------------------------------------------------------------

async function executeSymlink(
  effect: SymlinkEffect,
): Promise<ResourceHandle> {
  // Remove old symlink if it exists
  try {
    await Deno.remove(effect.path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }
  await Deno.symlink(effect.target, effect.path);
  return {
    kind: "symlink",
    close: async () => {
      try {
        await Deno.remove(effect.path);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// unix-listener effect
// ---------------------------------------------------------------------------

async function executeUnixListener(
  effect: UnixListenerEffect,
): Promise<ResourceHandle> {
  const { spec } = effect;

  switch (spec.kind) {
    case "hostexec-broker":
      return await executeHostExecBrokerListener(effect);
    case "session-broker":
      throw new Error("unix-listener session-broker not yet implemented");
  }
}

async function executeHostExecBrokerListener(
  effect: UnixListenerEffect,
): Promise<ResourceHandle> {
  const spec = effect.spec;
  if (spec.kind !== "hostexec-broker") {
    throw new Error(`unexpected listener spec kind: ${spec.kind}`);
  }

  const broker = new HostExecBroker({
    paths: spec.paths,
    sessionId: spec.sessionId,
    profileName: spec.profileName,
    workspaceRoot: spec.workspaceRoot,
    sessionTmpDir: spec.sessionTmpDir,
    hostexec: spec.hostexec,
    notify: spec.notify,
    uiEnabled: spec.uiEnabled,
    uiPort: spec.uiPort,
    uiIdleTimeout: spec.uiIdleTimeout,
    auditDir: spec.auditDir,
  });
  await broker.start(effect.socketPath);

  // Write session registry entry. If this fails, close the broker
  // to avoid leaking a dangling Unix socket listener.
  try {
    await writeHostExecSessionRegistry(spec.paths, {
      version: 1,
      sessionId: spec.sessionId,
      brokerSocket: effect.socketPath,
      profileName: spec.profileName,
      createdAt: new Date().toISOString(),
      pid: Deno.pid,
      agent: spec.agent,
    });
  } catch (error) {
    try {
      await broker.close();
    } catch (closeErr) {
      logWarn(
        `[nas] HostExec: failed to close broker after registry write failure: ${closeErr}`,
      );
    }
    throw error;
  }

  return {
    kind: "unix-listener",
    close: async () => {
      await broker.close();
      await removeHostExecSessionRegistry(spec.paths, spec.sessionId)
        .catch((e) =>
          logInfo(
            `[nas] HostExec teardown: failed to remove session registry: ${e}`,
          )
        );
      await removeHostExecPendingDir(spec.paths, spec.sessionId).catch(
        (e) =>
          logInfo(
            `[nas] HostExec teardown: failed to remove pending dir: ${e}`,
          ),
      );
    },
  };
}
