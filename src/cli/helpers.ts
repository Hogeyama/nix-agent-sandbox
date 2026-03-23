/**
 * CLI 共通ユーティリティ
 */

import { InterruptedCommandError } from "../docker/client.ts";

export function exitOnCliError(err: unknown): never {
  if (err instanceof InterruptedCommandError) {
    Deno.exit(err.exitCode);
  }
  console.error(`[nas] Error: ${(err as Error).message}`);
  Deno.exit(1);
}

export function removeFirstOccurrence(args: string[], value: string): string[] {
  const index = args.indexOf(value);
  if (index === -1) return [...args];
  return [...args.slice(0, index), ...args.slice(index + 1)];
}

export function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

export function positionalArgsAfterSubcommand(
  args: string[],
  subcommand: string,
): [string, string] {
  const positional = args.filter((arg, index) => {
    if (arg.startsWith("-")) return false;
    if (arg === subcommand) return false;
    if (
      index > 0 &&
      (args[index - 1] === "--scope" || args[index - 1] === "--runtime-dir")
    ) {
      return false;
    }
    return true;
  });
  if (positional.length < 2) {
    throw new Error(`${subcommand} requires <session-id> <request-id>`);
  }
  return [positional[0], positional[1]];
}

export type LogLevel = "info" | "warn";

export function parseLogLevel(args: string[]): LogLevel {
  return args.includes("--quiet") || args.includes("-q") ? "warn" : "info";
}

export function findFirstNonFlagArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--worktree" || arg === "-b") {
      i++;
      continue;
    }
    if (arg === "--scope" || arg === "--runtime-dir" || arg === "--port") {
      i++;
      continue;
    }
    if (arg === "--quiet" || arg === "-q") continue;
    if (arg.startsWith("-b") && arg.length > 2) continue;
    if (arg === "--no-worktree") continue;
    if (arg === "--no-open") continue;
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}
