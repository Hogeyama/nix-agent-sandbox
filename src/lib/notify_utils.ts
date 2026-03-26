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
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("notify-send", {
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
    // notify-send not found in PATH
    if (isWSL() && !notifySendMissingWarned) {
      notifySendMissingWarned = true;
      logWarn(
        "[nas] notify-send not found. Install the WSL shim for desktop notifications:\n" +
          "      ln -s <repo>/scripts/notify-send-wsl ~/.local/bin/notify-send",
      );
    }
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
    child = new Deno.Command("notify-send", {
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
    if (isWSL() && !notifySendMissingWarned) {
      notifySendMissingWarned = true;
      logWarn(
        "[nas] notify-send not found. Install the WSL shim for desktop notifications:\n" +
          "      ln -s <repo>/scripts/notify-send-wsl ~/.local/bin/notify-send",
      );
    }
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
      await new Deno.Command(execPath, {
        args: [...prefix, ...options.approveArgs],
        stdout: "null",
        stderr: "null",
      }).output().catch(() => {});
      return true;
    }
    if (action === "deny") {
      await new Deno.Command(execPath, {
        args: [...prefix, ...options.denyArgs],
        stdout: "null",
        stderr: "null",
      }).output().catch(() => {});
      return true;
    }
    // Dismiss → do nothing
    return true;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    lastDesktopNotificationId = null;
  }
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
  }).output().catch(() => {});
}
