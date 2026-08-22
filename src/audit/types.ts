import type { BodyDiagnostic } from "../network/protocol.ts";

/** Domain of the audited action. */
export type AuditDomain = "network" | "hostexec";

/** Decision taken by the policy engine. */
export type AuditDecision = "allow" | "deny";

export type AuditPhase = "authorization" | "request-policy";

export type RequestPolicyKind = "bodyless" | "json";

export type RequestPolicyResult = "pass" | "rewrite" | "block";

/**
 * One acceptance-condition violation, as recorded in the audit log.
 *
 * The excerpt the approval UI shows is deliberately absent: it is the bulky
 * part of a finding and it says nothing the pointer and the value do not
 * already identify. Every field here is masked by the time it arrives.
 */
export interface AuditViolation {
  /** Position of the violated acceptance condition, or -1 when there is none. */
  expect: number;
  /** Selector of the condition, when it had one. */
  at: string;
  /** What kind of violation this was (`schema-mismatch`, ...). */
  kind: string;
  /** Masked JSON Pointer of the offending node. */
  pointer: string;
  /** Masked offending value, or null for a condition that has no value. */
  value: string | null;
  /** How many violations of this condition carried this value. */
  count: number;
}

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
  /** Processing phase. An absent phase means a legacy authorization entry. */
  phase?: AuditPhase;
  /** Identifier of the rule whose request policy produced the outcome. */
  ruleId?: string;
  /** HTTP method for a request-policy outcome. */
  method?: string;
  /** HTTP route for a request-policy outcome. */
  route?: string;
  /** Kind of request policy that processed the request. */
  requestPolicyKind?: RequestPolicyKind;
  /** Result produced by the request policy. */
  requestPolicyResult?: RequestPolicyResult;
  /** Cause reported for the selected indeterminate authorization rule. */
  bodyDiagnostic?: BodyDiagnostic;
  /**
   * Acceptance-condition violations the body inspection found.
   *
   * The reason field says a request was refused for a `schema-mismatch`; only
   * this says which condition matched nothing and what value it saw, which is
   * what someone reading the log after the session has ended needs.
   */
  violations?: AuditViolation[];
  /** Optional scope label (e.g. allowlist rule name). */
  scope?: string;
  /** Network-specific: the target host / URL. */
  target?: string;
  /** Network-specific: header names injected by credential rules. */
  injectedHeaders?: string[];
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
  /**
   * Exclude entries whose `command` matches any of these prefixes — either
   * as a bare prefix (`nas hook ...`) or after a path separator
   * (`/opt/nas/hostexec/bin/nas hook ...`). Useful for hiding noisy
   * internal commands like "nas hook".
   */
  excludeCommandPrefixes?: string[];
}
