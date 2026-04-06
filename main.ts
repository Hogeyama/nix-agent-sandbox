#!/usr/bin/env bun

/**
 * nas - Nix Agent Sandbox
 * Docker + Nix で AI エージェントの隔離された作業環境を起動する CLI ツール
 */

import { main } from "./src/cli.ts";

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
