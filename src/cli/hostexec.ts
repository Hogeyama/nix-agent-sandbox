/**
 * nas hostexec サブコマンド
 */

import { loadConfig, resolveProfile } from "../config/load.ts";
import { sendHostExecBrokerRequest } from "../hostexec/broker.ts";
import { buildArgsString, matchRule } from "../hostexec/match.ts";
import {
  listHostExecPendingEntries,
  readHostExecSessionRegistry,
  resolveHostExecRuntimePaths,
} from "../hostexec/registry.ts";
import type { HostExecPromptScope } from "../config/types.ts";
import { getFlagValue, removeFirstOccurrence } from "./helpers.ts";
import type { ApprovalAdapter, DecisionMessage } from "./approval_command.ts";
import { handleApprovalSubcommand } from "./approval_command.ts";

export async function runHostExecCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((arg) => !arg.startsWith("-"));
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir");

  try {
    const paths = await resolveHostExecRuntimePaths(runtimeDir ?? undefined);

    if (sub === "test") {
      await runHostExecTestCommand(removeFirstOccurrence(nasArgs, "test"));
      return;
    }

    const adapter: ApprovalAdapter = {
      domain: "hostexec",
      scopeOptions: ["once", "capability"],
      async listPending() {
        const items = await listHostExecPendingEntries(paths);
        return items.map((item) => {
          const argv = [item.argv0, ...item.args].join(" ");
          return {
            sessionId: item.sessionId,
            requestId: item.requestId,
            displayLine:
              `${item.sessionId} ${item.requestId} ${item.ruleId} ${item.cwd} ${argv}`,
          };
        });
      },
      async sendDecision(
        sessionId: string,
        _requestId: string,
        message: DecisionMessage,
      ) {
        const session = await readHostExecSessionRegistry(paths, sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        await sendHostExecBrokerRequest(
          session.brokerSocket,
          message as {
            type: "approve";
            requestId: string;
            scope?: HostExecPromptScope;
          } | { type: "deny"; requestId: string },
        );
      },
    };

    const handled = await handleApprovalSubcommand(adapter, sub, nasArgs);
    if (handled) return;

    console.error(`[nas] Unknown hostexec subcommand: ${sub}`);
    console.error(
      "  Usage: nas hostexec [pending|approve|deny|review|test] [--scope ...]",
    );
    Deno.exit(1);
  } catch (err) {
    console.error(`[nas] Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

async function runHostExecTestCommand(nasArgs: string[]): Promise<void> {
  const profileName = getFlagValue(nasArgs, "--profile");
  const dashDashIdx = nasArgs.indexOf("--");
  if (dashDashIdx === -1 || dashDashIdx + 1 >= nasArgs.length) {
    console.error(
      "[nas] Usage: nas hostexec test --profile <profile> -- <command> [args...]",
    );
    Deno.exit(1);
  }
  const commandArgs = nasArgs.slice(dashDashIdx + 1);
  const argv0 = commandArgs[0];
  const args = commandArgs.slice(1);

  const config = await loadConfig();
  const { profile } = resolveProfile(config, profileName ?? undefined);
  const hostexec = profile.hostexec;
  if (!hostexec) {
    console.error("[nas] No hostexec configuration found in profile.");
    Deno.exit(1);
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
