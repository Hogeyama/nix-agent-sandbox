/**
 * UI daemon manager — ensures a nas UI server is running.
 * Auto-starts the UI server when a notification needs to be sent.
 */

import * as path from "@std/path";
import { logInfo, logWarn } from "../log.ts";

const DEFAULT_UI_PORT = 3939;
const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 200;

interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
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
  port = DEFAULT_UI_PORT,
): Promise<string> {
  const url = `http://localhost:${port}`;
  if (await isUiDaemonRunning(port)) {
    return url;
  }

  logInfo(`[nas] Starting UI daemon on port ${port}...`);
  const child = await startUiDaemon(port);

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isUiDaemonRunning(port)) {
      logInfo(`[nas] UI daemon ready at ${url}`);
      return url;
    }
    // Detect early crash: if the child already exited, fail fast
    const exited = await Promise.race([
      child.status.then((s) => s),
      new Promise<null>((r) => setTimeout(() => r(null), STARTUP_POLL_MS)),
    ]);
    if (exited !== null) {
      throw new Error(
        `UI daemon exited immediately with code ${exited.code}`,
      );
    }
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

async function startUiDaemon(port: number): Promise<Deno.ChildProcess> {
  const execPath = Deno.execPath();
  const isCompiled = !path.basename(execPath).startsWith("deno");

  const args = isCompiled ? ["ui", "--no-open", "--port", String(port)] : [
    "run",
    "-A",
    new URL("../../main.ts", import.meta.url).pathname,
    "ui",
    "--no-open",
    "--port",
    String(port),
  ];

  const child = new Deno.Command(execPath, {
    args,
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
  return child;
}
