import type { NormalizedTarget } from "./protocol.ts";
import {
  closeNotification,
  type DesktopNotificationOptions,
  type NotifyBackend,
  tryDesktopNotification,
} from "../lib/notify_utils.ts";

export type { NotifyBackend };
export { closeNotification };

export interface PendingNotification {
  backend: NotifyBackend;
  brokerSocket: string;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
  signal?: AbortSignal;
}

export async function notifyPendingRequest(
  notification: PendingNotification,
): Promise<void> {
  if (notification.backend === "off") return;
  await tryDesktop(notification);
}

async function tryDesktop(
  notification: PendingNotification,
): Promise<boolean> {
  const message = formatMessage(notification);
  return await tryDesktopNotification({
    ...message,
    brokerSocket: notification.brokerSocket,
    requestId: notification.requestId,
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
      "クリックでapprove / 閉じるとdeny",
    ].join("\n"),
  };
}
