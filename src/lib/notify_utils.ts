/**
 * Shared low-level utilities for desktop/tmux notification systems.
 * Used by both network/notify.ts and hostexec/notify.ts.
 */

import { logWarn } from "../log.ts";

export type NotifyBackend = "auto" | "desktop" | "off";

// Module-level state for tracking the active desktop notification ID.
// Only one notification is active at a time across the process.
let lastDesktopNotificationId: string | null = null;
let notifySendMissingWarned = false;

export interface DesktopNotificationOptions {
  title: string;
  body: string;
  brokerSocket: string;
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Show a desktop notification via notify-send and send the user's
 * decision (approve/deny) to the broker socket.
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
        "--action=default=Allow",
        "--action=deny=Deny",
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

    if (action === "allow" || action === "default") {
      await sendBrokerDecision(options.brokerSocket, {
        type: "approve",
        requestId: options.requestId,
      });
      return true;
    }
    if (action === "deny" || action === "") {
      await sendBrokerDecision(options.brokerSocket, {
        type: "deny",
        requestId: options.requestId,
      });
      return true;
    }
    return status.success;
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

export function hasDesktopSession(): boolean {
  return Boolean(
    Deno.env.get("DISPLAY") ||
      Deno.env.get("WAYLAND_DISPLAY") ||
      isWSL(),
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

async function sendBrokerDecision(
  socketPath: string,
  message: { type: "approve"; requestId: string } | {
    type: "deny";
    requestId: string;
  },
): Promise<void> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    await conn.write(
      new TextEncoder().encode(JSON.stringify(message) + "\n"),
    );
    const response = await readJsonLine(conn);
    if (!response) {
      throw new Error("empty broker response");
    }
    const ack = JSON.parse(response) as {
      type?: string;
      decision?: string;
      requestId?: string;
    };
    if (ack.type !== "ack" || ack.requestId !== message.requestId) {
      throw new Error("invalid broker response");
    }
  } finally {
    conn.close();
  }
}

async function readJsonLine(conn: Deno.Conn): Promise<string | null> {
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(1);
  while (true) {
    const bytesRead = await conn.read(buffer);
    if (bytesRead === null) {
      if (chunks.length === 0) return null;
      break;
    }
    if (buffer[0] === 0x0a) break;
    chunks.push(buffer.slice(0, bytesRead));
  }
  return decoder.decode(concatChunks(chunks));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
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
