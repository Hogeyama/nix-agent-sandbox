import { spawn } from "node:child_process";
import type { Pending } from "../core/approval.ts";
import type { SessionInfo } from "../core/session.ts";

/** Best effort: a desktop notification, naming the session, if notify-send exists. */
export function notifier(session: SessionInfo): (p: Pending) => void {
  return (p) => {
    try {
      const child = spawn(
        "notify-send",
        [
          `strait ${session.id}: approval needed`,
          `${p.method} ${p.url}\n${p.reason}`,
        ],
        { stdio: "ignore", detached: true },
      );
      child.on("error", () => {});
      child.unref();
    } catch {}
  };
}
