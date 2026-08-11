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

/**
 * 所見の種別。
 *
 * - `schema-mismatch`: 受理条件が要求する形になっていない。
 * - `unexpected-body`: `EmptyBody` に対してボディが存在した。
 * - `body-unavailable`: `EmptyBody` に対してボディを読めなかった。
 * - `inspection-incomplete`: セレクタの走査が予算を使い切り、部分木を
 *   検査しないまま終わった。何が違反したかを言えないので承認できない。
 * - `findings-truncated`: 保持上限に達し、記述しなかった違反がある。
 *   識別子も値も持たないので承認できない。
 */
export const VIOLATION_FINDING_KINDS = [
  "schema-mismatch",
  "unexpected-body",
  "body-unavailable",
  "inspection-incomplete",
  "findings-truncated",
] as const;

export type ViolationFindingKind = (typeof VIOLATION_FINDING_KINDS)[number];

/** 承認の単位を成せる所見の種別。残りは記述を欠くので押せる対象にならない。 */
const APPROVABLE_FINDING_KINDS: readonly ViolationFindingKind[] = [
  "schema-mismatch",
  "unexpected-body",
  "body-unavailable",
];

/**
 * 受理条件の違反 1 件。
 *
 * ボディ由来のフィールド (`pointer` / `value` / `excerpt`) は addon が
 * マスクしてから載せる。承認 UI と監査ログに出ていく記録なので、生の秘密が
 * 載っていてはならない。
 */
export interface ViolationFinding {
  /**
   * 違反した受理条件の `expect` 内の位置。承認の同一性の一部である。
   * 受理条件に紐づかない記録 (`inspection-incomplete`) は -1。
   */
  expect: number;
  /** 受理条件の種別。位置の代わりに UI が出す。紐づかない記録では空。 */
  expectKind: string;
  /** `UnionShape` のセレクタ。UI が「どこを見た条件か」を出すのに使う。 */
  at: string;
  kind: ViolationFindingKind;
  /** マスク済みの JSON Pointer。値を持たない受理条件では空。 */
  pointer: string;
  /** マスク済みの違反した値。承認の同一性の一部。値がない条件では null。 */
  value: string | null;
  /** マスク済みの、そのノードだけの抜粋。 */
  excerpt: string | null;
  /** 同じ (受理条件, 値) の違反の件数。 */
  count: number;
}

/**
 * その所見が承認の単位を成すか。
 *
 * 承認の同一性は (ルール ID, 受理条件の位置, 違反した値) なので、位置か値の
 * どちらかを欠く記録は押せる対象にならない。走査が完了しなかった記録と、
 * 保持上限で畳まれた記録がそれである。押せないものを承認 UI に出すと、押した
 * 人が通したつもりのリクエストが通らないままになる。
 */
export function isApprovableFinding(finding: ViolationFinding): boolean {
  return (
    finding.expect >= 0 &&
    APPROVABLE_FINDING_KINDS.some((kind) => kind === finding.kind)
  );
}

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
  /**
   * 検査が見つけた違反。違反が無ければ空。
   *
   * 帰結は `result` と `reason` で閉じているので、これは記録のためにある。
   * どの受理条件がどの値で落ちたかは理由の語彙では言えず、監査ログに残らないと
   * 「schema-mismatch で 403」以上のことが後から分からない。
   */
  findings?: ViolationFinding[];
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
  "findings",
]);

/**
 * 1 通のメッセージが運べる所見の件数。
 *
 * addon 側の上限は「受理条件ごとに 64 件 + 打ち切りの記録」なので、受理条件を
 * 15 本置いても届かない。broker がこれを持つのは、addon の上限を信じずに
 * 自分の側でメモリを閉じるためである。
 */
const MAX_FINDINGS = 1024;
/** マスク済みの値の長さ。addon は 276 文字で畳むので、その倍を天井にする。 */
const MAX_FINDING_VALUE_CHARS = 552;
const MAX_FINDING_POINTER_CHARS = 1024;
const MAX_FINDING_EXCERPT_CHARS = 2048;
const MAX_FINDING_SELECTOR_CHARS = 512;
const FINDING_FIELDS = new Set([
  "expect",
  "expectKind",
  "at",
  "kind",
  "pointer",
  "value",
  "excerpt",
  "count",
]);
const EXPECT_KINDS = ["", "emptyBody", "jsonRoot", "unionShape"] as const;

function isBoundedString(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length <= max;
}

function isBoundedNullableString(value: unknown, max: number): boolean {
  return value === null || isBoundedString(value, max);
}

/**
 * 所見の列を検証する。
 *
 * 所見は addon がボディから組み立てたもので、値もポインタも抜粋も
 * 攻撃者が選んだ文字列に由来する。長さと件数をここで閉じないと、承認 UI と
 * 監査ログとメモリがボディの大きさに引きずられる。
 */
export function validateViolationFindings(value: unknown): string | null {
  if (!Array.isArray(value)) return "invalid violation findings";
  if (value.length > MAX_FINDINGS) return "too many violation findings";
  for (const finding of value) {
    if (
      typeof finding !== "object" ||
      finding === null ||
      Array.isArray(finding)
    ) {
      return "invalid violation finding";
    }
    const record = finding as Record<string, unknown>;
    if (Object.keys(record).some((field) => !FINDING_FIELDS.has(field))) {
      return "invalid violation finding";
    }
    if (
      !Number.isSafeInteger(record.expect) ||
      (record.expect as number) < -1 ||
      !isListedValue(record.expectKind, EXPECT_KINDS) ||
      !isBoundedString(record.at, MAX_FINDING_SELECTOR_CHARS) ||
      !isListedValue(record.kind, VIOLATION_FINDING_KINDS) ||
      !isBoundedString(record.pointer, MAX_FINDING_POINTER_CHARS) ||
      !isBoundedNullableString(record.value, MAX_FINDING_VALUE_CHARS) ||
      !isBoundedNullableString(record.excerpt, MAX_FINDING_EXCERPT_CHARS) ||
      !Number.isSafeInteger(record.count) ||
      (record.count as number) < 1
    ) {
      return "invalid violation finding";
    }
  }
  return null;
}
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
  if (message.findings !== undefined) {
    const findingsError = validateViolationFindings(message.findings);
    if (findingsError) return findingsError;
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
