import * as path from "node:path";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { ensureDir } from "../lib/fs_utils.ts";
import type { AuditLogEntry, AuditLogFilter } from "./types.ts";

/**
 * Resolve the directory where audit JSONL files are stored.
 *
 * Uses `$XDG_DATA_HOME/nas/audit/` with the standard fallback to
 * `~/.local/share/nas/audit/`.
 */
export function resolveAuditDir(): string {
  const xdgData = process.env["XDG_DATA_HOME"];
  if (xdgData && xdgData.trim().length > 0) {
    return path.join(xdgData, "nas", "audit");
  }
  const home = process.env["HOME"];
  if (!home) {
    throw new Error(
      "Cannot resolve audit directory: neither XDG_DATA_HOME nor HOME is set",
    );
  }
  return path.join(home, ".local/share", "nas", "audit");
}

/** Return the JSONL filename for a given date string (YYYY-MM-DD). */
function fileForDate(date: string): string {
  return `${date}.jsonl`;
}

/** Extract YYYY-MM-DD from an ISO-8601 timestamp. */
function dateOfTimestamp(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Append a single audit log entry to the date-partitioned JSONL file.
 *
 * The write uses `O_APPEND` so concurrent writers don't clobber each other
 * (each JSON line is written as a single kernel write).
 */
export async function appendAuditLog(
  entry: AuditLogEntry,
  auditDir?: string,
): Promise<void> {
  const dir = auditDir ?? resolveAuditDir();
  await ensureDir(dir);

  const date = dateOfTimestamp(entry.timestamp);
  const filePath = path.join(dir, fileForDate(date));
  const line = JSON.stringify(entry) + "\n";

  await appendFile(filePath, line, { mode: 0o600 });
}

/**
 * Query audit log entries that match the given filter.
 *
 * Reads only the JSONL files whose dates fall within the requested range.
 * When no date range is given, all files in the audit directory are scanned.
 */
export async function queryAuditLogs(
  filter: AuditLogFilter = {},
  auditDir?: string,
): Promise<AuditLogEntry[]> {
  const dir = auditDir ?? resolveAuditDir();

  const files = await listJsonlFiles(dir);
  const results: AuditLogEntry[] = [];

  // When `before` is set we can skip whole files whose date is strictly
  // after the cursor's date. ISO-8601 timestamps are lexicographically
  // comparable, so this is a safe optimisation.
  const beforeDate = filter.before ? dateOfTimestamp(filter.before) : undefined;
  const sessionIdSet = filter.sessionIds ? new Set(filter.sessionIds) : undefined;
  const sessionNeedle = filter.sessionContains?.toLowerCase();

  for (const fileName of files) {
    const date = fileName.replace(/\.jsonl$/, "");
    if (filter.startDate && date < filter.startDate) continue;
    if (filter.endDate && date > filter.endDate) continue;
    if (beforeDate && date > beforeDate) continue;

    const entries = await readJsonlFile(path.join(dir, fileName));
    for (const entry of entries) {
      if (sessionIdSet && !sessionIdSet.has(entry.sessionId)) continue;
      if (
        sessionNeedle &&
        !entry.sessionId.toLowerCase().includes(sessionNeedle)
      ) continue;
      if (filter.domain && entry.domain !== filter.domain) continue;
      if (filter.before && entry.timestamp >= filter.before) continue;
      results.push(entry);
    }
  }

  return results;
}

/** List `*.jsonl` filenames in a directory, sorted lexicographically. */
async function listJsonlFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        names.push(entry.name);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names.sort();
}

/** Parse all JSON lines in a single JSONL file, skipping blank or malformed lines. */
async function readJsonlFile(filePath: string): Promise<AuditLogEntry[]> {
  try {
    const text = await readFile(filePath, "utf8");
    const entries: AuditLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as AuditLogEntry);
      } catch {
        // Skip malformed JSON lines
      }
    }
    return entries;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
