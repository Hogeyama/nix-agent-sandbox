/**
 * UI daemon manager — ensures a nas UI server is running.
 * Auto-starts the UI server when a notification needs to be sent.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { resolveNasCommand } from "../lib/notify_utils.ts";
import { logInfo, logWarn } from "../log.ts";

const DEFAULT_UI_PORT = 3939;
const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 200;

interface DaemonState {
  pid?: number;
  port: number;
  startedAt: string;
}

export interface EnsureUiDaemonOptions {
  port?: number;
  idleTimeout?: number;
}

function daemonStateDir(): string {
  const home = process.env.HOME ?? "/tmp";
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
      await syncDaemonStatePid(port);
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

/**
 * Stop a running UI daemon. Reads daemon.json for port, confirms health,
 * then sends SIGTERM to the validated listening PID(s).
 */
export async function stopUiDaemon(options?: { port?: number }): Promise<void> {
  const port = options?.port ?? DEFAULT_UI_PORT;

  if (!(await isUiDaemonRunning(port))) {
    logInfo("[nas] UI daemon is not running");
    return;
  }

  let killed = false;
  const [state, listeningPids] = await Promise.all([
    readDaemonState(),
    listListeningPids(port),
  ]);
  for (const pid of resolveDaemonPidsToStop(state, listeningPids)) {
    try {
      process.kill(pid, "SIGTERM");
      killed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  if (killed) {
    logInfo("[nas] UI daemon stopped");
    // Clean up state file
    try {
      await rm(daemonStatePath(), { force: true });
    } catch {
      // ignore
    }
  } else {
    logWarn("[nas] Could not determine daemon PID to stop");
  }
}

async function startUiDaemon(
  port: number,
  idleTimeout?: number,
): Promise<void> {
  const { execPath, prefix } = resolveNasCommand();

  const args = [...prefix, "ui", "--no-open", "--port", String(port)];
  if (idleTimeout !== undefined) {
    args.push("--idle-timeout", String(idleTimeout));
  }

  // Fully detach via shell double-fork + setsid so the daemon survives
  // parent exit. Deno may kill direct child processes on shutdown, so we
  // launch through a shell subshell that backgrounds and exits immediately.
  // Fall back to plain backgrounding if setsid is not available.
  const cmdLine = [execPath, ...args]
    .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const shellCmd = (await hasSetsid())
    ? `setsid ${cmdLine} </dev/null >/dev/null 2>&1 &`
    : `(${cmdLine}) </dev/null >/dev/null 2>&1 &`;
  const child = Bun.spawn(["sh", "-c", shellCmd], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();

  await writeDaemonState({
    port,
    startedAt: new Date().toISOString(),
  });
}

async function hasSetsid(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["sh", "-c", "command -v setsid"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

async function readDaemonState(): Promise<DaemonState | null> {
  try {
    return JSON.parse(await readFile(daemonStatePath(), "utf8")) as DaemonState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeDaemonState(state: DaemonState): Promise<void> {
  await mkdir(daemonStateDir(), { recursive: true });
  await writeFile(daemonStatePath(), JSON.stringify(state, null, 2));
}

export function parseListeningPids(output: string): number[] {
  return [
    ...new Set(
      output
        .split("\n")
        .map((line) => parseInt(line, 10))
        .filter((pid) => !Number.isNaN(pid)),
    ),
  ];
}

async function listListeningPids(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return parseListeningPids(stdout.trim());
  } catch {
    return [];
  }
}

export function resolveDaemonPidsToStop(
  state: DaemonState | null,
  listeningPids: number[],
): number[] {
  if (state?.pid !== undefined) {
    if (listeningPids.includes(state.pid)) {
      return [state.pid];
    }
  }
  return [...new Set(listeningPids)];
}

export async function syncDaemonStatePid(
  port: number,
  options: {
    listListeningPids?: (port: number) => Promise<number[]>;
    readState?: () => Promise<DaemonState | null>;
    writeState?: (state: DaemonState) => Promise<void>;
  } = {},
): Promise<number | null> {
  const readState = options.readState ?? readDaemonState;
  const writeState = options.writeState ?? writeDaemonState;
  const listPids = options.listListeningPids ?? listListeningPids;
  const [state, listeningPids] = await Promise.all([
    readState(),
    listPids(port),
  ]);
  const resolvedPid = listeningPids[0] ?? null;
  if (resolvedPid !== null && state && state.pid !== resolvedPid) {
    await writeState({ ...state, pid: resolvedPid });
  }
  return resolvedPid;
}
