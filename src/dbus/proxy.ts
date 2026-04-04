/**
 * D-Bus proxy process management.
 *
 * Spawns and manages an xdg-dbus-proxy child process, waiting for the
 * proxy socket to become ready before returning a handle.
 */

import { gcDbusRuntime } from "./registry.ts";
import { logInfo, logWarn } from "../log.ts";

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
