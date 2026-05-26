/**
 * nas config サブコマンド
 */

import { initConfig } from "../config/init.ts";

export async function runConfigCommand(args: string[]): Promise<void> {
  const sub = args.find((a) => !a.startsWith("-"));

  if (sub === "init") {
    const projectDir = process.cwd();
    const result = await initConfig({ projectDir });
    for (const f of result.written) {
      console.log(`  created: ${f}`);
    }
    for (const f of result.skipped) {
      console.log(`  skipped: ${f} (already exists)`);
    }
    return;
  }

  throw new Error(
    `Unknown config subcommand: ${sub ?? "(none)"}. Available subcommands: init`,
  );
}
