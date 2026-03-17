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
  await tryTmux(notification);
}

async function tryTmux(
  notification: HostExecPendingNotification,
): Promise<boolean> {
  if (!Deno.env.get("TMUX")) return false;
  const command = formatCommand(notification.pending);
  const approveCmd =
    `nas hostexec approve ${notification.pending.sessionId} ${notification.pending.requestId}`;
  const script = `
printf '\\033[1m[nas] Pending hostexec approval\\033[0m\\n\\n'
printf '  Rule:    %s\\n' ${shellQuote(notification.pending.ruleId)}
printf '  Command: %s\\n' ${shellQuote(command)}
printf '  Cwd:     %s\\n' ${shellQuote(notification.pending.cwd)}
printf '  Session: %s\\n\\n' ${shellQuote(notification.pending.sessionId)}
printf '  [a] Approve\\n'
printf '  [d] Deny\\n'
printf '  [q] Close (request stays pending)\\n\\n'
printf 'Choice: '
read -r choice
case "$choice" in
  a|A) ${approveCmd} ;;
  d|D) nas hostexec deny ${notification.pending.sessionId} ${notification.pending.requestId} ;;
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

async function tryDesktop(
  notification: HostExecPendingNotification,
): Promise<boolean> {
  const message = formatMessage(notification.pending);
  const result = await new Deno.Command("notify-send", {
    args: [
      "--wait",
      "--expire-time=0",
      "--action=default=Allow",
      "--action=deny=Deny",
      message.title,
      message.body,
    ],
    signal: notification.signal,
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => ({ success: false } as Deno.CommandOutput));
  if (!result.success) {
    return false;
  }
  const action = new TextDecoder().decode(result.stdout).trim();
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
  return result.success;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
