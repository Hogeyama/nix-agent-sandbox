// Which strait session a held request came from.
//
// Several strait sessions often run in the same directory, and `strait review`
// shows the requests of all of them. The session ID ties a request to a
// terminal: the socket and every request ID carry it, the sandboxed process
// gets it as STRAIT_SESSION, and the wrapped Claude Code status line shows it
// (statusline.ts).

import { existsSync, readlinkSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { randomWord, removeSocket } from "./approval.ts";

export interface SessionInfo {
  id: string;
  cwd: string;
  command: string[];
  /** The controlling terminal, e.g. `/dev/pts/3`, when stdin is one. */
  tty?: string;
  /** `$TMUX_PANE`, e.g. `%12`, when started inside tmux. */
  tmuxPane?: string;
  /** Epoch milliseconds. */
  startedAt: number;
}

/** A name given with --name. No `-` at the end, so `<id>-<request>` stays unambiguous. */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9_])?$/;

export function isSessionId(s: string): boolean {
  return SESSION_ID.test(s);
}

export function newSessionId(): string {
  return randomWord(4);
}

export function sessionInfo(
  id: string,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): SessionInfo {
  let tty: string | undefined;
  try {
    const target = readlinkSync("/proc/self/fd/0");
    if (target.startsWith("/dev/pts/") || target.startsWith("/dev/tty")) {
      tty = target;
    }
  } catch {}
  return {
    id,
    cwd: process.cwd(),
    command,
    ...(tty ? { tty } : {}),
    ...(env.TMUX_PANE ? { tmuxPane: env.TMUX_PANE } : {}),
    startedAt: Date.now(),
  };
}

export const socketFor = (dir: string, id: string) => join(dir, `${id}.sock`);

/**
 * Take `<id>.sock` in `dir`. A socket someone answers on belongs to a running
 * session, so a second session with that name refuses to start; one nobody
 * answers on was left by a session that died, and is removed.
 */
export async function claimSocket(dir: string, id: string): Promise<string> {
  return (await claim(dir, id)) ?? fail(id);
}

/**
 * A generated ID that happens to be taken is simply drawn again; only a name
 * the user chose is an error when it is in use.
 */
export async function claimNewSocket(
  dir: string,
): Promise<{ id: string; path: string }> {
  for (;;) {
    const id = newSessionId();
    const path = await claim(dir, id);
    if (path !== undefined) return { id, path };
  }
}

function fail(id: string): never {
  throw new Error(`session ${id} is already running`);
}

async function claim(dir: string, id: string): Promise<string | undefined> {
  const path = socketFor(dir, id);
  if (existsSync(path)) {
    if (await answers(path)) return undefined;
    removeSocket(path);
  }
  return path;
}

function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}
