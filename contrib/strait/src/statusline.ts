// Showing the strait session in Claude Code's status line.
//
// When the command is `claude`, strait passes `--settings` with a statusLine
// whose command is strait-statusline. That script prints `[strait:<id>]` and
// then runs the status line the user already had, which strait finds here
// and hands over in STRAIT_STATUSLINE_INNER. `"statusLine": false` in
// strait.json turns this off.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface StatusLine {
  type?: string;
  command?: string;
  padding?: number;
  [key: string]: unknown;
}

/**
 * The status line Claude Code would use, from the settings files that can set
 * one, highest precedence first. Managed settings are not read: a status line
 * set there cannot be overridden anyway.
 */
export function findStatusLine(
  cwd: string,
  env: NodeJS.ProcessEnv,
  read: (path: string) => string | undefined = readIfExists,
): StatusLine | undefined {
  const userDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  for (const path of [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(userDir, "settings.json"),
  ]) {
    const text = read(path);
    if (text === undefined) continue;
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      continue;
    }
    const s = (settings as { statusLine?: unknown } | null)?.statusLine;
    if (typeof s === "object" && s !== null && !Array.isArray(s)) {
      return s as StatusLine;
    }
  }
  return undefined;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface Wrapped {
  command: string[];
  /** Added to the sandboxed process's environment. */
  env: Record<string, string>;
}

/**
 * `command` with the status line replaced, or unchanged when it is not Claude
 * Code. `--settings` goes right after the program name, so a `--settings`
 * the user passed later still takes effect.
 */
export function wrapStatusLine(
  command: string[],
  original: StatusLine | undefined,
  wrapper: string,
): Wrapped {
  const [program, ...rest] = command;
  if (program === undefined || basename(program) !== "claude") {
    return { command, env: {} };
  }
  const settings = {
    statusLine: { ...original, type: "command", command: wrapper },
  };
  const inner =
    original?.type === "command" && typeof original.command === "string"
      ? original.command
      : undefined;
  return {
    command: [program, "--settings", JSON.stringify(settings), ...rest],
    env: inner === undefined ? {} : { STRAIT_STATUSLINE_INNER: inner },
  };
}
