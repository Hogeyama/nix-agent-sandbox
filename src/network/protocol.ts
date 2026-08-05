import { isIP } from "node:net";
import type { ResolvedDocument } from "./authz/resolve.ts";
import { isDeniedIpAddress } from "./ip_policy.ts";

/**
 * 承認をどこまで覚えるか。
 *
 * 承認の同一性は (ルール ID, ターゲット) であり、ここで選べるのはその
 * ターゲット成分の広さだけである。どの粒度を出すかはマッチしたルールの
 * 具体性から決まる (`src/network/broker.ts`)。
 *
 * - `once`: 何も覚えない。
 * - `rule`: そのルールが有効な間ずっと。ターゲットをスコープが 1 つの
 *   ホストとポートに固定しているときだけ選べる。
 * - `host-port`: そのホストとポートに対して。
 * - `host`: そのホストの全ポートに対して。
 */
export type ApprovalScope = "once" | "rule" | "host-port" | "host";
export type RequestKind = "connect" | "forward";
export type Decision = "allow" | "deny";

export interface InjectHeader {
  name: string;
  value: string;
}

/**
 * 承認 UI に出す注入ヘッダーの姿。
 *
 * ヘッダー名と、その値が参照する秘密の名前だけを持つ。値を持つ
 * `InjectHeader` とは別の型なので、人が見る面へ値の付いた方を載せようと
 * すると型エラーになる。
 */
export interface InjectHeaderPreview {
  name: string;
  /** 参照する秘密の名前。`literal:` だけの値では空。 */
  secrets: string[];
}

export interface SessionCredentials {
  sessionId: string;
  token: string;
}

export interface NormalizedTarget {
  host: string;
  port: number;
}

/**
 * ボディについて、選択に効く事実だけ。
 *
 * addon がボディを読んで分類し、broker がそれを使って `decide` を回す。
 * broker はボディそのものを受け取らないので、`match.body.format` の 3 値評価に
 * 必要な最小限だけをここに載せる。
 *
 * - `absent`: ボディが存在しない。
 * - `empty`: ボディが存在し、長さが 0 である。
 * - `binary`: ボディが存在し、JSON として解析できない。
 * - `json`: ボディが存在し、JSON として解析できる。
 */
export type BodyKind = "absent" | "empty" | "binary" | "json";

export const BODY_KINDS = [
  "absent",
  "empty",
  "binary",
  "json",
] as const satisfies readonly BodyKind[];

export interface ReviewContext {
  path: string;
  contentType: string | null;
  bodyPreview: string | null;
  bodySize: number;
  bodyKind: BodyKind;
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
  /** allow のとき、出現したらリクエストを拒否すべき秘密値。 */
  forbidValues?: string[];
}

export const REQUEST_POLICY_SUCCESS_REASONS = [
  /** 受理条件を持たないルールなので、ボディを検査していない。 */
  "no-inspection",
  /** EmptyBody が満たされた。 */
  "empty-body",
  /** JSON を解析し、受理条件をすべて満たした。 */
  "recognized-json",
  /** 違反はあったが、すべて onViolation = "allow" だった。 */
  "violations-allowed",
  /** 秘密をマスクしてボディを書き換えた。 */
  "masked-json",
] as const;

export const REQUEST_POLICY_BLOCK_REASONS = [
  "body-unavailable",
  "unexpected-body",
  "invalid-json",
  "schema-mismatch",
  "forbidden-secret",
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
/** ルールの実 ID は `<スコープ名>.<キー>`。擬似 ID は `$fallback` で終わる。 */
const SAFE_RULE_ID = /^[a-z][a-z0-9._-]{0,63}(?:\.\$fallback)?$/;
const REQUEST_POLICY_RESULTS = ["pass", "rewrite", "block"] as const;

/** 解決済みドキュメントに存在するルール ID か。 */
export function documentHasRuleId(
  document: ResolvedDocument,
  ruleId: string,
): boolean {
  return document.scopes.some(
    (scope) =>
      scope.fallbackRuleId === ruleId ||
      scope.rules.some((rule) => rule.id === ruleId),
  );
}

export function validateRequestPolicyOutcome(
  value: unknown,
  expectedSessionId: string,
  document: ResolvedDocument,
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
  if (!documentHasRuleId(document, message.ruleId)) {
    return "unknown request-policy outcome rule ID";
  }
  if (!isListedValue(message.result, REQUEST_POLICY_RESULTS)) {
    return "invalid request-policy outcome result";
  }
  if (
    !isListedValue(message.reason, [
      ...REQUEST_POLICY_SUCCESS_REASONS,
      ...REQUEST_POLICY_BLOCK_REASONS,
    ] as const)
  ) {
    return "invalid request-policy outcome reason";
  }

  // 結果と理由の組み合わせを閉じる。ボディ検査を通したという報告に拒否の理由が
  // 付いていたら、addon と broker のどちらかが壊れている。
  const reason = message.reason;
  const consistent =
    message.result === "block"
      ? isListedValue(reason, REQUEST_POLICY_BLOCK_REASONS)
      : message.result === "rewrite"
        ? reason === "masked-json" || reason === "violations-allowed"
        : isListedValue(reason, REQUEST_POLICY_SUCCESS_REASONS) &&
          reason !== "masked-json";
  return consistent
    ? null
    : "invalid request-policy outcome result/reason pairing";
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
  /** この確認を起こしたルール。承認の同一性の片割れであり、擬似 ID もありうる。 */
  ruleId: string;
  /** この確認で選べる粒度。ルールの具体性から導出される。 */
  approvalScopes: ApprovalScope[];
  /** 承認したときに注入されるヘッダー。名前だけで、値は載らない。 */
  injectHeaders: InjectHeaderPreview[];
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
