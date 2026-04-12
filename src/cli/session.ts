/**
 * nas session サブコマンド
 */

import {
  DTACH_SOCKET_PREFIX,
  dtachAttach,
  dtachHasSession,
  dtachIsAvailable,
  dtachListSessions,
  socketPathFor,
} from "../dtach/client.ts";
import { exitOnCliError, hasFormatJson } from "./helpers.ts";

export async function runSessionCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));
  const formatJson = hasFormatJson(nasArgs);

  try {
    if (sub === "list") {
      if (!(await dtachIsAvailable())) {
        console.error("[nas] dtach is not installed.");
        process.exit(1);
      }

      const sessions = await dtachListSessions();

      if (formatJson) {
        const items = sessions.map((s) => ({
          name: s.name,
          sessionId: s.name.slice(DTACH_SOCKET_PREFIX.length),
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
        const sessionId = s.name.slice(DTACH_SOCKET_PREFIX.length);
        const created = new Date(s.createdAt * 1000).toISOString();
        console.log(`  ${sessionId}  ${created}`);
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
