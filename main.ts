#!/usr/bin/env -S deno run --allow-all

/**
 * nas - Nix Agent Sandbox
 * Docker + Nix で AI エージェントの隔離された作業環境を起動する CLI ツール
 */

import { main } from "./src/cli.ts";

if (import.meta.main) {
  await main(Deno.args);
}
