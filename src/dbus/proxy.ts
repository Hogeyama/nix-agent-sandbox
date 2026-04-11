/**
 * D-Bus proxy process management.
 *
 * Spawns and manages an xdg-dbus-proxy child process, waiting for the
 * proxy socket to become ready before returning a handle.
 */

import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { logInfo, logWarn } from "../log.ts";
import { gcDbusRuntime } from "./registry.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for starting a D-Bus proxy process. */
export interface StartDbusProxyParams {
  proxyBinaryPath: string;
  runtimeDir: string;
  sessionsDir: string;
  sessionDir: string;
  socketPath: string;
  pidFile: string;
  args: string[];
  timeoutMs: number;
  pollIntervalMs: number;
}

/** Handle returned by startDbusProxy for lifecycle management. */
export interface DbusProxyHandle {
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// startDbusProxy
// ---------------------------------------------------------------------------

/** Spawn an xdg-dbus-proxy, wait for its socket, and return a handle. */
export async function startDbusProxy(
  params: StartDbusProxyParams,
): Promise<DbusProxyHandle> {
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
  } = params;

  // GC stale sessions before starting
  await gcDbusRuntime({ runtimeDir, sessionsDir }).catch((e: unknown) =>
    logWarn(
      `[nas] dbus-proxy: GC failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    ),
  );

  // Create directories
  await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  // Spawn xdg-dbus-proxy
  const child = Bun.spawn([proxyBinaryPath, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });

  // Write PID file
  await writeFile(pidFile, String(child.pid));
  await chmod(pidFile, 0o600);

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
      child.exited.then((code) => {
        if (code !== 0) {
          throw new Error(
            `[nas] xdg-dbus-proxy exited early with code ${code}${
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
      : error instanceof Error
        ? error.message
        : String(error);

    // Clean up on failure
    try {
      child.kill();
    } catch (e: unknown) {
      logWarn(
        `[nas] dbus-proxy: cleanup kill failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    await child.exited.catch(() => {});
    await rm(sessionDir, { recursive: true, force: true }).catch((e: unknown) =>
      logWarn(
        `[nas] dbus-proxy: cleanup session dir failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      ),
    );
    throw new Error(enrichedMessage);
  }

  return {
    close: async () => {
      try {
        child.kill();
      } catch {
        // Process already exited
      }
      await child.exited.catch((e: unknown) =>
        logInfo(
          `[nas] dbus-proxy teardown: failed to await child status: ${e}`,
        ),
      );
      await stderrCapture.catch((e: unknown) =>
        logInfo(`[nas] dbus-proxy teardown: failed to capture stderr: ${e}`),
      );
      await rm(sessionDir, { recursive: true, force: true }).catch(
        (e: unknown) =>
          logWarn(
            `[nas] dbus-proxy teardown: failed to remove session dir: ${
              e instanceof Error ? e.message : String(e)
            }`,
          ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// waitForSocket
// ---------------------------------------------------------------------------

/** Poll for a Unix socket to appear on the filesystem. */
export async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await stat(socketPath);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `[nas] Timed out waiting for dbus proxy socket: ${socketPath} (${timeoutMs}ms)`,
  );
}
