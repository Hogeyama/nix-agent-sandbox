/**
 * nas config サブコマンド
 */

import { initConfig } from "../config/init.ts";
import { migrateYml2Pkl } from "../config/migrate.ts";
import { getFlagValue } from "./helpers.ts";

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

  if (sub === "migrate") {
    const migrateArgs = args.slice(args.indexOf("migrate") + 1);
    const migrateSub = migrateArgs.find((a) => !a.startsWith("-"));

    if (migrateSub !== "yml2pkl") {
      throw new Error(
        `Unknown migrate subcommand: ${migrateSub ?? "(none)"}. Available subcommands: yml2pkl`,
      );
    }

    const global = args.includes("--global");
    const inputPath = getFlagValue(args, "--input") ?? undefined;
    const force = args.includes("--force") || args.includes("-f");

    const result = await migrateYml2Pkl({ global, inputPath, force });

    if (result.scaffoldResult) {
      for (const f of result.scaffoldResult.written) {
        console.log(`  created: ${f}`);
      }
      for (const f of result.scaffoldResult.skipped) {
        console.log(`  skipped: ${f} (already exists)`);
      }
    }
    console.log(`  converted: ${result.inputPath} -> ${result.outputPath}`);
    return;
  }

  throw new Error(
    `Unknown config subcommand: ${sub ?? "(none)"}. Available subcommands: init, migrate`,
  );
}
