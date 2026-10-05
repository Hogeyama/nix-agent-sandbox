// Pass terminal resizes on to the sandboxed command.
//
// srt runs bwrap with --new-session, so the command runs in a session of its
// own with no controlling terminal. The kernel sends SIGWINCH to the
// terminal's foreground process group, which holds strait and bwrap but not
// the command, so without this a resize never reaches it. The terminal's size
// itself is updated; the command only needs to be told to read it again.
//
// The target is found by session, walking down from the process strait
// spawned: a pid seen inside the sandbox's pid namespace is not its pid here.
// Only descendants of that process are signalled, and SIGWINCH is ignored by
// default, so a pid reused in between comes to no harm.

import { readdirSync, readFileSync } from "node:fs";

export interface Proc {
  pid: number;
  ppid: number;
  pgrp: number;
  sid: number;
}

/**
 * The process groups to signal: for each branch below `root` (itself
 * included), the first process whose session is not `sid`. Sessions started
 * further down, by the command itself, are left alone.
 */
export function winchTargets(
  procs: readonly Proc[],
  root: number,
  sid: number,
): number[] {
  const children = new Map<number, Proc[]>();
  let start: Proc | undefined;
  for (const p of procs) {
    if (p.pid === root) start = p;
    const siblings = children.get(p.ppid);
    if (siblings) siblings.push(p);
    else children.set(p.ppid, [p]);
  }
  if (!start) return [];
  const targets = new Set<number>();
  const queue = [start];
  for (let p = queue.shift(); p; p = queue.shift()) {
    if (p.sid !== sid) targets.add(p.pgrp);
    else queue.push(...(children.get(p.pid) ?? []));
  }
  return [...targets];
}

/** Parse `/proc/<pid>/stat`. The command name may hold spaces and parens. */
export function parseStat(stat: string): Proc | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const pid = Number.parseInt(stat, 10);
  // After the name: state, ppid, pgrp, session.
  const [, ppid, pgrp, sid] = stat
    .slice(close + 2)
    .split(" ")
    .map(Number);
  if (![pid, ppid, pgrp, sid].every(Number.isInteger)) return undefined;
  return { pid, ppid, pgrp, sid } as Proc;
}

function readProcs(): Proc[] {
  const procs: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const p = parseStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      if (p) procs.push(p);
    } catch {
      // Gone since the listing.
    }
  }
  return procs;
}

/** Send SIGWINCH to the sessions started below `root`. */
export function forwardWinch(root: number): void {
  let procs: Proc[];
  try {
    procs = readProcs();
  } catch {
    return; // No /proc: nothing to do but leave the resize undelivered.
  }
  const own = procs.find((p) => p.pid === process.pid);
  if (!own) return;
  for (const pgrp of winchTargets(procs, root, own.sid)) {
    try {
      process.kill(-pgrp, "SIGWINCH");
    } catch {}
  }
}
