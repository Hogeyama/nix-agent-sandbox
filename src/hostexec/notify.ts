import type { HostExecPendingEntry } from "./types.ts";
import {
  closeNotification,
  type DesktopNotificationOptions,
  type NotifyBackend,
  tryDesktopNotification,
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
  await tryDesktop(notification);
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
