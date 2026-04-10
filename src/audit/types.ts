/** Domain of the audited action. */
export type AuditDomain = "network" | "hostexec";

/** Decision taken by the policy engine. */
export type AuditDecision = "allow" | "deny";

/** A single audit log entry persisted to JSONL. */
export interface AuditLogEntry {
  /** Unique identifier (UUID v4). */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Which subsystem produced the entry. */
  domain: AuditDomain;
  /** The sandbox session that triggered the action. */
  sessionId: string;
  /** Correlation id for the individual request. */
  requestId: string;
  /** Whether the action was permitted. */
  decision: AuditDecision;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Optional scope label (e.g. allowlist rule name). */
  scope?: string;
  /** Network-specific: the target host / URL. */
  target?: string;
  /** Hostexec-specific: the command that was requested. */
  command?: string;
}

/** Filter criteria for {@link queryAuditLogs}. All fields are optional; omitted fields match everything. */
export interface AuditLogFilter {
  /** Inclusive start date (YYYY-MM-DD). */
  startDate?: string;
  /** Inclusive end date (YYYY-MM-DD). */
  endDate?: string;
  /**
   * Exclusive upper-bound cursor (ISO-8601 timestamp). Returns entries
   * with `timestamp < before`. Used by the UI's infinite scroll to page
   * into older history.
   */
  before?: string;
  /**
   * Restrict to entries whose `sessionId` is a member of this set.
   * Empty array means "match nothing" (use `undefined` to skip the filter).
   */
  sessionIds?: string[];
  /**
   * Restrict to entries whose `sessionId` contains this substring
   * (case-insensitive). Composed with `sessionIds` (both must match).
   */
  sessionContains?: string;
  /** Filter by domain. */
  domain?: AuditDomain;
}
