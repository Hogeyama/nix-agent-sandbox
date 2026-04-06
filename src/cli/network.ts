/**
 * nas network サブコマンド
 */

import { sendBrokerRequest } from "../network/broker.ts";
import { serveAuthRouter } from "../network/envoy_auth_router.ts";
import {
  gcNetworkRuntime,
  listPendingEntries,
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "../network/registry.ts";
import type { ApprovalScope } from "../network/protocol.ts";
import { exitOnCliError, getFlagValue } from "./helpers.ts";
import type { ApprovalAdapter, DecisionMessage } from "./approval_command.ts";
import { handleApprovalSubcommand } from "./approval_command.ts";

export async function runNetworkCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((arg) => !arg.startsWith("-"));
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir");

  try {
    const paths = await resolveNetworkRuntimePaths(runtimeDir ?? undefined);

    if (sub === "serve-auth-router") {
      await serveAuthRouter(paths.runtimeDir);
      return;
    }

    if (sub === "gc") {
      const result = await gcNetworkRuntime(paths);
      console.log(
        `[nas] GC removed ${result.removedSessions.length} session(s), ${result.removedPendingDirs.length} pending dir(s), ${result.removedBrokerSockets.length} broker socket(s).`,
      );
      return;
    }

    const adapter: ApprovalAdapter = {
      domain: "network",
      scopeOptions: ["once", "host-port", "host"],
      async listPending() {
        await gcNetworkRuntime(paths);
        const items = await listPendingEntries(paths);
        return items.map((item) => {
          const target = `${item.target.host}:${item.target.port}`;
          return {
            sessionId: item.sessionId,
            requestId: item.requestId,
            displayLine:
              `${item.sessionId} ${item.requestId} ${target} ${item.state} ${item.createdAt}`,
          };
        });
      },
      async sendDecision(
        sessionId: string,
        _requestId: string,
        message: DecisionMessage,
      ) {
        await gcNetworkRuntime(paths);
        const session = await readSessionRegistry(paths, sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        await sendBrokerRequest(
          session.brokerSocket,
          message as {
            type: "approve";
            requestId: string;
            scope?: ApprovalScope;
          } | { type: "deny"; requestId: string },
        );
      },
    };

    const handled = await handleApprovalSubcommand(adapter, sub, nasArgs);
    if (handled) return;

    console.error(`[nas] Unknown network subcommand: ${sub}`);
    console.error(
      "  Usage: nas network [pending|approve|deny|review|gc] [--scope ...]",
    );
    process.exit(1);
  } catch (err) {
    exitOnCliError(err);
  }
}
