import type { HostExecPendingEntry } from "./types.ts";
import {
  closeNotification,
  type DesktopNotificationOptions,
  type NotifyBackend,
  tryDesktopNotification,
} from "../lib/notify_utils.ts";
import { ensureUiDaemon } from "../ui/daemon.ts";

export type HostExecNotifyBackend = NotifyBackend;
export { closeNotification };

export interface HostExecPendingNotification {
  backend: HostExecNotifyBackend;
  pending: HostExecPendingEntry;
  uiPort?: number;
  signal?: AbortSignal;
}

export async function notifyHostExecPendingRequest(
  notification: HostExecPendingNotification,
): Promise<void> {
  if (notification.backend === "off") return;
  const uiBaseUrl = await ensureUiDaemon(notification.uiPort);
  const deepLinkUrl = new URL("/", uiBaseUrl);
  deepLinkUrl.searchParams.set("type", "hostexec");
  deepLinkUrl.searchParams.set("sessionId", notification.pending.sessionId);
  deepLinkUrl.searchParams.set("requestId", notification.pending.requestId);
  const deepLink = deepLinkUrl.href;
  const message = formatMessage(notification.pending);
  await tryDesktopNotification({
    ...message,
    uiUrl: deepLink,
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
      "クリックでUIを開く",
    ].join("\n"),
  };
}

function formatCommand(pending: HostExecPendingEntry): string {
  return [pending.argv0, ...pending.args].join(" ");
}
