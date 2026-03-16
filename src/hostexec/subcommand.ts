const GIT_PREFIX_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

const GH_PREFIX_OPTIONS_WITH_VALUE = new Set([
  "--repo",
  "-R",
  "--hostname",
]);

export function normalizeSubcommand(
  argv0: string,
  args: string[],
): string | null {
  if (argv0 === "git") return findGitSubcommand(args);
  if (argv0 === "gh") return findGhSubcommand(args);
  return findGenericSubcommand(args);
}

function findGitSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--") break;
    if (
      arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=") || arg.startsWith("--super-prefix=") ||
      arg.startsWith("--config-env=")
    ) {
      continue;
    }
    if (GIT_PREFIX_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return null;
}

function findGhSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--") break;
    if (arg.startsWith("--repo=") || arg.startsWith("--hostname=")) {
      continue;
    }
    if (GH_PREFIX_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function findGenericSubcommand(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}
