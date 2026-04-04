/**
 * Shared low-level utilities for desktop notification systems.
 * Used by both network/notify.ts and hostexec/notify.ts.
 */

import * as path from "@std/path";
import { logWarn } from "../log.ts";

export type NotifyBackend = "auto" | "desktop" | "off";

// Module-level state for tracking the active desktop notification ID.
// Only one notification is active at a time across the process.
let lastDesktopNotificationId: string | null = null;
let notifySendMissingWarned = false;
let xdgOpenMissingWarned = false;
let _notifySendCmd: string | null = null;
let _notifySendNeedsWarning = false;

/** Reset cached notify-send command resolution. For testing only. */
export function _resetNotifySendCache(): void {
  _notifySendCmd = null;
  _notifySendNeedsWarning = false;
  notifySendMissingWarned = false;
}

export interface DesktopNotificationOptions {
  title: string;
  body: string;
  /** URL to open in the browser when the user clicks the notification. */
  uiUrl: string;
  signal?: AbortSignal;
}

/**
 * Show a desktop notification via notify-send.
 * On click, opens the given UI URL in the browser.
 * On dismiss, does nothing (request stays pending until timeout).
 */
export async function tryDesktopNotification(
  options: DesktopNotificationOptions,
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const cmd = getNotifySendCommand();
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args: [
        "--print-id",
        "--wait",
        "--expire-time=0",
        "--action=default=Open",
        options.title,
        options.body,
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    warnNotifySendMissing();
    return false;
  }

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  };
  options.signal?.addEventListener("abort", onAbort);

  try {
    const { action } = await readNotifySendOutput(child.stdout);
    const status = await child.status;
    lastDesktopNotificationId = null;

    if (!status.success) return false;

    if (action === "default") {
      try {
        await new Deno.Command("xdg-open", {
          args: [options.uiUrl],
          stdout: "null",
          stderr: "null",
        }).output();
      } catch {
        if (!xdgOpenMissingWarned) {
          xdgOpenMissingWarned = true;
          logWarn(
            "[nas] xdg-open not found; cannot open UI in browser. " +
              `Open manually: ${options.uiUrl}`,
          );
        }
      }
      return true;
    }
    // Dismiss (empty action) → do nothing; request stays pending
    return true;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    lastDesktopNotificationId = null;
  }
}

/**
 * Close any active desktop notification.
 */
export async function closeNotification(): Promise<void> {
  const capturedId = lastDesktopNotificationId;
  if (capturedId) {
    await closeDesktopNotification(capturedId);
  }
}

export function isWSL(): boolean {
  return Boolean(Deno.env.get("WSL_DISTRO_NAME"));
}

/**
 * Resolve the nas command prefix (exec path + args for deno run if needed).
 * Used by CLI action notifications and daemon spawning.
 */
export function resolveNasCommand(): { execPath: string; prefix: string[] } {
  const execPath = Deno.execPath();
  const isCompiled = !path.basename(execPath).startsWith("deno");
  const prefix = isCompiled ? [] : [
    "run",
    "-A",
    new URL("../../main.ts", import.meta.url).pathname,
  ];
  return { execPath, prefix };
}

export interface CliActionNotificationOptions {
  title: string;
  body: string;
  /** nas subcommand args for approve, e.g. ["network", "approve", sessionId, requestId] */
  approveArgs: string[];
  /** nas subcommand args for deny, e.g. ["network", "deny", sessionId, requestId] */
  denyArgs: string[];
  signal?: AbortSignal;
}

/**
 * Show a desktop notification with Approve/Deny actions.
 * On click, executes the corresponding nas CLI command.
 * On dismiss, does nothing (request stays pending until timeout).
 */
export async function tryCliActionNotification(
  options: CliActionNotificationOptions,
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(getNotifySendCommand(), {
      args: [
        "--print-id",
        "--wait",
        "--expire-time=0",
        "--action=approve=Approve",
        "--action=deny=Deny",
        options.title,
        options.body,
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    warnNotifySendMissing();
    return false;
  }

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  };
  options.signal?.addEventListener("abort", onAbort);

  try {
    const { action } = await readNotifySendOutput(child.stdout);
    const status = await child.status;
    lastDesktopNotificationId = null;

    if (!status.success) return false;

    const { execPath, prefix } = resolveNasCommand();
    if (action === "approve") {
      try {
        await new Deno.Command(execPath, {
          args: [...prefix, ...options.approveArgs],
          stdout: "null",
          stderr: "null",
        }).output();
      } catch { /* command may not be resolvable */ }
      return true;
    }
    if (action === "deny") {
      try {
        await new Deno.Command(execPath, {
          args: [...prefix, ...options.denyArgs],
          stdout: "null",
          stderr: "null",
        }).output();
      } catch { /* command may not be resolvable */ }
      return true;
    }
    // Dismiss → do nothing
    return true;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    lastDesktopNotificationId = null;
  }
}

/**
 * Check whether `notify-send` is available and warn if not.
 * On WSL, the bundled shim is used automatically.
 */
export function checkNotifySend(): void {
  getNotifySendCommand();
  if (_notifySendNeedsWarning) {
    warnNotifySendMissing();
  }
}

function getNotifySendCommand(): string {
  if (_notifySendCmd !== null) return _notifySendCmd;
  if (findInPath("notify-send")) {
    _notifySendCmd = "notify-send";
  } else if (isWSL()) {
    _notifySendCmd = extractWslShim();
  } else {
    _notifySendCmd = "notify-send";
    _notifySendNeedsWarning = true;
  }
  return _notifySendCmd;
}

function findInPath(cmd: string): boolean {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    try {
      Deno.statSync(`${dir}/${cmd}`);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Read the bundled notify-send-wsl script and write it to a real file on disk
 * so it can be spawned as a subprocess. deno compile embeds --include'd files
 * in a virtual FS that is readable but not executable via spawn().
 */
function extractWslShim(): string {
  const embeddedUrl = new URL(
    "../../scripts/notify-send-wsl",
    import.meta.url,
  );
  const embeddedPath = embeddedUrl.pathname;

  // In dev (deno run) the file is already on disk — use it directly.
  // In compiled mode import.meta.url is a virtual path under /tmp/deno-compile-*
  // where Deno.statSync succeeds but the file cannot be spawned as a process.
  const isCompiled = !path.basename(Deno.execPath()).startsWith("deno");
  if (!isCompiled) return embeddedPath;

  // deno compile: extract from virtual FS to a real temp file
  const content = Deno.readTextFileSync(embeddedPath);
  const tmpDir = Deno.makeTempDirSync({ prefix: "nas-wsl-shim-" });
  const tmpPath = `${tmpDir}/notify-send-wsl`;
  Deno.writeTextFileSync(tmpPath, content, { mode: 0o755 });
  return tmpPath;
}

function warnNotifySendMissing(): void {
  if (notifySendMissingWarned) return;
  notifySendMissingWarned = true;
  logWarn(
    "[nas] notify-send not found. " +
      "Install libnotify (e.g. apt install libnotify-bin) for desktop notifications.",
  );
}

// --- Internal helpers ---

/**
 * Read notify-send --print-id --wait output incrementally.
 * First line = notification ID (stored immediately for dismissal),
 * remaining output = action chosen by user.
 */
async function readNotifySendOutput(
  stdout: ReadableStream<Uint8Array>,
): Promise<{ id: string | null; action: string }> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let idCaptured = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (!idCaptured && buf.includes("\n")) {
        const nl = buf.indexOf("\n");
        lastDesktopNotificationId = buf.slice(0, nl).trim();
        idCaptured = true;
      }
    }
  } catch {
    // stream error (process killed by signal)
  } finally {
    reader.releaseLock();
  }

  const lines = buf.trim().split("\n");
  const id = lines.length > 0 ? lines[0].trim() : null;
  const action = lines.length > 1 ? lines[lines.length - 1].trim() : "";
  return { id, action };
}

async function closeDesktopNotification(id: string): Promise<void> {
  try {
    await new Deno.Command("gdbus", {
      args: [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.Notifications",
        "--object-path",
        "/org/freedesktop/Notifications",
        "--method",
        "org.freedesktop.Notifications.CloseNotification",
        id,
      ],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // gdbus may not be available (e.g. WSL without D-Bus)
  }
}
