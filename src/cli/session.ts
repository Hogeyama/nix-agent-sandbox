/**
 * nas session サブコマンド
 */

import { makeSessionUiClient } from "../domain/session.ts";
import { makeTerminalSessionClient } from "../domain/terminal.ts";
import {
  dtachAttach,
  dtachHasSession,
  dtachIsAvailable,
  getSocketDir,
  socketPathFor,
} from "../dtach/client.ts";
import { resolveSessionRuntimePaths } from "../sessions/store.ts";
import { exitOnCliError, hasFormatJson } from "./helpers.ts";

export async function runSessionCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));
  const formatJson = hasFormatJson(nasArgs);
  const sessionClient = makeSessionUiClient();
  const terminalClient = makeTerminalSessionClient();

  try {
    if (sub === "list") {
      if (!(await dtachIsAvailable())) {
        console.error("[nas] dtach is not installed.");
        process.exit(1);
      }

      const runtimeDir = getSocketDir();
      const sessions = await terminalClient.listSessions(runtimeDir);
      const sessionPaths = resolveSessionRuntimePaths();
      const storeRecords = await sessionClient.list(sessionPaths);
      const nameById = new Map<string, string>();
      for (const record of storeRecords) {
        if (record.name) {
          nameById.set(record.sessionId, record.name);
        }
      }

      if (formatJson) {
        const items = sessions.map((s) => ({
          name: nameById.get(s.name),
          sessionId: s.name,
          createdAt: s.createdAt,
        }));
        console.log(JSON.stringify(items));
        return;
      }

      if (sessions.length === 0) {
        console.log("[nas] No active dtach sessions found.");
        return;
      }

      for (const s of sessions) {
        const sessionId = s.name;
        const displayName = nameById.get(sessionId);
        const created = new Date(s.createdAt * 1000).toISOString();
        const nameLabel = displayName ? `  (${displayName})` : "";
        console.log(`  ${sessionId}${nameLabel}  ${created}`);
      }
      return;
    }

    if (sub === "attach") {
      if (!(await dtachIsAvailable())) {
        console.error("[nas] dtach is not installed.");
        process.exit(1);
      }

      // attach の後の引数からセッションIDを取得
      const subIndex = nasArgs.indexOf("attach");
      const sessionId = nasArgs
        .slice(subIndex + 1)
        .find((a) => !a.startsWith("-"));

      if (!sessionId) {
        console.error("[nas] Usage: nas session attach <session-id>");
        process.exit(1);
      }

      const socketPath = socketPathFor(sessionId);
      if (!(await dtachHasSession(socketPath))) {
        console.error(
          `[nas] Session "${sessionId}" not found. Run "nas session list" to see active sessions.`,
        );
        process.exit(1);
      }

      await dtachAttach(socketPath);
      return;
    }

    if (sub === undefined) {
      // サブコマンド省略時は list をデフォルトにする（再帰）
      return runSessionCommand(["list", ...nasArgs]);
    }

    console.error(`[nas] Unknown session subcommand: ${sub}`);
    console.error(
      "  Usage: nas session [list|attach <session-id>] [--format json]",
    );
    process.exit(1);
  } catch (err) {
    exitOnCliError(err);
  }
}
