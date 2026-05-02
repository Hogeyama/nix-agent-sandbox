/**
 * nas ui サブコマンド
 */

import { loadConfig } from "../config/load.ts";
import { DEFAULT_UI_CONFIG } from "../config/types.ts";
import { stopUiDaemon } from "../ui/daemon.ts";
import { startServer } from "../ui/server.ts";
import {
  type MigrationOutcome,
  migrateLegacyUiState,
} from "../ui/state_migration.ts";
import {
  exitOnCliError,
  findFirstNonFlagArg,
  getFlagValue,
} from "./helpers.ts";

export interface RunUiCommandInternals {
  migrate?: () => Promise<MigrationOutcome>;
  stop?: (options: { port: number }) => Promise<void>;
}

export async function runUiCommand(
  nasArgs: string[],
  internals: RunUiCommandInternals = {},
): Promise<void> {
  const config = await loadConfig().catch(() => null);
  const uiDefaults = config?.ui ?? DEFAULT_UI_CONFIG;

  const sub = findFirstNonFlagArg(nasArgs);
  const stop = internals.stop ?? stopUiDaemon;

  if (sub === "stop") {
    const portStr = getFlagValue(nasArgs, "--port");
    const port = portStr ? parseInt(portStr, 10) : uiDefaults.port;
    await stop({ port });
    return;
  }

  const migrate = internals.migrate ?? migrateLegacyUiState;
  await migrate();

  const portStr = getFlagValue(nasArgs, "--port");
  const port = portStr ? parseInt(portStr, 10) : uiDefaults.port;
  const noOpen = nasArgs.includes("--no-open");
  const idleTimeoutStr = getFlagValue(nasArgs, "--idle-timeout");
  const idleTimeout = idleTimeoutStr
    ? parseInt(idleTimeoutStr, 10)
    : uiDefaults.idleTimeout;

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error("[nas] Invalid port number");
    process.exit(1);
  }

  if (Number.isNaN(idleTimeout) || idleTimeout < 0) {
    console.error("[nas] Invalid idle-timeout value");
    process.exit(1);
  }

  try {
    await startServer({ port, open: !noOpen, idleTimeout });
  } catch (err) {
    exitOnCliError(err);
  }
}
