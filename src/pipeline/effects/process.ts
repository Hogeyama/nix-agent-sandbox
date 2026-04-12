/**
 * Process-related effects: process-spawn, wait-for-ready.
 */

import { stat } from "node:fs/promises";
import { logInfo, logWarn } from "../../log.ts";
import type {
  ProcessSpawnEffect,
  ResourceHandle,
  WaitForReadyEffect,
} from "./types.ts";

export function executeProcessSpawn(
  effect: ProcessSpawnEffect,
): Promise<ResourceHandle> {
  const child = Bun.spawn([effect.command, ...effect.args], {
    stdout: "ignore",
    stderr: "pipe",
  });

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
        child.kill();
      } catch {
        // Process already exited
      }
      await child.exited.catch((e: unknown) =>
        logInfo(
          `[nas] process-spawn teardown (${effect.id}): failed to await child status: ${e}`,
        ),
      );
      await stderrCapture.catch((e: unknown) =>
        logInfo(
          `[nas] process-spawn teardown (${effect.id}): failed to capture stderr: ${e}`,
        ),
      );
    },
  });
}

export async function executeWaitForReady(
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
      await stat(filePath);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `[nas] Timed out waiting for file: ${filePath} (${timeoutMs}ms)`,
  );
}
