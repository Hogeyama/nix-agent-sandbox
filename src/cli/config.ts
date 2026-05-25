/**
 * nas config サブコマンド
 */

export async function runConfigCommand(args: string[]): Promise<void> {
  const sub = args.find((a) => !a.startsWith("-"));

  throw new Error(
    `Unknown config subcommand: ${sub ?? "(none)"}. Available subcommands: (none yet)`,
  );
}
