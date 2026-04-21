/**
 * nas network サブコマンド
 */

import { makeNetworkApprovalClient } from "../domain/network.ts";
import { serveAuthRouter } from "../network/envoy_auth_router.ts";
import type { ApprovalScope } from "../network/protocol.ts";
import {
  gcNetworkRuntime,
  resolveNetworkRuntimePaths,
} from "../network/registry.ts";
import type { ApprovalAdapter, DecisionMessage } from "./approval_command.ts";
import { handleApprovalSubcommand } from "./approval_command.ts";
import { exitOnCliError, getFlagValue } from "./helpers.ts";

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

    const client = makeNetworkApprovalClient();
    const adapter: ApprovalAdapter = {
      domain: "network",
      scopeOptions: ["once", "host-port", "host"],
      async listPending() {
        const items = await client.listPending(paths);
        return items.map((item) => {
          const target = `${item.target.host}:${item.target.port}`;
          return {
            sessionId: item.sessionId,
            requestId: item.requestId,
            displayLine: `${item.sessionId} ${item.requestId} ${target} ${item.state} ${item.createdAt}`,
            structured: {
              sessionId: item.sessionId,
              requestId: item.requestId,
              host: item.target.host,
              port: item.target.port,
              state: item.state,
              createdAt: item.createdAt,
            },
          };
        });
      },
      async sendDecision(
        sessionId: string,
        requestId: string,
        message: DecisionMessage,
      ) {
        if (message.type === "approve") {
          await client.approve(
            paths,
            sessionId,
            requestId,
            message.scope as ApprovalScope | undefined,
          );
        } else {
          await client.deny(paths, sessionId, requestId);
        }
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
