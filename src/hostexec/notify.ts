import type { HostExecPendingEntry } from "./types.ts";

export type HostExecNotifyBackend = "auto" | "tmux" | "desktop" | "off";

export interface HostExecPendingNotification {
  backend: HostExecNotifyBackend;
  brokerSocket: string;
  pending: HostExecPendingEntry;
  signal?: AbortSignal;
}

export async function notifyHostExecPendingRequest(
  notification: HostExecPendingNotification,
): Promise<void> {
  if (notification.backend === "off") return;
  if (notification.backend === "tmux") {
    await tryTmux(notification);
    return;
  }
  if (notification.backend === "desktop") {
    await tryDesktop(notification);
    return;
  }
  if (!hasDesktopSession()) {
    await tryTmux(notification);
    return;
  }
  if (await tryDesktop(notification)) {
    return;
  }
  if (notification.signal?.aborted) return;
  await tryTmux(notification);
}

async function tryTmux(
  notification: HostExecPendingNotification,
): Promise<boolean> {
  if (!Deno.env.get("TMUX")) return false;
  const command = formatCommand(notification.pending);
  const base =
    `nas hostexec approve ${notification.pending.sessionId} ${notification.pending.requestId}`;
  const denyCmd =
    `nas hostexec deny ${notification.pending.sessionId} ${notification.pending.requestId}`;
  const script = `
printf '\\033[1m[nas] Pending hostexec approval\\033[0m\\n\\n'
printf '  Rule:    %s\\n' ${shellQuote(notification.pending.ruleId)}
printf '  Command: %s\\n' ${shellQuote(command)}
printf '  Cwd:     %s\\n' ${shellQuote(notification.pending.cwd)}
printf '  Session: %s\\n\\n' ${shellQuote(notification.pending.sessionId)}
printf '  [a] Approve (remember)\\n'
printf '  [o] Approve (once)\\n'
printf '  [d] Deny\\n'
printf '  [q] Close (request stays pending)\\n\\n'
printf 'Choice: '
read -r choice
case "$choice" in
  a|A) ${base} --scope capability ;;
  o|O) ${base} --scope once ;;
  d|D) ${denyCmd} ;;
esac
`;
  const result = await new Deno.Command("tmux", {
    args: [
      "display-popup",
      "-w",
      "90",
      "-h",
      "16",
      "-E",
      "sh",
      "-c",
      script,
    ],
    signal: notification.signal,
    stdout: "null",
    stderr: "null",
  }).output().catch(() => ({ success: false } as Deno.CommandOutput));
  return result.success;
}

let lastDesktopNotificationId: string | null = null;

async function tryDesktop(
  notification: HostExecPendingNotification,
): Promise<boolean> {
  if (notification.signal?.aborted) return false;
  const message = formatMessage(notification.pending);
  const child = new Deno.Command("notify-send", {
    args: [
      "--print-id",
      "--wait",
      "--expire-time=0",
      "--action=default=Allow",
      "--action=deny=Deny",
      message.title,
      message.body,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  };
  notification.signal?.addEventListener("abort", onAbort);

  try {
    const { action } = await readNotifySendOutput(child.stdout);
    const status = await child.status;
    lastDesktopNotificationId = null;

    if (!status.success) return false;

    if (action === "allow" || action === "default") {
      await sendBrokerDecision(notification.brokerSocket, {
        type: "approve",
        requestId: notification.pending.requestId,
      });
      return true;
    }
    if (action === "deny" || action === "") {
      await sendBrokerDecision(notification.brokerSocket, {
        type: "deny",
        requestId: notification.pending.requestId,
      });
      return true;
    }
    return status.success;
  } finally {
    notification.signal?.removeEventListener("abort", onAbort);
    lastDesktopNotificationId = null;
  }
}

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

function hasDesktopSession(): boolean {
  return Boolean(
    Deno.env.get("DISPLAY") ||
      Deno.env.get("WAYLAND_DISPLAY"),
  );
}

function formatMessage(pending: HostExecPendingEntry) {
  return {
    title: `[nas] Pending hostexec approval: ${pending.sessionId}`,
    body: [
      `rule: ${pending.ruleId}`,
      `cmd: ${formatCommand(pending)}`,
      `cwd: ${pending.cwd}`,
      "クリックでapprove / 閉じるとdeny",
    ].join("\n"),
  };
}

function formatCommand(pending: HostExecPendingEntry): string {
  return [pending.argv0, ...pending.args].join(" ");
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

export async function closeNotification(): Promise<void> {
  const capturedId = lastDesktopNotificationId;
  // tmux popup を閉じる
  if (Deno.env.get("TMUX")) {
    await new Deno.Command("tmux", {
      args: ["display-popup", "-C"],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {});
  }
  // desktop notification を閉じる
  if (capturedId) {
    await closeDesktopNotification(capturedId);
  }
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
