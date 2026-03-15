import type { NormalizedTarget } from "./protocol.ts";

export type NotifyBackend = "auto" | "tmux" | "desktop" | "off";

export interface PendingNotification {
  backend: NotifyBackend;
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
  if (await tryTmux(notification)) {
    return;
  }
  await tryDesktop(notification);
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
    args: [message.title, message.body],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => ({ success: false } as Deno.CommandOutput));
  return result.success;
}

function formatMessage(notification: PendingNotification) {
  const target = `${notification.target.host}:${notification.target.port}`;
  return {
    title: `[nas] Pending network approval: ${notification.sessionId}`,
    body:
      `${target}\nRun: nas network approve ${notification.sessionId} ${notification.requestId}`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
