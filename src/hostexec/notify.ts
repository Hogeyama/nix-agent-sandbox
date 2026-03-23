import type { HostExecPendingEntry } from "./types.ts";
import {
  closeNotification,
  type DesktopNotificationOptions,
  hasDesktopSession,
  type NotifyBackend,
  shellQuote,
  tryDesktopNotification,
  tryTmuxPopup,
} from "../lib/notify_utils.ts";

export type HostExecNotifyBackend = NotifyBackend;
export { closeNotification };

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
  return await tryTmuxPopup({
    script,
    width: 90,
    height: 16,
    signal: notification.signal,
  });
}

async function tryDesktop(
  notification: HostExecPendingNotification,
): Promise<boolean> {
  const message = formatMessage(notification.pending);
  return await tryDesktopNotification({
    ...message,
    brokerSocket: notification.brokerSocket,
    requestId: notification.pending.requestId,
    signal: notification.signal,
  });
}

function formatMessage(
  pending: HostExecPendingEntry,
): Pick<DesktopNotificationOptions, "title" | "body"> {
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
