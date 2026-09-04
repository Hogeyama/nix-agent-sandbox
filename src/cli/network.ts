/**
 * nas network サブコマンド
 */

import { makeNetworkApprovalClient } from "../domain/network.ts";
import {
  makePortBindClient,
  type PortBindKey,
  SessionUnreachableError,
} from "../domain/port_bind.ts";
import { runFzfSelect } from "../fzf_review.ts";
import type { PortBindSessionEntry } from "../network/port_bind_protocol.ts";
import { resolvePortsRuntimePaths } from "../network/port_bind_registry.ts";
import { APPROVAL_SCOPES, type ApprovalScope } from "../network/protocol.ts";
import {
  gcNetworkRuntime,
  resolveNetworkRuntimePaths,
} from "../network/registry.ts";
import type { ApprovalAdapter, DecisionMessage } from "./approval_command.ts";
import { handleApprovalSubcommand } from "./approval_command.ts";
import {
  exitOnCliError,
  findFirstNonFlagArg,
  getFlagValue,
  hasFormatJson,
  removeFirstOccurrence,
} from "./helpers.ts";
import { parseBindArgs, parseUnbindArgs } from "./port_bind_args.ts";

function hasPortBindArgument(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--runtime-dir" || arg === "--format") {
      if (index + 1 >= args.length) return true;
      index++;
      continue;
    }
    if (arg === "--format=json") continue;
    if (
      arg === "-q" ||
      arg === "--quiet" ||
      arg === "-v" ||
      arg === "--verbose"
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function formatAge(createdAt: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(createdAt)) / 1000),
  );
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function bindingRows(sessions: PortBindSessionEntry[]) {
  return sessions.flatMap((session) =>
    session.bindings.map((binding) => ({
      sessionId: session.sessionId,
      containerPort: binding.containerPort,
      hostPort: binding.hostPort,
      age: formatAge(binding.createdAt),
      key: {
        sessionId: session.sessionId,
        containerPort: binding.containerPort,
      } satisfies PortBindKey,
    })),
  );
}

export async function runNetworkCommand(nasArgs: string[]): Promise<void> {
  const sub = findFirstNonFlagArg(nasArgs);
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir");
  const portBindClient = makePortBindClient();
  let unreachableSessionId: string | undefined;

  try {
    if (sub === "bind") {
      const paths = await resolvePortsRuntimePaths(runtimeDir ?? undefined);
      const args = removeFirstOccurrence(nasArgs, sub);
      if (!hasPortBindArgument(args)) {
        const rows = bindingRows(await portBindClient.list(paths));
        if (hasFormatJson(nasArgs)) {
          console.log(
            JSON.stringify(
              rows.map(({ sessionId, containerPort, hostPort, age }) => ({
                sessionId,
                containerPort,
                hostPort,
                age,
              })),
            ),
          );
        } else if (rows.length === 0) {
          console.log("[nas] No open port bindings.");
        } else {
          for (const row of rows) {
            console.log(
              `${row.sessionId} ${row.containerPort} ${row.hostPort} ${row.age}`,
            );
          }
        }
        return;
      }

      const request = parseBindArgs(args);
      unreachableSessionId = request.sessionId;
      const result = await portBindClient.bind(
        paths,
        request.sessionId,
        request.containerPort,
        request.hostPort,
      );
      console.log(`http://localhost:${result.hostPort} で開きました`);
      if (result.probe === "no-answer") {
        console.log("[nas] コンテナのポートは応答しませんでした。");
      } else if (result.probe === "container-not-running") {
        console.log("[nas] コンテナは起動していません。");
      } else if (result.probe === "relay-unreachable") {
        console.log("[nas] リレーを起動できませんでした。");
      }
      return;
    }

    if (sub === "unbind") {
      const paths = await resolvePortsRuntimePaths(runtimeDir ?? undefined);
      const args = removeFirstOccurrence(nasArgs, sub);
      let key = parseUnbindArgs(args);
      if (key === null) {
        const rows = bindingRows(await portBindClient.list(paths));
        if (rows.length === 0) {
          console.log("[nas] No open port bindings.");
          return;
        }
        const lines = rows.map(
          (row) =>
            `${row.sessionId} ${row.containerPort} ${row.hostPort} ${row.age}`,
        );
        const selected = await runFzfSelect(lines, {
          prompt: "unbind> ",
          missingMessage:
            "[nas] fzf is not installed. Pass <session-id>:<container-port> or <host-port> to 'nas network unbind'.",
        });
        if (selected === null) return;
        key = rows[lines.indexOf(selected)].key;
      }
      if ("sessionId" in key) unreachableSessionId = key.sessionId;
      await portBindClient.unbindByKey(paths, key);
      console.log("[nas] ポート転送を閉じました。");
      return;
    }

    const paths = await resolveNetworkRuntimePaths(runtimeDir ?? undefined);

    if (sub === "gc") {
      const result = await gcNetworkRuntime(paths);
      if (runtimeDir === null) {
        const portsPaths = await resolvePortsRuntimePaths();
        await portBindClient.list(portsPaths);
      }
      console.log(
        `[nas] GC removed ${result.removedSessions.length} session(s), ${result.removedPendingDirs.length} pending dir(s), ${result.removedBrokerSockets.length} broker socket(s).`,
      );
      return;
    }

    const client = makeNetworkApprovalClient();
    const adapter: ApprovalAdapter = {
      domain: "network",
      // どの粒度を本当に選べるかは確認ごとに違う (pending の approvalScopes)。
      // ここはその全体で、選べない粒度を送れば broker が突き返す。
      scopeOptions: [...APPROVAL_SCOPES],
      async listPending() {
        const items = await client.listPending(paths);
        return items.map((item) => {
          const target = `${item.target.host}:${item.target.port}`;
          const reviewInfo = item.reviewContext
            ? ` [${item.method} ${item.reviewContext.path}] body=${item.reviewContext.bodySize}B`
            : "";
          // なぜ訊かれているか。ルール ID の隣に置く。`$fallback` の擬似 ID
          // だけでは、ルールが review を宣言したのか、どのルールも引き受け
          // なかったのかを綴りから読むことになる。
          const askInfo = item.askReason ? ` (${item.askReason})` : "";
          return {
            sessionId: item.sessionId,
            requestId: item.requestId,
            displayLine: `${item.sessionId} ${item.requestId} ${target}${reviewInfo} ${item.ruleId}${askInfo} ${item.state} ${item.createdAt}`,
            structured: {
              sessionId: item.sessionId,
              requestId: item.requestId,
              host: item.target.host,
              port: item.target.port,
              state: item.state,
              createdAt: item.createdAt,
              method: item.method,
              reviewContext: item.reviewContext ?? null,
              ruleId: item.ruleId,
              askReason: item.askReason ?? null,
              approvalScopes: item.approvalScopes,
              violations: item.violations ?? null,
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
      "  Usage: nas network [pending|approve|deny|review|gc|bind|unbind] [--scope ...]",
    );
    process.exit(1);
  } catch (err) {
    if (err instanceof SessionUnreachableError) {
      const subject = unreachableSessionId
        ? `セッション ${unreachableSessionId}`
        : "ポート転送先のセッション";
      exitOnCliError(
        new Error(
          `${subject} に接続できません。この機能の追加前に開始された可能性があります。セッションを再起動するか nas network gc を実行してください。`,
        ),
      );
    }
    exitOnCliError(err);
  }
}
