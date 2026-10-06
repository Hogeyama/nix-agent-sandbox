import { spawn } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import type { Pending } from "../core/approval.ts";
import type { NotifyMode } from "../core/config.ts";
import type { SessionInfo } from "../core/session.ts";

/** Best effort: tell the user a request is held, the way `mode` asks. */
export function notifier(
  session: SessionInfo,
  mode: NotifyMode,
): (p: Pending) => void {
  if (mode === "desktop") return desktop(session);
  if (mode === "off") return () => {};
  const sequence = terminalSequence(session, mode);
  return () => writeTty(sequence);
}

/** A desktop notification, naming the session, if notify-send exists. */
function desktop(session: SessionInfo): (p: Pending) => void {
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

/**
 * What goes to the terminal. The text is fixed and names only the session:
 * the URL and the reason come from the sandbox, and written here they could
 * carry escape sequences of their own. OSC 9 is the notification iTerm2,
 * WezTerm, kitty, Ghostty and Windows Terminal show; inside tmux it reaches
 * the outer terminal only through DCS passthrough (`allow-passthrough on`).
 */
export function terminalSequence(
  session: Pick<SessionInfo, "id" | "tmuxPane">,
  mode: "terminal" | "bell",
): string {
  if (mode === "bell") return "\x07";
  const text = `strait ${session.id}: approval needed`.replace(
    /[^\x20-\x7e]/g,
    "?",
  );
  const osc = `\x1b]9;${text}\x07`;
  if (session.tmuxPane === undefined) return osc;
  return `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

// One write, so the sequence does not land in pieces between the agent's own.
function writeTty(sequence: string) {
  let tty: number;
  try {
    tty = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  } catch {
    return;
  }
  try {
    writeSync(tty, sequence);
  } catch {
  } finally {
    closeSync(tty);
  }
}
