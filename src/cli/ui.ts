/**
 * nas ui サブコマンド
 */

import { loadConfig } from "../config/load.ts";
import { DEFAULT_UI_CONFIG } from "../config/types.ts";
import { stopUiDaemon } from "../ui/daemon.ts";
import { startServer } from "../ui/server.ts";
import {
  exitOnCliError,
  findFirstNonFlagArg,
  getFlagValue,
} from "./helpers.ts";

export async function runUiCommand(nasArgs: string[]): Promise<void> {
  const config = await loadConfig().catch(() => null);
  const uiDefaults = config?.ui ?? DEFAULT_UI_CONFIG;

  const sub = findFirstNonFlagArg(nasArgs);

  if (sub === "stop") {
    const portStr = getFlagValue(nasArgs, "--port");
    const port = portStr ? parseInt(portStr, 10) : uiDefaults.port;
    await stopUiDaemon({ port });
    return;
  }

  const portStr = getFlagValue(nasArgs, "--port");
  const port = portStr ? parseInt(portStr, 10) : uiDefaults.port;
  const noOpen = nasArgs.includes("--no-open");
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir") ?? undefined;
  const idleTimeoutStr = getFlagValue(nasArgs, "--idle-timeout");
  const idleTimeout = idleTimeoutStr
    ? parseInt(idleTimeoutStr, 10)
    : uiDefaults.idleTimeout;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("[nas] Invalid port number");
    process.exit(1);
  }

  if (isNaN(idleTimeout) || idleTimeout < 0) {
    console.error("[nas] Invalid idle-timeout value");
    process.exit(1);
  }

  try {
    await startServer({ port, open: !noOpen, runtimeDir, idleTimeout });
  } catch (err) {
    exitOnCliError(err);
  }
}
