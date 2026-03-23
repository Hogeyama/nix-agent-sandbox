import type { NormalizedTarget } from "./protocol.ts";
import {
  closeNotification,
  type DesktopNotificationOptions,
  type NotifyBackend,
  shellQuote,
  tryDesktopNotification,
  tryTmuxPopup,
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
  if (notification.signal?.aborted) return;
  await tryTmux(notification);
}

async function tryTmux(
  notification: PendingNotification,
): Promise<boolean> {
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
  return await tryTmuxPopup({
    script,
    width: 70,
    height: 14,
    signal: notification.signal,
  });
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
