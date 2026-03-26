import type { HostExecPendingEntry } from "./types.ts";
import {
  type CliActionNotificationOptions,
  closeNotification,
  type DesktopNotificationOptions,
  type NotifyBackend,
  tryCliActionNotification,
  tryDesktopNotification,
} from "../lib/notify_utils.ts";
import { ensureUiDaemon } from "../ui/daemon.ts";

export type HostExecNotifyBackend = NotifyBackend;
export { closeNotification };

export interface HostExecPendingNotification {
  backend: HostExecNotifyBackend;
  pending: HostExecPendingEntry;
  uiEnabled?: boolean;
  uiPort?: number;
  uiIdleTimeout?: number;
  signal?: AbortSignal;
}

export async function notifyHostExecPendingRequest(
  notification: HostExecPendingNotification,
): Promise<void> {
  if (notification.backend === "off") return;

  if (notification.uiEnabled === false) {
    await notifyWithCliActions(notification);
  } else {
    await notifyWithUiOpen(notification);
  }
}

async function notifyWithUiOpen(
  notification: HostExecPendingNotification,
): Promise<void> {
  const uiBaseUrl = await ensureUiDaemon({
    port: notification.uiPort,
    idleTimeout: notification.uiIdleTimeout,
  });
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

async function notifyWithCliActions(
  notification: HostExecPendingNotification,
): Promise<void> {
  const message = formatMessage(notification.pending);
  const options: CliActionNotificationOptions = {
    ...message,
    approveArgs: [
      "hostexec",
      "approve",
      notification.pending.sessionId,
      notification.pending.requestId,
    ],
    denyArgs: [
      "hostexec",
      "deny",
      notification.pending.sessionId,
      notification.pending.requestId,
    ],
    signal: notification.signal,
  };
  await tryCliActionNotification(options);
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
    ].join("\n"),
  };
}

function formatCommand(pending: HostExecPendingEntry): string {
  return [pending.argv0, ...pending.args].join(" ");
}
