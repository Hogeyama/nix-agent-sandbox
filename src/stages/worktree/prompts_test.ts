/**
 * Pure prompt logic tests. Exercises branch paths including stdin-closed
 * fallbacks, whitespace tolerance, and invalid-input loops.
 */

import { beforeEach, expect, test } from "bun:test";
import type { WorktreeEntry } from "./git_worktree.ts";
import {
  promptBranchAction,
  promptDirtyWorktreeAction,
  promptReuseWorktree,
  promptWorktreeAction,
} from "./prompts.ts";

function mockPrompt(answers: (string | null)[]): {
  restore: () => void;
  unused: () => number;
} {
  const original = globalThis.prompt;
  let idx = 0;
  Object.defineProperty(globalThis, "prompt", {
    configurable: true,
    writable: true,
    value: () => {
      if (idx >= answers.length) {
        throw new Error("Unexpected prompt call");
      }
      return answers[idx++];
    },
  });
  return {
    restore: () => {
      Object.defineProperty(globalThis, "prompt", {
        configurable: true,
        writable: true,
        value: original,
      });
    },
    unused: () => answers.length - idx,
  };
}

let logs: string[] = [];
const realLog = console.log;
beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});
function restoreLog() {
  console.log = realLog;
}

// ---------------------------------------------------------------------------
// promptWorktreeAction
// ---------------------------------------------------------------------------

test("promptWorktreeAction: '1' returns delete", () => {
  const m = mockPrompt(["1"]);
  try {
    expect(promptWorktreeAction("/w", false)).toEqual("delete");
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptWorktreeAction: '2' returns keep", () => {
  const m = mockPrompt(["2"]);
  try {
    expect(promptWorktreeAction("/w", false)).toEqual("keep");
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptWorktreeAction: whitespace is trimmed", () => {
  const m = mockPrompt(["  1 "]);
  try {
    expect(promptWorktreeAction("/w", false)).toEqual("delete");
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptWorktreeAction: null (stdin closed) falls back to keep", () => {
  const m = mockPrompt([null]);
  try {
    expect(promptWorktreeAction("/w", false)).toEqual("keep");
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptWorktreeAction: invalid answer repeats until valid", () => {
  const m = mockPrompt(["x", "", "1"]);
  try {
    expect(promptWorktreeAction("/w", false)).toEqual("delete");
    expect(m.unused()).toEqual(0);
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptWorktreeAction: dirty flag prints warning header", () => {
  const m = mockPrompt(["2"]);
  try {
    promptWorktreeAction("/w", true);
    expect(logs.some((l) => l.includes("uncommitted changes"))).toEqual(true);
  } finally {
    m.restore();
    restoreLog();
  }
});

// ---------------------------------------------------------------------------
// promptDirtyWorktreeAction
// ---------------------------------------------------------------------------

test("promptDirtyWorktreeAction: '1' → stash, '2' → delete, '3' → keep", () => {
  for (const [input, expected] of [
    ["1", "stash"],
    ["2", "delete"],
    ["3", "keep"],
  ] as const) {
    const m = mockPrompt([input]);
    try {
      expect(promptDirtyWorktreeAction("/w")).toEqual(expected);
    } finally {
      m.restore();
      restoreLog();
    }
  }
});

test("promptDirtyWorktreeAction: null falls back to keep", () => {
  const m = mockPrompt([null]);
  try {
    expect(promptDirtyWorktreeAction("/w")).toEqual("keep");
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptDirtyWorktreeAction: invalid input loops", () => {
  const m = mockPrompt(["bad", "4", "2"]);
  try {
    expect(promptDirtyWorktreeAction("/w")).toEqual("delete");
    expect(m.unused()).toEqual(0);
  } finally {
    m.restore();
    restoreLog();
  }
});

// ---------------------------------------------------------------------------
// promptBranchAction
// ---------------------------------------------------------------------------

test("promptBranchAction: null branch name auto-deletes (no prompt)", () => {
  // mockPrompt with zero answers catches any accidental prompt() call.
  const m = mockPrompt([]);
  try {
    expect(promptBranchAction(null, ["some commit"])).toEqual("delete");
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptBranchAction: no unique commits auto-deletes (no prompt)", () => {
  const m = mockPrompt([]);
  try {
    expect(promptBranchAction("nas/foo", [])).toEqual("delete");
    expect(
      logs.some((l) => l.includes("No unique commits on nas/foo")),
    ).toEqual(true);
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptBranchAction: user picks 1/2/3 → delete/cherry-pick/rename", () => {
  const commits = ["abc123 feat: x"];
  for (const [input, expected] of [
    ["1", "delete"],
    ["2", "cherry-pick"],
    ["3", "rename"],
  ] as const) {
    const m = mockPrompt([input]);
    try {
      expect(promptBranchAction("nas/foo", commits)).toEqual(expected);
    } finally {
      m.restore();
      restoreLog();
    }
  }
});

test("promptBranchAction: null (stdin closed) falls back to rename", () => {
  const m = mockPrompt([null]);
  try {
    expect(promptBranchAction("nas/foo", ["abc123 feat"])).toEqual("rename");
  } finally {
    m.restore();
    restoreLog();
  }
});

// ---------------------------------------------------------------------------
// promptReuseWorktree
// ---------------------------------------------------------------------------

function entry(path: string, branch: string): WorktreeEntry {
  return { path, head: "sha", branch, base: null };
}

test("promptReuseWorktree: '0' creates new (returns null)", () => {
  const entries = [entry("/a", "refs/heads/nas/a")];
  const m = mockPrompt(["0"]);
  try {
    expect(promptReuseWorktree(entries)).toEqual(null);
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptReuseWorktree: empty answer is equivalent to 0", () => {
  const entries = [entry("/a", "refs/heads/nas/a")];
  const m = mockPrompt([""]);
  try {
    expect(promptReuseWorktree(entries)).toEqual(null);
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptReuseWorktree: selects the nth entry (1-based)", () => {
  const entries = [
    entry("/a", "refs/heads/nas/a"),
    entry("/b", "refs/heads/nas/b"),
  ];
  const m = mockPrompt(["2"]);
  try {
    expect(promptReuseWorktree(entries)).toEqual(entries[1]);
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptReuseWorktree: out-of-range input loops until valid", () => {
  const entries = [entry("/a", "refs/heads/nas/a")];
  const m = mockPrompt(["5", "-1", "abc", "1"]);
  try {
    expect(promptReuseWorktree(entries)).toEqual(entries[0]);
    expect(m.unused()).toEqual(0);
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptReuseWorktree: null (stdin closed) returns null (create new)", () => {
  const entries = [entry("/a", "refs/heads/nas/a")];
  const m = mockPrompt([null]);
  try {
    expect(promptReuseWorktree(entries)).toEqual(null);
  } finally {
    m.restore();
    restoreLog();
  }
});

test("promptReuseWorktree: '(detached)' label used when branch is empty", () => {
  const entries = [entry("/a", "")];
  const m = mockPrompt(["0"]);
  try {
    promptReuseWorktree(entries);
    expect(logs.some((l) => l.includes("(detached)"))).toEqual(true);
  } finally {
    m.restore();
    restoreLog();
  }
});
