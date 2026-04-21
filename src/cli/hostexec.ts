/**
 * nas hostexec サブコマンド
 */

import { loadConfig, resolveProfile } from "../config/load.ts";
import type { HostExecPromptScope } from "../config/types.ts";
import { makeHostExecApprovalClient } from "../domain/hostexec.ts";
import { buildArgsString, matchRule } from "../hostexec/match.ts";
import { resolveHostExecRuntimePaths } from "../hostexec/registry.ts";
import type { ApprovalAdapter, DecisionMessage } from "./approval_command.ts";
import { handleApprovalSubcommand } from "./approval_command.ts";
import { getFlagValue, removeFirstOccurrence } from "./helpers.ts";

export async function runHostExecCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((arg) => !arg.startsWith("-"));
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
        return items.map((item) => {
          const argv = [item.argv0, ...item.args].join(" ");
          return {
            sessionId: item.sessionId,
            requestId: item.requestId,
            displayLine: `${item.sessionId} ${item.requestId} ${item.ruleId} ${item.cwd} ${argv}`,
            structured: {
              sessionId: item.sessionId,
              requestId: item.requestId,
              ruleId: item.ruleId,
              cwd: item.cwd,
              argv0: item.argv0,
              args: item.args,
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
      "  Usage: nas hostexec [pending|approve|deny|review|test] [--scope ...]",
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
