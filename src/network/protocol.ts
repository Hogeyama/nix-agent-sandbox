import { isIP } from "node:net";
import type { ReviewRule } from "../config/types.ts";
import { isDeniedIpAddress } from "./ip_policy.ts";

export type ApprovalScope = "once" | "host-port" | "host";
export type RequestKind = "connect" | "forward";
export type Decision = "allow" | "deny";

export interface InjectHeader {
  name: string;
  value: string;
}

export interface ResolvedCredential {
  host: string;
  pathPrefix?: string;
  method?: string;
  header: string;
  value: string;
}

export interface SessionCredentials {
  sessionId: string;
  token: string;
}

export interface NormalizedTarget {
  host: string;
  port: number;
}

export interface ReviewContext {
  path: string;
  contentType: string | null;
  bodyPreview: string | null;
  bodySize: number;
}

export interface AuthorizeRequest {
  version: 1;
  type: "authorize";
  requestId: string;
  sessionId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  observedAt: string;
  reviewContext?: ReviewContext;
}

export interface DecisionResponse {
  version: 1;
  type: "decision";
  requestId: string;
  decision: Decision;
  scope?: ApprovalScope;
  reason: string;
  /** Authoritative ID of the resolved rule that allowed this request. */
  ruleId?: string;
  message?: string;
  injectHeaders?: InjectHeader[];
  /** allow のとき、プロキシがリクエストから ****
   * へ置換すべき秘密値 (nas_addon.py が消費)。 */
  maskValues?: string[];
}

export const REQUEST_POLICY_SUCCESS_REASONS = [
  "empty-body",
  "recognized-json",
  "masked-json",
] as const;

export const REQUEST_POLICY_BLOCK_REASONS = [
  "body-unavailable",
  "unexpected-body",
  "invalid-json",
  "schema-mismatch",
  "encoded-decode-failed",
  "resource-limit",
  "key-collision",
  "serialization-failed",
  "processing-failed",
] as const;

export type RequestPolicyReason =
  | (typeof REQUEST_POLICY_SUCCESS_REASONS)[number]
  | (typeof REQUEST_POLICY_BLOCK_REASONS)[number];

export interface RequestPolicyOutcomeRequest {
  version: 1;
  type: "request_policy_outcome";
  requestId: string;
  sessionId: string;
  ruleId: string;
  result: "pass" | "rewrite" | "block";
  reason: RequestPolicyReason;
}

export interface RequestPolicyOutcomeResponse {
  version: 1;
  type: "request_policy_outcome_recorded";
  requestId: string;
}

const REQUEST_POLICY_OUTCOME_FIELDS = new Set([
  "version",
  "type",
  "requestId",
  "sessionId",
  "ruleId",
  "result",
  "reason",
]);
const SAFE_RULE_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const REQUEST_POLICY_RESULTS = ["pass", "rewrite", "block"] as const;

export function validateRequestPolicyOutcome(
  value: unknown,
  expectedSessionId: string,
  rules: readonly ReviewRule[],
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "invalid request-policy outcome request";
  }
  const message = value as Record<string, unknown>;
  if (
    message.version !== 1 ||
    message.type !== "request_policy_outcome" ||
    typeof message.requestId !== "string"
  ) {
    return "invalid request-policy outcome request";
  }
  if (message.sessionId !== expectedSessionId) {
    return "request-policy outcome session mismatch";
  }
  if (
    Object.keys(message).some(
      (field) => !REQUEST_POLICY_OUTCOME_FIELDS.has(field),
    )
  ) {
    return "invalid request-policy outcome request";
  }
  if (
    typeof message.ruleId !== "string" ||
    !SAFE_RULE_ID.test(message.ruleId)
  ) {
    return "invalid request-policy outcome rule ID";
  }
  const rule = rules.find((candidate) => candidate.id === message.ruleId);
  if (rule === undefined) {
    return "unknown request-policy outcome rule ID";
  }
  if (rule.requestPolicy === undefined) {
    return "request-policy outcome rule has no policy";
  }
  if (!isListedValue(message.result, REQUEST_POLICY_RESULTS)) {
    return "invalid request-policy outcome result";
  }
  const reasons = [
    ...REQUEST_POLICY_SUCCESS_REASONS,
    ...REQUEST_POLICY_BLOCK_REASONS,
  ] as const;
  if (!isListedValue(message.reason, reasons)) {
    return "invalid request-policy outcome reason";
  }

  const result = message.result;
  const reason = message.reason;
  if (rule.requestPolicy.kind === "bodyless") {
    const valid =
      (result === "pass" && reason === "empty-body") ||
      (result === "block" &&
        (reason === "body-unavailable" ||
          reason === "unexpected-body" ||
          reason === "processing-failed"));
    return valid
      ? null
      : "invalid request-policy outcome result/reason pairing";
  }
  if (rule.requestPolicy.kind !== "json") {
    return "invalid request-policy outcome policy kind";
  }

  const valid =
    (result === "pass" && reason === "recognized-json") ||
    (result === "rewrite" && reason === "masked-json") ||
    (result === "block" &&
      (reason === "body-unavailable" ||
        reason === "invalid-json" ||
        reason === "schema-mismatch" ||
        reason === "encoded-decode-failed" ||
        reason === "resource-limit" ||
        reason === "key-collision" ||
        reason === "serialization-failed" ||
        reason === "processing-failed"));
  return valid ? null : "invalid request-policy outcome result/reason pairing";
}

export interface PendingEntry {
  version: 1;
  sessionId: string;
  requestId: string;
  target: NormalizedTarget;
  method: string;
  requestKind: RequestKind;
  state: "pending";
  createdAt: string;
  updatedAt: string;
  reviewContext?: ReviewContext;
}

export interface SessionRegistryEntry {
  version: 1;
  sessionId: string;
  tokenHash: string;
  brokerSocket: string;
  profileName: string;
  createdAt: string;
  pid: number;
  agent?: string;
}

export interface NormalizeTargetInput {
  method: string;
  authority?: string | null;
  url?: string | null;
  hostHeader?: string | null;
}

export function generateSessionId(): string {
  return `sess_${randomHex(6)}`;
}

export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export function decodeProxyAuthorization(
  header: string | null | undefined,
): SessionCredentials | null {
  if (!header) return null;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = atob(match[1].trim());
    const idx = decoded.indexOf(":");
    if (idx <= 0 || idx === decoded.length - 1) {
      return null;
    }
    return {
      sessionId: decoded.slice(0, idx),
      token: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

export function normalizeTarget(input: NormalizeTargetInput): NormalizedTarget {
  const method = input.method.toUpperCase();
  if (method === "CONNECT") {
    const authority = parseAuthority(input.authority ?? input.hostHeader ?? "");
    if (authority.port === null) {
      throw new Error("CONNECT target must include an explicit port");
    }
    return {
      host: normalizeHost(authority.host),
      port: authority.port,
    };
  }

  if (input.url) {
    try {
      const url = new URL(input.url);
      return {
        host: normalizeHost(url.hostname),
        port: Number(url.port || defaultPortForScheme(url.protocol)),
      };
    } catch {
      // Fall through to Host/:authority parsing.
    }
  }

  const authority = parseAuthority(input.authority ?? input.hostHeader ?? "");
  return {
    host: normalizeHost(authority.host),
    port: authority.port ?? 80,
  };
}

export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  while (value.endsWith(".")) {
    value = value.slice(0, -1);
  }
  if (value.length === 0) {
    throw new Error("host must not be empty");
  }
  return value;
}

/**
 * Parses an allowlist/denylist entry into its host and optional port parts.
 * Supports: "example.com", "example.com:443", "*.example.com", "*.example.com:443",
 * "[::1]", "[::1]:8080"
 */
export function parseAllowlistEntry(entry: string): {
  host: string;
  port: number | null;
} {
  const withoutWildcard = entry.startsWith("*.") ? entry.slice(2) : entry;
  const wildcardPrefix = entry.startsWith("*.") ? "*." : "";

  if (withoutWildcard.startsWith("[")) {
    const end = withoutWildcard.indexOf("]");
    if (end === -1) throw new Error(`invalid entry: ${entry}`);
    const host = wildcardPrefix + withoutWildcard.slice(0, end + 1);
    const rest = withoutWildcard.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(":")) throw new Error(`invalid entry: ${entry}`);
    return { host, port: parsePort(rest.slice(1)) };
  }

  const colonIdx = withoutWildcard.lastIndexOf(":");
  if (colonIdx <= 0) return { host: entry, port: null };

  // Check if everything after the last colon looks like a port number.
  // If not, treat the whole thing as a host (e.g., bare IPv6 without brackets).
  const maybePart = withoutWildcard.slice(colonIdx + 1);
  if (!/^\d+$/.test(maybePart)) return { host: entry, port: null };

  const port = parsePort(maybePart);
  const hostPart = withoutWildcard.slice(0, colonIdx);
  return { host: wildcardPrefix + hostPart, port };
}

export function matchesHostPattern(
  target: NormalizedTarget,
  patterns: string[],
): boolean {
  const normalizedHost = normalizeHost(target.host);
  return patterns.some((entry) => {
    const parsed = parseAllowlistEntry(entry);
    // If the entry specifies a port, both host and port must match.
    if (parsed.port !== null && parsed.port !== target.port) return false;
    const hostEntry = parsed.host;
    const candidate = normalizeHost(
      hostEntry.startsWith("*.") ? hostEntry.slice(2) : hostEntry,
    );
    if (hostEntry.startsWith("*.")) {
      return (
        normalizedHost === candidate || normalizedHost.endsWith(`.${candidate}`)
      );
    }
    return normalizedHost === candidate;
  });
}

export function targetKey(target: NormalizedTarget): string {
  return `${target.host}:${target.port}`;
}

export function targetKeyForScope(
  target: NormalizedTarget,
  scope: ApprovalScope,
): string {
  if (scope === "host") return target.host;
  return targetKey(target);
}

export function matchesPathPrefix(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  if (path.length === prefix.length) return true;
  if (prefix.endsWith("/")) return true;
  const next = path[prefix.length];
  return next === "/" || next === "?";
}

export function denyReasonForTarget(target: NormalizedTarget): string | null {
  const host = normalizeHost(target.host);
  if (host === "localhost") return "blocked-special-host";
  if (isIP(host) !== 0 && isDeniedIpAddress(host)) {
    return "blocked-private-ip";
  }
  return null;
}

function parseAuthority(authority: string): {
  host: string;
  port: number | null;
} {
  const value = authority.trim();
  if (value.length === 0) {
    throw new Error("authority is required");
  }

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) {
      throw new Error("invalid IPv6 authority");
    }
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(":")) {
      throw new Error("invalid IPv6 authority");
    }
    return { host, port: parsePort(rest.slice(1)) };
  }

  const colonIdx = value.lastIndexOf(":");
  if (
    colonIdx <= 0 ||
    (value.includes(":") && value.indexOf(":") !== colonIdx)
  ) {
    return { host: value, port: null };
  }
  return {
    host: value.slice(0, colonIdx),
    port: parsePort(value.slice(colonIdx + 1)),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

function defaultPortForScheme(protocol: string): number {
  if (protocol === "https:") return 443;
  return 80;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isListedValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === "string" && allowed.some((item) => item === value);
}
