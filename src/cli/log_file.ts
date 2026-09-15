/** Consume nas's log option only in the control prefix. */
export function extractLogFile(args: readonly string[]): {
  args: string[];
  logFile?: string;
} {
  const result: string[] = [];
  let logFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" || !arg.startsWith("-")) {
      result.push(...args.slice(i));
      break;
    }
    if (arg === "--log-file" || arg.startsWith("--log-file=")) {
      const value = arg === "--log-file" ? args[++i] : arg.slice(11);
      if (!value || value.startsWith("-")) {
        throw new Error("--log-file requires a path.");
      }
      logFile = value;
      continue;
    }
    result.push(arg);
    if (
      [
        "--name",
        "--worktree",
        "-b",
        "--scope",
        "--runtime-dir",
        "--port",
        "--since",
        "--session",
        "--domain",
        "--audit-dir",
        "--format",
      ].includes(arg) &&
      i + 1 < args.length
    ) {
      result.push(args[++i]);
    }
  }
  return { args: result, logFile };
}
