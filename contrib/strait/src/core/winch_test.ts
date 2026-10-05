import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { forwardWinch, type Proc, parseStat, winchTargets } from "./winch.ts";

const p = (pid: number, ppid: number, pgrp: number, sid: number): Proc => ({
  pid,
  ppid,
  pgrp,
  sid,
});

describe("winchTargets", () => {
  test("signals the group of the first process in another session", () => {
    const procs = [
      p(10, 1, 10, 10), // strait
      p(11, 10, 10, 10), // sh -c
      p(12, 11, 10, 10), // bwrap
      p(13, 12, 13, 13), // bwrap's child after setsid
      p(14, 13, 13, 13), // the command
    ];
    expect(winchTargets(procs, 11, 10)).toEqual([13]);
  });

  test("leaves sessions the command starts itself alone", () => {
    const procs = [p(11, 10, 10, 10), p(13, 11, 13, 13), p(15, 13, 15, 15)];
    expect(winchTargets(procs, 11, 10)).toEqual([13]);
  });

  test("the root itself may be in another session", () => {
    expect(winchTargets([p(11, 10, 11, 11)], 11, 10)).toEqual([11]);
  });

  test("ignores processes outside the root's tree", () => {
    const procs = [p(11, 10, 10, 10), p(20, 1, 20, 20), p(21, 20, 21, 21)];
    expect(winchTargets(procs, 11, 10)).toEqual([]);
  });

  test("nothing when the root is gone", () => {
    expect(winchTargets([p(13, 12, 13, 13)], 11, 10)).toEqual([]);
  });
});

describe("parseStat", () => {
  test("reads ppid, pgrp and session after the name", () => {
    expect(parseStat("42 (bash) S 7 42 40 34816 42 4194304 ...")).toEqual(
      p(42, 7, 42, 40),
    );
  });

  test("a name with spaces and parens does not shift the fields", () => {
    expect(parseStat("42 (a ) b (c) S 7 8 9 0")).toEqual(p(42, 7, 8, 9));
  });

  test("rejects a malformed line", () => {
    expect(parseStat("garbage")).toBeUndefined();
    expect(parseStat("42 (x) S 7")).toBeUndefined();
  });
});

describe.skipIf(!existsSync("/proc/self/stat"))("forwardWinch", () => {
  test("reaches a process in a new session below the root", async () => {
    // detached: setsid, as bwrap's --new-session does.
    const child = spawn(
      "sh",
      [
        "-c",
        'trap "echo winch; exit 0" WINCH; echo ready; while :; do sleep 0.05; done',
      ],
      { detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    const ready = new Promise<void>((resolve) =>
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("ready")) resolve();
      }),
    );
    const exited = new Promise((resolve) => child.on("exit", resolve));
    try {
      await ready;
      forwardWinch(child.pid as number);
      await Promise.race([exited, Bun.sleep(5000)]);
      expect(out).toContain("winch");
    } finally {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {}
    }
  });
});
