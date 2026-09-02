import { Database } from "bun:sqlite";
import * as path from "node:path";
import { ensureDir } from "../lib/fs_utils.ts";
import type {
  AuditLogEntry,
  AuditLogFilter,
  AuditPhase,
  AuditViolation,
  RequestBodyStorageLimits,
  RequestBodyStoreResult,
  RequestBodyWrite,
  RequestPolicyKind,
  RequestPolicyResult,
  StoredRequestBody,
} from "./types.ts";

/**
 * Resolve the directory where the audit SQLite database lives.
 *
 * Uses `$XDG_DATA_HOME/nas/audit/` with the standard fallback to
 * `~/.local/share/nas/audit/`.
 */
export function resolveAuditDir(): string {
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData && xdgData.trim().length > 0) {
    return path.join(xdgData, "nas", "audit");
  }
  const home = process.env.HOME;
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

function addColumnIfMissing(db: Database, definition: string): void {
  try {
    db.run(`ALTER TABLE audit_log ADD COLUMN ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column name")) throw error;
  }
}

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
        id               TEXT PRIMARY KEY,
        timestamp        TEXT NOT NULL,
        domain           TEXT NOT NULL,
        session_id       TEXT NOT NULL,
        request_id       TEXT NOT NULL,
        decision         TEXT NOT NULL,
        reason           TEXT NOT NULL,
        phase            TEXT,
        rule_id          TEXT,
        method           TEXT,
        route            TEXT,
        request_policy_kind   TEXT,
        request_policy_result TEXT,
        scope            TEXT,
        target           TEXT,
        command          TEXT,
        injected_headers TEXT,
        violations       TEXT,
        body_diagnostic  TEXT,
        body_audit_status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp
        ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_session
        ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_domain
        ON audit_log(domain);
      CREATE TABLE IF NOT EXISTS request_body (
        session_id      TEXT NOT NULL,
        request_id      TEXT NOT NULL,
        captured_at     TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        content_type    TEXT,
        content_encoding TEXT,
        byte_length     INTEGER NOT NULL,
        sha256          TEXT NOT NULL,
        body            BLOB NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );
    `);
    addColumnIfMissing(db, "injected_headers TEXT");
    addColumnIfMissing(db, "phase TEXT");
    addColumnIfMissing(db, "rule_id TEXT");
    addColumnIfMissing(db, "method TEXT");
    addColumnIfMissing(db, "route TEXT");
    addColumnIfMissing(db, "request_policy_kind TEXT");
    addColumnIfMissing(db, "request_policy_result TEXT");
    addColumnIfMissing(db, "violations TEXT");
    addColumnIfMissing(db, "body_diagnostic TEXT");
    addColumnIfMissing(db, "body_audit_status TEXT");
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
        decision, reason, phase, rule_id, method, route,
        request_policy_kind, request_policy_result,
        scope, target, command, injected_headers, violations, body_diagnostic,
        body_audit_status)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.timestamp,
    entry.domain,
    entry.sessionId,
    entry.requestId,
    entry.decision,
    entry.reason,
    entry.phase ?? null,
    entry.ruleId ?? null,
    entry.method ?? null,
    entry.route ?? null,
    entry.requestPolicyKind ?? null,
    entry.requestPolicyResult ?? null,
    entry.scope ?? null,
    entry.target ?? null,
    entry.command ?? null,
    entry.injectedHeaders !== undefined
      ? JSON.stringify(entry.injectedHeaders)
      : null,
    entry.violations !== undefined ? JSON.stringify(entry.violations) : null,
    entry.bodyDiagnostic !== undefined
      ? JSON.stringify(entry.bodyDiagnostic)
      : null,
    entry.requestBodyAuditStatus !== undefined
      ? JSON.stringify(entry.requestBodyAuditStatus)
      : null,
  );
}

/**
 * Retain one exact pre-policy request body in the host audit database.
 *
 * Invalid capture metadata and aggregate-capacity exhaustion are returned as
 * metadata-only statuses so neither condition needs to alter authorization.
 * Actual SQLite failures still throw for the caller to map to `store-failed`.
 */
export async function storeRequestBody(
  input: RequestBodyWrite,
  limits: RequestBodyStorageLimits,
  auditDir?: string,
): Promise<RequestBodyStoreResult> {
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0 ||
    input.byteLength !== input.body.byteLength ||
    requestBodySha256(input.body) !== input.sha256
  ) {
    return { state: "unavailable", code: "invalid-capture" };
  }

  const capturedAtMs = Date.parse(input.capturedAt);
  if (!Number.isFinite(capturedAtMs)) {
    return { state: "unavailable", code: "invalid-capture" };
  }
  if (
    !Number.isSafeInteger(limits.retentionSeconds) ||
    limits.retentionSeconds <= 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes <= 0
  ) {
    throw new RangeError(
      "request body retentionSeconds and maxTotalBytes must be positive safe integers",
    );
  }

  const expiresAtMs = capturedAtMs + limits.retentionSeconds * 1000;
  if (!Number.isFinite(expiresAtMs)) {
    return { state: "unavailable", code: "invalid-capture" };
  }
  const expiresAt = new Date(expiresAtMs).toISOString();
  const dir = auditDir ?? resolveAuditDir();
  await ensureDir(dir);
  const db = openDatabase(dir);

  const write = db.transaction((): RequestBodyStoreResult => {
    db.prepare("DELETE FROM request_body WHERE expires_at <= ?").run(
      new Date().toISOString(),
    );

    const existing = db
      .prepare(
        `SELECT byte_length, sha256
           FROM request_body
          WHERE session_id = ? AND request_id = ?`,
      )
      .get(input.sessionId, input.requestId) as ExistingRequestBodyRow | null;
    if (existing !== null) {
      if (
        existing.byte_length === input.byteLength &&
        existing.sha256 === input.sha256
      ) {
        return {
          state: "attached",
          byteLength: input.byteLength,
          sha256: input.sha256,
        };
      }
      return { state: "unavailable", code: "invalid-capture" };
    }

    const aggregate = db
      .prepare(
        "SELECT COALESCE(SUM(byte_length), 0) AS total_bytes FROM request_body",
      )
      .get() as { total_bytes: number };
    if (aggregate.total_bytes + input.byteLength > limits.maxTotalBytes) {
      return { state: "unavailable", code: "capacity" };
    }

    db.prepare(
      `INSERT INTO request_body
         (session_id, request_id, captured_at, expires_at, content_type,
          content_encoding, byte_length, sha256, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.requestId,
      input.capturedAt,
      expiresAt,
      input.contentType,
      input.contentEncoding,
      input.byteLength,
      input.sha256,
      input.body,
    );
    return {
      state: "attached",
      byteLength: input.byteLength,
      sha256: input.sha256,
    };
  });

  // Take the writer lock before capacity accounting so concurrent processes
  // cannot both observe the same free space and overfill the aggregate limit.
  return write.immediate();
}

/**
 * Fetch one retained body by its request identity.
 *
 * Expired rows are pruned first. The BLOB appears only in this explicit detail
 * query; normal audit-log queries select exclusively from `audit_log`.
 */
export async function getRequestBody(
  sessionId: string,
  requestId: string,
  auditDir?: string,
): Promise<StoredRequestBody | null> {
  const dir = auditDir ?? resolveAuditDir();
  const dbPath = path.join(dir, DB_FILENAME);
  if (!(await Bun.file(dbPath).exists())) return null;

  const db = openDatabase(dir);
  const read = db.transaction((): StoredRequestBody | null => {
    db.prepare("DELETE FROM request_body WHERE expires_at <= ?").run(
      new Date().toISOString(),
    );
    const row = db
      .prepare(
        `SELECT session_id, request_id, captured_at, expires_at, content_type,
                content_encoding, byte_length, sha256, body
           FROM request_body
          WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as RequestBodyRow | null;
    return row === null ? null : requestBodyRowToStored(row);
  });
  return read.immediate();
}

interface ExistingRequestBodyRow {
  byte_length: number;
  sha256: string;
}

interface RequestBodyRow extends ExistingRequestBodyRow {
  session_id: string;
  request_id: string;
  captured_at: string;
  expires_at: string;
  content_type: string | null;
  content_encoding: string | null;
  body: Uint8Array;
}

function requestBodyRowToStored(row: RequestBodyRow): StoredRequestBody {
  return {
    sessionId: row.session_id,
    requestId: row.request_id,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    contentType: row.content_type,
    contentEncoding: row.content_encoding,
    byteLength: row.byte_length,
    sha256: row.sha256,
    body: Uint8Array.from(row.body),
  };
}

function requestBodySha256(body: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Coerce a caller-supplied limit into a usable SQL bound.
 *
 * Returns `null` for "no limit" so the caller can distinguish it from a
 * limit of zero. A non-integer or non-positive value is treated as
 * absent rather than clamped: silently turning a bad limit into `LIMIT 1`
 * would hide the caller's bug behind plausible-looking output.
 */
function normaliseLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null;
  if (!Number.isInteger(limit) || limit <= 0) return null;
  return limit;
}

/**
 * Query audit log entries matching `filter`. Results are returned in
 * chronological order (oldest first) to match the previous JSONL-scanning
 * behaviour — callers that want the latest N entries pass `filter.limit`
 * rather than slicing the tail off a full result, which would scan the
 * whole table to throw most of it away.
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
  if (
    filter.excludeCommandPrefixes &&
    filter.excludeCommandPrefixes.length > 0
  ) {
    // Match both bare-argv0 form (`nas hook ...`) and absolute-path form
    // (`/opt/nas/hostexec/bin/nas hook ...`). The broker stores whatever
    // `argv0` the intercept library captured, which is usually the
    // PATH-resolved absolute path.
    for (const prefix of filter.excludeCommandPrefixes) {
      const escaped = prefix.replace(/[\\%_]/g, "\\$&");
      where.push(
        "(command IS NULL OR (command NOT LIKE ? ESCAPE '\\' AND command NOT LIKE ? ESCAPE '\\'))",
      );
      params.push(`${escaped}%`, `%/${escaped}%`);
    }
  }

  // A bounded query walks `idx_audit_timestamp` backwards and stops once
  // it has `limit` matching rows, so the caller pays for what it reads.
  // Unbounded, this is a full table scan: `excludeCommandPrefixes`
  // compiles to leading-wildcard `NOT LIKE` predicates, which no index
  // can satisfy, and the audit table grows without bound.
  //
  // DESC + reverse is chosen over ASC so the LIMIT keeps the *newest*
  // rows. `ORDER BY timestamp DESC, id DESC` reversed is exactly
  // `ORDER BY timestamp ASC, id ASC`, so bounded and unbounded results
  // are ordered identically.
  const limit = normaliseLimit(filter.limit);
  const direction = limit === null ? "ASC" : "DESC";
  const sql = `SELECT id, timestamp, domain, session_id, request_id,
                      decision, reason, phase, rule_id, method, route,
                      request_policy_kind, request_policy_result,
                      scope, target, command, injected_headers, violations,
                      body_diagnostic, body_audit_status
               FROM audit_log
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY timestamp ${direction}, id ${direction}
               ${limit === null ? "" : "LIMIT ?"}`;
  if (limit !== null) params.push(limit);

  const rows = db.prepare(sql).all(...params) as AuditLogRow[];
  if (limit !== null) rows.reverse();
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
  phase: string | null;
  rule_id: string | null;
  method: string | null;
  route: string | null;
  request_policy_kind: string | null;
  request_policy_result: string | null;
  scope: string | null;
  target: string | null;
  command: string | null;
  injected_headers: string | null;
  violations: string | null;
  body_diagnostic: string | null;
  body_audit_status: string | null;
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
  entry.phase =
    row.phase === null ? "authorization" : (row.phase as AuditPhase);
  if (row.rule_id !== null) entry.ruleId = row.rule_id;
  if (row.method !== null) entry.method = row.method;
  if (row.route !== null) entry.route = row.route;
  if (row.request_policy_kind !== null) {
    entry.requestPolicyKind = row.request_policy_kind as RequestPolicyKind;
  }
  if (row.request_policy_result !== null) {
    entry.requestPolicyResult =
      row.request_policy_result as RequestPolicyResult;
  }
  if (row.scope !== null) entry.scope = row.scope;
  if (row.target !== null) entry.target = row.target;
  if (row.command !== null) entry.command = row.command;
  if (row.injected_headers !== null)
    entry.injectedHeaders = JSON.parse(row.injected_headers) as string[];
  if (row.violations !== null)
    entry.violations = JSON.parse(row.violations) as AuditViolation[];
  if (row.body_diagnostic !== null) {
    entry.bodyDiagnostic = JSON.parse(
      row.body_diagnostic,
    ) as AuditLogEntry["bodyDiagnostic"];
  }
  if (row.body_audit_status !== null) {
    entry.requestBodyAuditStatus = JSON.parse(
      row.body_audit_status,
    ) as AuditLogEntry["requestBodyAuditStatus"];
  }
  return entry;
}

/** Add one day to a YYYY-MM-DD string (UTC). */
function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
