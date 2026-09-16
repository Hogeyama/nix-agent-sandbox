/**
 * nas hostexec サブコマンド
 */

import { loadConfig, resolveProfile } from "../config/load.ts";
import type { HostExecPromptScope } from "../config/types.ts";
import { makeHostExecApprovalClient } from "../domain/hostexec.ts";
import { buildArgsString, matchRule } from "../hostexec/match.ts";
import { resolveHostExecRuntimePaths } from "../hostexec/registry.ts";
import type { HostExecPendingEntry } from "../hostexec/types.ts";
import type {
  ApprovalAdapter,
  DecisionMessage,
  PendingItem,
} from "./approval_command.ts";
import { handleApprovalSubcommand } from "./approval_command.ts";
import {
  findFirstNonFlagArg,
  getFlagValue,
  removeFirstOccurrence,
} from "./helpers.ts";

/**
 * pending エントリを CLI の表示・出力形へ整える。
 *
 * `structured` は `pending --format json` と `watch` の両方が返す payload で、
 * network 側と同じフィールドを揃える必要があるため純粋関数に切り出している。
 *
 * @internal 併置のテストファイルのために export している。
 */
export function toHostExecPendingItem(
  entry: HostExecPendingEntry,
): PendingItem {
  const argv = [entry.argv0, ...entry.args].join(" ");
  return {
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    displayLine: `${entry.sessionId} ${entry.requestId} ${entry.ruleId} ${entry.cwd} ${argv}${
      entry.integrityChanged ? " [CHANGED-SINCE-START]" : ""
    }`,
    structured: {
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      ruleId: entry.ruleId,
      cwd: entry.cwd,
      argv0: entry.argv0,
      args: entry.args,
      createdAt: entry.createdAt,
    },
  };
}

export async function runHostExecCommand(nasArgs: string[]): Promise<void> {
  // フラグの値をサブコマンド名と取り違えないよう、network と同じ判定を使う。
  const sub = findFirstNonFlagArg(nasArgs);
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir");

  try {
    const paths = await resolveHostExecRuntimePaths(runtimeDir ?? undefined);

    if (sub === "test") {
      await runHostExecTestCommand(removeFirstOccurrence(nasArgs, "test"));
      return;
    }

    const client = makeHostExecApprovalClient();
    const adapter: ApprovalAdapter = {
      domain: "hostexec",
      scopeOptions: ["once", "capability"],
      async listPending() {
        const items = await client.listPending(paths);
        return items.map(toHostExecPendingItem);
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
            message.scope as HostExecPromptScope | undefined,
          );
        } else {
          await client.deny(paths, sessionId, requestId);
        }
      },
    };

    const handled = await handleApprovalSubcommand(adapter, sub, nasArgs);
    if (handled) return;

    console.error(`[nas] Unknown hostexec subcommand: ${sub}`);
    console.error(
      "  Usage: nas hostexec [pending|approve|deny|review|watch|test] [--scope ...]",
    );
    process.exit(1);
  } catch (err) {
    console.error(`[nas] Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function runHostExecTestCommand(nasArgs: string[]): Promise<void> {
  const profileName = getFlagValue(nasArgs, "--profile");
  const dashDashIdx = nasArgs.indexOf("--");
  if (dashDashIdx === -1 || dashDashIdx + 1 >= nasArgs.length) {
    console.error(
      "[nas] Usage: nas hostexec test --profile <profile> -- <command> [args...]",
    );
    process.exit(1);
  }
  const commandArgs = nasArgs.slice(dashDashIdx + 1);
  const argv0 = commandArgs[0];
  const args = commandArgs.slice(1);

  const config = await loadConfig();
  const { profile } = resolveProfile(config, profileName ?? undefined);
  const hostexec = profile.hostexec;
  if (!hostexec) {
    console.error("[nas] No hostexec configuration found in profile.");
    process.exit(1);
  }

  const argsStr = buildArgsString(args);
  console.log(`args string: "${argsStr}"`);

  const result = matchRule(hostexec.rules, argv0, args);

  if (result) {
    const envKeys = Object.keys(result.rule.env);
    const envPart = envKeys.length > 0 ? `, env: [${envKeys.join(", ")}]` : "";
    console.log(
      `Matched rule: ${result.rule.id} (approval: ${result.rule.approval}${envPart})`,
    );
  } else {
    console.log("No rule matched (fallback applies)");
  }
}
