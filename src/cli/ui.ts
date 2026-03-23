/**
 * nas ui サブコマンド
 */

import { startServer } from "../ui/server.ts";
import { exitOnCliError, getFlagValue } from "./helpers.ts";

export async function runUiCommand(nasArgs: string[]): Promise<void> {
  const portStr = getFlagValue(nasArgs, "--port");
  const port = portStr ? parseInt(portStr, 10) : 3939;
  const noOpen = nasArgs.includes("--no-open");
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir") ?? undefined;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("[nas] Invalid port number");
    Deno.exit(1);
  }

  try {
    await startServer({ port, open: !noOpen, runtimeDir });
  } catch (err) {
    exitOnCliError(err);
  }
}
