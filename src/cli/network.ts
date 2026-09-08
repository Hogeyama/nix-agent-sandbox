/**
 * nas network サブコマンド
 */

import { makeNetworkApprovalClient } from "../domain/network.ts";
import {
  type AddForwardResult,
  type ForwardSelector,
  makePortBindClient,
  type PortBindCandidates,
  type PortForwardKey,
  type RemoveForwardResult,
  SessionUnreachableError,
} from "../domain/port_bind.ts";
import { runFzfSelect } from "../fzf_review.ts";
import {
  isForwardableScope,
  readHostListeners,
} from "../network/host_listeners.ts";
import {
  type PortBindCandidate,
  type PortBindSessionEntry,
  sessionForwards,
  sessionPortForwards,
} from "../network/port_bind_protocol.ts";
import {
  type PortsRuntimePaths,
  resolvePortsRuntimePaths,
} from "../network/port_bind_registry.ts";
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
import {
  parseBindArgs,
  parseBindSessionOnly,
  parseForwardArgs,
  parseForwardSessionOnly,
  parseSshForwardArgs,
  parseUnbindArgs,
  parseUnforwardArgs,
} from "./port_bind_args.ts";

/**
 * The container-side scan starts only when someone asks for candidates, and it
 * needs two passes before it trusts a port, so a one-shot CLI call has to wait
 * out that warm-up instead of reporting an empty container.
 */
const CANDIDATE_WAIT_MS = 6000;
const CANDIDATE_POLL_MS = 500;

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

function portForwardRows(sessions: PortBindSessionEntry[]) {
  return sessions.flatMap((session) =>
    sessionPortForwards(session).map((forward) => ({
      sessionId: session.sessionId,
      direction: forward.direction,
      containerPort: forward.containerPort,
      hostPort: forward.hostPort,
      owners: forward.owners,
      state: forward.state,
      age: formatAge(forward.createdAt),
      selector: (forward.direction === "local"
        ? { direction: "local", hostPort: forward.hostPort }
        : {
            direction: "remote",
            containerPort: forward.containerPort,
          }) satisfies ForwardSelector,
    })),
  );
}

function portForwardLine(
  row: ReturnType<typeof portForwardRows>[number],
): string {
  return `${row.sessionId} ${row.direction} host:${row.hostPort} container:${row.containerPort} ${row.owners.join(",")} ${row.state} ${row.age}`;
}

function forwardRows(sessions: PortBindSessionEntry[]) {
  return sessions.flatMap((session) =>
    sessionForwards(session).map((forward) => ({
      sessionId: session.sessionId,
      containerPort: forward.containerPort,
      hostPort: forward.hostPort,
      age: formatAge(forward.createdAt),
      key: {
        sessionId: session.sessionId,
        containerPort: forward.containerPort,
      } satisfies PortForwardKey,
    })),
  );
}

function forwardLine(row: ReturnType<typeof forwardRows>[number]): string {
  return `${row.sessionId} ${row.containerPort} ${row.hostPort} ${row.age}`;
}

function printForwardResult(result: {
  containerPort: number;
  hostPort: number;
  hostProbe: "ok" | "no-answer";
}): void {
  console.log(
    `コンテナ内の localhost:${result.containerPort} からホストの 127.0.0.1:${result.hostPort} へ転送します`,
  );
  if (result.hostProbe === "no-answer") {
    console.log(
      `[nas] ホストの 127.0.0.1:${result.hostPort} はまだ応答していません。`,
    );
  }
}

function printAddForwardResult(result: AddForwardResult): void {
  if (result.entry.direction === "remote") {
    printForwardResult({
      containerPort: result.entry.containerPort,
      hostPort: result.entry.hostPort,
      hostProbe: result.probe === "ok" ? "ok" : "no-answer",
    });
    return;
  }

  console.log(`http://localhost:${result.entry.hostPort} で開きました`);
  if (result.probe === "no-answer") {
    console.log("[nas] コンテナのポートは応答しませんでした。");
  } else if (result.probe === "container-not-running") {
    console.log("[nas] コンテナは起動していません。");
  } else if (result.probe === "relay-unreachable") {
    console.log("[nas] リレーを起動できませんでした。");
  }
}

function printRemoveForwardResult(result: RemoveForwardResult): void {
  const outcome = result.removed
    ? "ポート転送のユーザー設定を削除しました。"
    : "削除できるポート転送のユーザー設定はありませんでした。";
  console.log(
    `[nas] ${outcome} retainedInternal=${result.retainedInternal} listenerClosed=${result.listenerClosed}`,
  );
}

async function collectCandidates(
  client: ReturnType<typeof makePortBindClient>,
  paths: PortsRuntimePaths,
  sessionId: string,
): Promise<PortBindCandidates> {
  const deadline = Date.now() + CANDIDATE_WAIT_MS;
  let result = await client.candidates(paths, sessionId);
  while (
    result.watch === "watching" &&
    result.candidates.length === 0 &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, CANDIDATE_POLL_MS));
    result = await client.candidates(paths, sessionId);
  }
  return result;
}

function candidateLine(candidate: PortBindCandidate): string {
  // The scope only earns a mention when it is the reason a bind would not
  // work; an ordinary server is just its port.
  return candidate.reachable
    ? `${candidate.containerPort}`
    : `${candidate.containerPort} (${candidate.scope} — 127.0.0.1 からは届きません)`;
}

interface NetworkCommandDependencies {
  portBindClient?: ReturnType<typeof makePortBindClient>;
  select?: typeof runFzfSelect;
}

export async function runNetworkCommand(
  nasArgs: string[],
  dependencies: NetworkCommandDependencies = {},
): Promise<void> {
  const sub = findFirstNonFlagArg(nasArgs);
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir");
  const portBindClient = dependencies.portBindClient ?? makePortBindClient();
  const select = dependencies.select ?? runFzfSelect;
  let unreachableSessionId: string | undefined;

  try {
    if (sub === "bind") {
      const paths = await resolvePortsRuntimePaths(runtimeDir ?? undefined);
      const args = removeFirstOccurrence(nasArgs, sub);
      if (!hasPortBindArgument(args)) {
        const rows = portForwardRows(await portBindClient.list(paths));
        if (hasFormatJson(nasArgs)) {
          console.log(
            JSON.stringify(
              rows.map(
                ({
                  sessionId,
                  direction,
                  containerPort,
                  hostPort,
                  owners,
                  state,
                  age,
                }) => ({
                  sessionId,
                  direction,
                  containerPort,
                  hostPort,
                  owners,
                  state,
                  age,
                }),
              ),
            ),
          );
        } else if (rows.length === 0) {
          console.log("[nas] No open port forwards.");
        } else {
          for (const row of rows) console.log(portForwardLine(row));
        }
        return;
      }

      const sshRequest = parseSshForwardArgs(args, "bind");
      if (sshRequest !== null && sshRequest.operation === "bind") {
        unreachableSessionId = sshRequest.sessionId;
        printAddForwardResult(
          await portBindClient.add(
            paths,
            sshRequest.sessionId,
            sshRequest.request,
          ),
        );
        return;
      }

      const suggestFor = parseBindSessionOnly(args);
      if (suggestFor !== null) {
        unreachableSessionId = suggestFor;
        const found = await collectCandidates(
          portBindClient,
          paths,
          suggestFor,
        );
        if (hasFormatJson(nasArgs)) {
          console.log(JSON.stringify(found));
          return;
        }
        if (found.candidates.length === 0) {
          if (found.watch === "container-not-running") {
            console.log("[nas] コンテナは起動していません。");
          } else if (found.watch === "relay-unreachable") {
            console.log("[nas] リレーを起動できませんでした。");
          } else {
            console.log("[nas] 未転送の待ち受けポートは見つかりませんでした。");
          }
          return;
        }
        const lines = found.candidates.map(candidateLine);
        const selected = await select(lines, {
          prompt: "bind> ",
          missingMessage:
            "[nas] fzf is not installed. Pass <session-id>:<container-port> to 'nas network bind'.",
        });
        if (selected === null) return;
        const chosen = found.candidates[lines.indexOf(selected)];
        const suggested = await portBindClient.bind(
          paths,
          suggestFor,
          chosen.containerPort,
          null,
        );
        console.log(`http://localhost:${suggested.hostPort} で開きました`);
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
      const sshRequest = parseSshForwardArgs(args, "unbind");
      if (sshRequest !== null && sshRequest.operation === "unbind") {
        unreachableSessionId = sshRequest.sessionId;
        printRemoveForwardResult(
          await portBindClient.remove(
            paths,
            sshRequest.sessionId,
            sshRequest.selector,
          ),
        );
        return;
      }

      const key = parseUnbindArgs(args);
      if (key === null) {
        const rows = portForwardRows(await portBindClient.list(paths));
        if (rows.length === 0) {
          console.log("[nas] No open port forwards.");
          return;
        }
        const lines = rows.map(portForwardLine);
        const selected = await select(lines, {
          prompt: "unbind> ",
          missingMessage:
            "[nas] fzf is not installed. Pass <session-id> -L <host-port> or <session-id> -R <container-port> to 'nas network unbind'.",
        });
        if (selected === null) return;
        const row = rows[lines.indexOf(selected)];
        unreachableSessionId = row.sessionId;
        printRemoveForwardResult(
          await portBindClient.remove(paths, row.sessionId, row.selector),
        );
        return;
      }
      if ("sessionId" in key) unreachableSessionId = key.sessionId;
      await portBindClient.unbindByKey(paths, key);
      console.log("[nas] ポート転送の削除を処理しました。");
      return;
    }

    if (sub === "forward") {
      const paths = await resolvePortsRuntimePaths(runtimeDir ?? undefined);
      const args = removeFirstOccurrence(nasArgs, sub);
      if (!hasPortBindArgument(args)) {
        const rows = forwardRows(await portBindClient.list(paths));
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
          console.log("[nas] No open port forwards.");
        } else {
          for (const row of rows) console.log(forwardLine(row));
        }
        return;
      }

      const suggestFor = parseForwardSessionOnly(args);
      if (suggestFor !== null) {
        unreachableSessionId = suggestFor;
        const sessions = await portBindClient.list(paths);
        const taken = new Set(
          forwardRows(sessions)
            .filter((row) => row.sessionId === suggestFor)
            .map((row) => row.containerPort),
        );
        const listeners = (await readHostListeners()).filter(
          (listener) =>
            isForwardableScope(listener.scope) &&
            !taken.has(listener.containerPort),
        );
        if (hasFormatJson(nasArgs)) {
          console.log(
            JSON.stringify(
              listeners.map((listener) => ({
                hostPort: listener.containerPort,
                scope: listener.scope,
              })),
            ),
          );
          return;
        }
        if (listeners.length === 0) {
          console.log(
            "[nas] ホストの 127.0.0.1 で待ち受けている未転送のポートは見つかりませんでした。",
          );
          return;
        }
        const lines = listeners.map((listener) => `${listener.containerPort}`);
        const selected = await select(lines, {
          prompt: "forward> ",
          header: "ホストの待ち受けポート（同じ番号でコンテナ内に転送）",
          missingMessage:
            "[nas] fzf is not installed. Pass <session-id>:<port> to 'nas network forward'.",
        });
        if (selected === null) return;
        const port = Number(selected);
        printForwardResult(
          await portBindClient.forward(paths, suggestFor, port, port),
        );
        return;
      }

      const request = parseForwardArgs(args);
      unreachableSessionId = request.sessionId;
      printForwardResult(
        await portBindClient.forward(
          paths,
          request.sessionId,
          request.containerPort,
          request.hostPort,
        ),
      );
      return;
    }

    if (sub === "unforward") {
      const paths = await resolvePortsRuntimePaths(runtimeDir ?? undefined);
      const args = removeFirstOccurrence(nasArgs, sub);
      let key = parseUnforwardArgs(args);
      if (key === null) {
        const rows = forwardRows(await portBindClient.list(paths));
        if (rows.length === 0) {
          console.log("[nas] No open port forwards.");
          return;
        }
        const lines = rows.map(forwardLine);
        const selected = await select(lines, {
          prompt: "unforward> ",
          missingMessage:
            "[nas] fzf is not installed. Pass <session-id>:<container-port> to 'nas network unforward'.",
        });
        if (selected === null) return;
        key = rows[lines.indexOf(selected)].key;
      }
      unreachableSessionId = key.sessionId;
      await portBindClient.unforward(paths, key);
      console.log("[nas] ホストへの転送の削除を処理しました。");
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
      "  Usage: nas network [pending|approve|deny|review|gc|bind|unbind|forward|unforward] [--scope ...]",
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
