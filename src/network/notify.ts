import type { NormalizedTarget } from "./protocol.ts";

export type NotifyBackend = "auto" | "tmux" | "desktop" | "off";

export interface PendingNotification {
  backend: NotifyBackend;
  brokerSocket: string;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
}

export async function notifyPendingRequest(
  notification: PendingNotification,
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
  if (await tryDesktop(notification)) {
    return;
  }
  await tryTmux(notification);
}

async function tryTmux(
  notification: PendingNotification,
): Promise<boolean> {
  if (!Deno.env.get("TMUX")) return false;
  const target = `${notification.target.host}:${notification.target.port}`;
  const approveCmd =
    `nas network approve ${notification.sessionId} ${notification.requestId}`;
  const approveCmdHost =
    `nas network approve ${notification.sessionId} ${notification.requestId} --scope host`;
  const script = `
printf '\\033[1m[nas] Pending network approval\\033[0m\\n\\n'
printf '  Target:  %s\\n' ${shellQuote(target)}
printf '  Session: %s\\n\\n' ${shellQuote(notification.sessionId)}
printf '  [a] Approve (this host:port)\\n'
printf '  [h] Approve (all ports for this host)\\n'
printf '  [d] Deny\\n'
printf '  [q] Close (request stays pending)\\n\\n'
printf 'Choice: '
read -r choice
case "$choice" in
  a|A) ${approveCmd} ;;
  h|H) ${approveCmdHost} ;;
  d|D) nas network deny ${notification.sessionId} ${notification.requestId} ;;
esac
`;
  const result = await new Deno.Command("tmux", {
    args: [
      "display-popup",
      "-w",
      "70",
      "-h",
      "14",
      "-E",
      "sh",
      "-c",
      script,
    ],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => ({ success: false } as Deno.CommandOutput));
  return result.success;
}

async function tryDesktop(
  notification: PendingNotification,
): Promise<boolean> {
  const message = formatMessage(notification);
  const result = await new Deno.Command("notify-send", {
    args: [
      "--wait",
      "--expire-time=0",
      "--action=default=Allow",
      "--action=deny=Deny",
      message.title,
      message.body,
    ],
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
      requestId: notification.requestId,
    });
    return true;
  }
  if (action === "deny" || action === "") {
    await sendBrokerDecision(notification.brokerSocket, {
      type: "deny",
      requestId: notification.requestId,
    });
    return true;
  }
  return result.success;
}

function formatMessage(notification: PendingNotification) {
  const target = `${notification.target.host}:${notification.target.port}`;
  return {
    title: `[nas] Pending network approval: ${notification.sessionId}`,
    body: `${target}\nAllow で承認 / 閉じると deny`,
  };
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
