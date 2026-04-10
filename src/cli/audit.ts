/**
 * nas audit サブコマンド
 */

import { queryAuditLogs, resolveAuditDir } from "../audit/store.ts";
import type { AuditDomain, AuditLogEntry } from "../audit/types.ts";
import { exitOnCliError, getFlagValue } from "./helpers.ts";

export async function runAuditCommand(nasArgs: string[]): Promise<void> {
  try {
    const jsonMode = nasArgs.includes("--json");
    const since = getFlagValue(nasArgs, "--since");
    const sessionId = getFlagValue(nasArgs, "--session");
    const domain = getFlagValue(nasArgs, "--domain") as
      | AuditDomain
      | null;
    const auditDirOverride = getFlagValue(nasArgs, "--audit-dir");

    if (domain !== null && domain !== "network" && domain !== "hostexec") {
      console.error(
        `[nas] Invalid domain: ${domain}. Must be "network" or "hostexec".`,
      );
      process.exit(1);
    }

    const today = new Date().toISOString().slice(0, 10);
    const startDate = since ?? today;

    const entries = await queryAuditLogs(
      {
        startDate,
        sessionIds: sessionId ? [sessionId] : undefined,
        domain: domain ?? undefined,
      },
      auditDirOverride ?? undefined,
    );

    if (jsonMode) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log("No audit log entries found.");
      return;
    }

    for (const entry of entries) {
      console.log(formatEntry(entry));
    }
  } catch (err) {
    exitOnCliError(err);
  }
}

function formatEntry(entry: AuditLogEntry): string {
  const target = entry.domain === "network"
    ? (entry.target ?? "")
    : (entry.command ?? "");
  return `${entry.timestamp} ${entry.sessionId} ${entry.domain} ${entry.decision} ${entry.reason} ${target}`;
}

export { resolveAuditDir };
