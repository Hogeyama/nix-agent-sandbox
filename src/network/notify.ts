import type { NormalizedTarget } from "./protocol.ts";
import {
  closeNotification,
  type DesktopNotificationOptions,
  type NotifyBackend,
  tryDesktopNotification,
} from "../lib/notify_utils.ts";
import { ensureUiDaemon } from "../ui/daemon.ts";

export type { NotifyBackend };
export { closeNotification };

export interface PendingNotification {
  backend: NotifyBackend;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
  uiPort?: number;
  signal?: AbortSignal;
}

export async function notifyPendingRequest(
  notification: PendingNotification,
): Promise<void> {
  if (notification.backend === "off") return;
  const uiBaseUrl = await ensureUiDaemon(notification.uiPort);
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

function formatMessage(
  notification: PendingNotification,
): Pick<DesktopNotificationOptions, "title" | "body"> {
  const target = `${notification.target.host}:${notification.target.port}`;
  return {
    title: `[nas] Pending network approval: ${notification.sessionId}`,
    body: [
      `${target}`,
      "クリックでUIを開く",
    ].join("\n"),
  };
}
