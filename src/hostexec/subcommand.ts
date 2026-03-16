import type { HostExecSubcommandConfig } from "../config/types.ts";

export function normalizeSubcommand(
  argv0: string,
  args: string[],
  config?: HostExecSubcommandConfig,
): string | null {
  const prefixOptionsWithValue = new Set(
    config?.prefixOptionsWithValue[argv0] ?? [],
  );
  const longPrefixOptionsWithValue = [...prefixOptionsWithValue].filter(
    (arg) => arg.startsWith("--"),
  );
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--") break;
    if (
      longPrefixOptionsWithValue.some((option) => arg.startsWith(`${option}=`))
    ) {
      continue;
    }
    if (prefixOptionsWithValue.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}
