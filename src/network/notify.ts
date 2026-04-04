import type { NormalizedTarget } from "./protocol.ts";
import {
  type CliActionNotificationOptions,
  closeNotification,
  type DesktopNotificationOptions,
  type ResolvedNotifyBackend,
  tryCliActionNotification,
  tryDesktopNotification,
} from "../lib/notify_utils.ts";
import { ensureUiDaemon } from "../ui/daemon.ts";

export type { ResolvedNotifyBackend };
export { closeNotification };

export interface PendingNotification {
  backend: ResolvedNotifyBackend;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
  uiEnabled?: boolean;
  uiPort?: number;
  uiIdleTimeout?: number;
  signal?: AbortSignal;
}

export async function notifyPendingRequest(
  notification: PendingNotification,
): Promise<void> {
  if (notification.backend === "off") return;

  if (notification.uiEnabled === false) {
    await notifyWithCliActions(notification);
  } else {
    await notifyWithUiOpen(notification);
  }
}

async function notifyWithUiOpen(
  notification: PendingNotification,
): Promise<void> {
  const uiBaseUrl = await ensureUiDaemon({
    port: notification.uiPort,
    idleTimeout: notification.uiIdleTimeout,
  });
  const deepLinkUrl = new URL("/", uiBaseUrl);
  deepLinkUrl.searchParams.set("type", "network");
  deepLinkUrl.searchParams.set("sessionId", notification.sessionId);
  deepLinkUrl.searchParams.set("requestId", notification.requestId);
  const deepLink = deepLinkUrl.href;
  const message = formatMessage(notification);
  await tryDesktopNotification({
    ...message,
    uiUrl: deepLink,
    signal: notification.signal,
  });
}

async function notifyWithCliActions(
  notification: PendingNotification,
): Promise<void> {
  const message = formatMessage(notification);
  const options: CliActionNotificationOptions = {
    ...message,
    approveArgs: [
      "network",
      "approve",
      notification.sessionId,
      notification.requestId,
    ],
    denyArgs: [
      "network",
      "deny",
      notification.sessionId,
      notification.requestId,
    ],
    signal: notification.signal,
  };
  await tryCliActionNotification(options);
}

function formatMessage(
  notification: PendingNotification,
): Pick<DesktopNotificationOptions, "title" | "body"> {
  const target = `${notification.target.host}:${notification.target.port}`;
  return {
    title: `[nas] Pending network approval: ${notification.sessionId}`,
    body: notification.uiEnabled === false
      ? target
      : [target, "クリックでUIを開く"].join("\n"),
  };
}
