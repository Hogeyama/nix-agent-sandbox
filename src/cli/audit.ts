/**
 * nas audit サブコマンド
 */

import { resolveAuditDir } from "../audit/store.ts";
import type { AuditDomain, AuditLogEntry } from "../audit/types.ts";
import { makeAuditQueryClient } from "../domain/audit.ts";
import { exitOnCliError, getFlagValue } from "./helpers.ts";

export async function runAuditCommand(nasArgs: string[]): Promise<void> {
  try {
    const auditClient = makeAuditQueryClient();
    const jsonMode = nasArgs.includes("--json");
    const since = getFlagValue(nasArgs, "--since");
    const sessionId = getFlagValue(nasArgs, "--session");
    const domain = getFlagValue(nasArgs, "--domain") as AuditDomain | null;
    const auditDirOverride = getFlagValue(nasArgs, "--audit-dir");

    if (domain !== null && domain !== "network" && domain !== "hostexec") {
      console.error(
        `[nas] Invalid domain: ${domain}. Must be "network" or "hostexec".`,
      );
      process.exit(1);
    }

    const today = new Date().toISOString().slice(0, 10);
    const startDate = since ?? today;

    const auditDir = auditDirOverride ?? resolveAuditDir();
    const entries = await auditClient.query(auditDir, {
      startDate,
      sessionIds: sessionId ? [sessionId] : undefined,
      domain: domain ?? undefined,
    });

    if (jsonMode) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log("No audit log entries found.");
      return;
    }

    for (const line of formatAuditEntries(entries)) {
      console.log(line);
    }
  } catch (err) {
    exitOnCliError(err);
  }
}

export function formatAuditEntries(entries: AuditLogEntry[]): string[] {
  const egressCounts = new Map<number, number>();
  let currentKey: string | undefined;
  let firstIndex = -1;

  for (const [index, entry] of entries.entries()) {
    if (entry.phase !== "egress") continue;

    const key = [
      entry.sessionId,
      entry.method,
      entry.route,
      entry.egressAction,
      entry.reason,
    ].join("\u0000");

    if (key === currentKey) {
      egressCounts.set(firstIndex, (egressCounts.get(firstIndex) ?? 1) + 1);
      continue;
    }

    currentKey = key;
    firstIndex = index;
    egressCounts.set(firstIndex, 1);
  }

  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.phase !== "egress") {
      lines.push(formatEntry(entry));
      continue;
    }

    const count = egressCounts.get(index);
    if (count === undefined) continue;

    lines.push(
      `${entry.timestamp} ${entry.sessionId} network ${entry.decision} ${entry.reason} ${entry.method ?? ""} ${entry.route ?? "unknown"} ${entry.egressAction ?? ""}${count > 1 ? ` x${count}` : ""}`,
    );
  }

  return lines;
}

function formatEntry(entry: AuditLogEntry): string {
  const target =
    entry.domain === "network" ? (entry.target ?? "") : (entry.command ?? "");
  return `${entry.timestamp} ${entry.sessionId} ${entry.domain} ${entry.decision} ${entry.reason} ${target}`;
}
