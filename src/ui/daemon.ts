/**
 * UI daemon manager — ensures a nas UI server is running.
 * Auto-starts the UI server when a notification needs to be sent.
 */

import * as path from "@std/path";
import { logInfo, logWarn } from "../log.ts";
import { resolveNasCommand } from "../lib/notify_utils.ts";

const DEFAULT_UI_PORT = 3939;
const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 200;

interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
}

export interface EnsureUiDaemonOptions {
  port?: number;
  idleTimeout?: number;
}

function daemonStateDir(): string {
  const home = Deno.env.get("HOME") ?? "/tmp";
  return path.join(home, ".cache", "nas", "ui");
}

function daemonStatePath(): string {
  return path.join(daemonStateDir(), "daemon.json");
}

/**
 * Ensure a UI daemon is running on the given port.
 * If not running, starts one automatically.
 * Returns the base URL (e.g. "http://localhost:3939").
 */
export async function ensureUiDaemon(
  options?: EnsureUiDaemonOptions,
): Promise<string> {
  const port = options?.port ?? DEFAULT_UI_PORT;
  const url = `http://localhost:${port}`;
  if (await isUiDaemonRunning(port)) {
    return url;
  }

  logInfo(`[nas] Starting UI daemon on port ${port}...`);
  await startUiDaemon(port, options?.idleTimeout);

  // setsid --fork makes the actual daemon a grandchild process, so we
  // cannot track it via child.status. Poll health check instead.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isUiDaemonRunning(port)) {
      logInfo(`[nas] UI daemon ready at ${url}`);
      return url;
    }
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
  }

  logWarn("[nas] UI daemon failed to start within timeout");
  throw new Error(`UI daemon failed to start on port ${port}`);
}

/**
 * Check if a UI daemon is running and healthy on the given port.
 */
export async function isUiDaemonRunning(port: number): Promise<boolean> {
  let resp: Response | undefined;
  try {
    resp = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await resp.json();
    return body.ok === true;
  } catch {
    // Drain body to avoid resource leak when resp exists but json() fails
    await resp?.body?.cancel().catch(() => {});
    return false;
  }
}

async function startUiDaemon(
  port: number,
  idleTimeout?: number,
): Promise<void> {
  const { execPath, prefix } = resolveNasCommand();

  const args = [
    ...prefix,
    "ui",
    "--no-open",
    "--port",
    String(port),
  ];
  if (idleTimeout !== undefined) {
    args.push("--idle-timeout", String(idleTimeout));
  }

  // Fully detach via shell double-fork + setsid so the daemon survives
  // parent exit. Deno may kill direct child processes on shutdown, so we
  // launch through a shell subshell that backgrounds and exits immediately.
  const cmdLine = [execPath, ...args]
    .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const child = new Deno.Command("sh", {
    args: ["-c", `setsid ${cmdLine} </dev/null >/dev/null 2>&1 &`],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  child.unref();

  const stateDir = daemonStateDir();
  await Deno.mkdir(stateDir, { recursive: true });
  const state: DaemonState = {
    pid: child.pid,
    port,
    startedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    daemonStatePath(),
    JSON.stringify(state, null, 2),
  );
}
