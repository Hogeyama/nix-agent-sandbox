import { Database } from "bun:sqlite";
import * as path from "node:path";
import { ensureDir } from "../lib/fs_utils.ts";
import type { AuditLogEntry, AuditLogFilter } from "./types.ts";

/**
 * Resolve the directory where the audit SQLite database lives.
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

/** Database filename within the audit directory. */
const DB_FILENAME = "audit.db";

/**
 * Cache of opened database handles, keyed by directory. SQLite connections
 * are cheap to reuse and WAL checkpoints happen automatically in the
 * background, so we keep one handle per directory for the lifetime of the
 * process. Tests that use unique temp dirs simply leak their handle at
 * process exit, which is fine.
 */
const dbCache = new Map<string, Database>();

function openDatabase(dir: string): Database {
  const cached = dbCache.get(dir);
  if (cached) return cached;

  const dbPath = path.join(dir, DB_FILENAME);
  const db = new Database(dbPath, { create: true });
  try {
    // WAL lets multiple reader processes run while a single writer is
    // active, and keeps writes fast without risking torn entries under
    // contention. NORMAL sync is the WAL sweet spot: crash-safe against
    // app crashes and still far faster than FULL.
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    // Auto-retry on SQLITE_BUSY for up to 5s. Relevant when multiple
    // brokers race on the writer lock.
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");

    db.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id         TEXT PRIMARY KEY,
        timestamp  TEXT NOT NULL,
        domain     TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        decision   TEXT NOT NULL,
        reason     TEXT NOT NULL,
        scope      TEXT,
        target     TEXT,
        command    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp
        ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_session
        ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_domain
        ON audit_log(domain);
    `);
  } catch (e) {
    // Init failed partway — release the handle so the file lock isn't
    // held for the rest of the process lifetime.
    try {
      db.close();
    } catch {
      // Nothing else we can do; surface the original error below.
    }
    throw e;
  }

  dbCache.set(dir, db);
  return db;
}

/**
 * Test-only helper: close and forget any cached handle for `dir`. Useful
 * when a test wants to reopen a database after mutating its file on disk,
 * or when unit tests need a clean slate.
 */
export function _closeAuditDb(dir: string): void {
  const db = dbCache.get(dir);
  if (db) {
    db.close();
    dbCache.delete(dir);
  }
}

/**
 * Append a single audit log entry.
 *
 * Concurrent writers — whether from the same process or across processes —
 * are serialised by SQLite's WAL writer lock, so entries are never torn or
 * interleaved.
 */
export async function appendAuditLog(
  entry: AuditLogEntry,
  auditDir?: string,
): Promise<void> {
  const dir = auditDir ?? resolveAuditDir();
  await ensureDir(dir);

  const db = openDatabase(dir);
  db.prepare(
    `INSERT OR REPLACE INTO audit_log
       (id, timestamp, domain, session_id, request_id,
        decision, reason, scope, target, command)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.timestamp,
    entry.domain,
    entry.sessionId,
    entry.requestId,
    entry.decision,
    entry.reason,
    entry.scope ?? null,
    entry.target ?? null,
    entry.command ?? null,
  );
}

/**
 * Query audit log entries matching `filter`. Results are returned in
 * chronological order (oldest first) to match the previous JSONL-scanning
 * behaviour — callers that want the latest N entries typically slice the
 * tail.
 *
 * An empty `sessionIds` array means "match nothing" (the explicit empty
 * set), not "match everything".
 */
export async function queryAuditLogs(
  filter: AuditLogFilter = {},
  auditDir?: string,
): Promise<AuditLogEntry[]> {
  const dir = auditDir ?? resolveAuditDir();

  // Empty sessionIds set is an explicit "match nothing" — short-circuit
  // before touching the database so the caller semantics are preserved.
  if (filter.sessionIds !== undefined && filter.sessionIds.length === 0) {
    return [];
  }

  // Don't create the db on a pure query — if the audit directory has
  // never been written to, return an empty result without materialising
  // an empty database file on disk.
  const dbPath = path.join(dir, DB_FILENAME);
  if (!(await Bun.file(dbPath).exists())) return [];

  const db = openDatabase(dir);

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.startDate) {
    // Inclusive of the whole start day (UTC). Entries are stored as ISO
    // strings with a Z suffix, so lexicographic comparison coincides with
    // chronological comparison for any Z-terminated timestamp.
    where.push("timestamp >= ?");
    params.push(`${filter.startDate}T00:00:00Z`);
  }
  if (filter.endDate) {
    // Inclusive of the whole end day (UTC): strictly less than the start
    // of the next day.
    where.push("timestamp < ?");
    params.push(`${nextDay(filter.endDate)}T00:00:00Z`);
  }
  if (filter.before) {
    where.push("timestamp < ?");
    params.push(filter.before);
  }
  if (filter.domain) {
    where.push("domain = ?");
    params.push(filter.domain);
  }
  if (filter.sessionIds && filter.sessionIds.length > 0) {
    const placeholders = filter.sessionIds.map(() => "?").join(", ");
    where.push(`session_id IN (${placeholders})`);
    params.push(...filter.sessionIds);
  }
  if (filter.sessionContains) {
    // LIKE with NOCASE collation for case-insensitive substring match.
    // Escape `%`, `_`, and the escape char itself so user input can't
    // accidentally inject wildcards.
    const escaped = filter.sessionContains.replace(/[\\%_]/g, "\\$&");
    where.push("session_id LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(`%${escaped}%`);
  }

  const sql = `SELECT id, timestamp, domain, session_id, request_id,
                      decision, reason, scope, target, command
               FROM audit_log
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY timestamp ASC, id ASC`;

  const rows = db.prepare(sql).all(...params) as AuditLogRow[];
  return rows.map(rowToEntry);
}

interface AuditLogRow {
  id: string;
  timestamp: string;
  domain: string;
  session_id: string;
  request_id: string;
  decision: string;
  reason: string;
  scope: string | null;
  target: string | null;
  command: string | null;
}

function rowToEntry(row: AuditLogRow): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: row.id,
    timestamp: row.timestamp,
    domain: row.domain as AuditLogEntry["domain"],
    sessionId: row.session_id,
    requestId: row.request_id,
    decision: row.decision as AuditLogEntry["decision"],
    reason: row.reason,
  };
  if (row.scope !== null) entry.scope = row.scope;
  if (row.target !== null) entry.target = row.target;
  if (row.command !== null) entry.command = row.command;
  return entry;
}

/** Add one day to a YYYY-MM-DD string (UTC). */
function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
