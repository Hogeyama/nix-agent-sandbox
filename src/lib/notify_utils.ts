/**
 * Shared low-level utilities for desktop notification systems.
 * Used by both network/notify.ts and hostexec/notify.ts.
 */

import * as path from "node:path";
import { statSync } from "node:fs";
import { logWarn } from "../log.ts";
import { resolveAsset } from "./asset.ts";

export type NotifyBackend = "auto" | "desktop" | "off";
export type ResolvedNotifyBackend = "desktop" | "off";

/**
 * Resolve "auto" to a concrete backend.
 * "auto" always resolves to "desktop". On WSL, the bundled notify-send-wsl
 * shim bridges to Windows toast notifications; on native Linux, the system
 * notify-send is used. If neither is available, tryDesktopNotification()
 * warns once and gracefully falls back to no-op.
 */
export function resolveNotifyBackend(
  backend: NotifyBackend,
): ResolvedNotifyBackend {
  if (backend === "off") return "off";
  return "desktop";
}

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
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([
      cmd,
      "--print-id",
      "--wait",
      "--expire-time=0",
      "--action=default=Open",
      options.title,
      options.body,
    ], {
      stdout: "pipe",
      stderr: "ignore",
      // NAS_NOTIFY_UI_URL is consumed by the WSL shim (scripts/notify-send-wsl)
      // so it can open `nas ui` in the Windows browser on click. Native Linux
      // notify-send ignores unknown env vars, so this is harmless there.
      env: { ...process.env, NAS_NOTIFY_UI_URL: options.uiUrl },
    });
  } catch {
    warnNotifySendMissing();
    return false;
  }

  const onAbort = () => {
    try {
      child.kill();
    } catch { /* already exited */ }
  };
  options.signal?.addEventListener("abort", onAbort);

  try {
    const { action } = await readNotifySendOutput(
      child.stdout as ReadableStream<Uint8Array>,
    );
    const code = await child.exited;
    lastDesktopNotificationId = null;

    if (code !== 0) return false;

    if (action === "default") {
      try {
        const xdgProc = Bun.spawn(["xdg-open", options.uiUrl], {
          stdout: "ignore",
          stderr: "ignore",
          env: process.env,
        });
        await xdgProc.exited;
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
  return Boolean(process.env["WSL_DISTRO_NAME"]);
}

/**
 * Resolve the nas command prefix (exec path + args for deno run if needed).
 * Used by CLI action notifications and daemon spawning.
 */
export function resolveNasCommand(): { execPath: string; prefix: string[] } {
  const execPath = process.execPath;
  const isCompiled = !path.basename(execPath).startsWith("bun");
  const prefix = isCompiled ? [] : [
    "run",
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
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([
      getNotifySendCommand(),
      "--print-id",
      "--wait",
      "--expire-time=0",
      "--action=approve=Approve",
      "--action=deny=Deny",
      options.title,
      options.body,
    ], {
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    });
  } catch {
    warnNotifySendMissing();
    return false;
  }

  const onAbort = () => {
    try {
      child.kill();
    } catch { /* already exited */ }
  };
  options.signal?.addEventListener("abort", onAbort);

  try {
    const { action } = await readNotifySendOutput(
      child.stdout as ReadableStream<Uint8Array>,
    );
    const code = await child.exited;
    lastDesktopNotificationId = null;

    if (code !== 0) return false;

    const { execPath, prefix } = resolveNasCommand();
    if (action === "approve") {
      try {
        const proc = Bun.spawn([execPath, ...prefix, ...options.approveArgs], {
          stdout: "ignore",
          stderr: "ignore",
          env: process.env,
        });
        await proc.exited;
      } catch { /* command may not be resolvable */ }
      return true;
    }
    if (action === "deny") {
      try {
        const proc = Bun.spawn([execPath, ...prefix, ...options.denyArgs], {
          stdout: "ignore",
          stderr: "ignore",
          env: process.env,
        });
        await proc.exited;
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
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    try {
      statSync(`${dir}/${cmd}`);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Resolve the path to the bundled notify-send-wsl script.
 * With Bun the file is always on a real filesystem (source tree or Nix store),
 * so no extraction to a temp file is needed.
 */
function extractWslShim(): string {
  return resolveAsset(
    "scripts/notify-send-wsl",
    import.meta.url,
    "../../scripts/notify-send-wsl",
  );
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
    const proc = Bun.spawn([
      "gdbus",
      "call",
      "--session",
      "--dest",
      "org.freedesktop.Notifications",
      "--object-path",
      "/org/freedesktop/Notifications",
      "--method",
      "org.freedesktop.Notifications.CloseNotification",
      id,
    ], {
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
    await proc.exited;
  } catch {
    // gdbus may not be available (e.g. WSL without D-Bus)
  }
}
