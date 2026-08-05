import { mkdir, rm, rmdir } from "node:fs/promises";
import * as path from "node:path";
import { appendAuditLog } from "../audit/store.ts";
import type { AuditLogEntry } from "../audit/types.ts";
import { TtlLruCache } from "../lib/ttl_lru_cache.ts";
import {
  connectUnix,
  createUnixServer,
  readJsonLine,
  type Server,
  type Socket,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { logInfo } from "../log.ts";
import {
  type Decision as AuthzDecision,
  type DecisionReason,
  decide,
  pathForSelection,
  type ResolvedDocument,
  type ResolvedRule,
  type ResolvedScope,
} from "./authz/resolve.ts";
import type { RequestBody } from "./authz/types.ts";
import {
  expandMaskPatterns,
  maskReviewContextWithPatterns,
} from "./mask_patterns.ts";
import {
  closeNotification,
  notifyPendingRequest,
  type ResolvedNotifyBackend,
} from "./notify.ts";
import {
  type ApprovalScope,
  type AuthorizeRequest,
  type BodyKind,
  type DecisionResponse,
  denyReasonForTarget,
  type InjectHeaderPreview,
  type NormalizedTarget,
  type PendingEntry,
  type RequestPolicyOutcomeRequest,
  type RequestPolicyOutcomeResponse,
  type ReviewContext,
  targetKey,
  validateRequestPolicyOutcome,
} from "./protocol.ts";
import type { NetworkRuntimePaths } from "./registry.ts";
import {
  brokerSocketPath,
  listPendingEntries,
  removePendingDir,
  removePendingEntry,
  writePendingEntry,
} from "./registry.ts";
import {
  describeInjectHeaders,
  forbidValuesFor,
  maskValuesFor,
  renderInjectHeaders,
  type SecretValues,
} from "./secrets.ts";

interface BrokerOptions {
  paths: NetworkRuntimePaths;
  sessionId: string;
  /** セッション開始時に 1 度だけ解決した認可ドキュメント。 */
  document: ResolvedDocument;
  pendingTimeoutSeconds: number;
  pendingNotify: ResolvedNotifyBackend;
  uiEnabled?: boolean;
  uiPort?: number;
  uiIdleTimeout?: number;
  /** Override negative-cache TTL for testing. Default: 30 000 ms. */
  negativeCacheTtlMs?: number;
  /** Directory for audit JSONL logs. If set, decisions are recorded. */
  auditDir?: string;
  /** 名前 → 解決済みの値。注入・マスク・拒否はすべてここを引く。 */
  secretValues?: SecretValues;
  /**
   * プロキシでの秘密の置換と拒否を行うか (`mask.proxy`)。
   *
   * `false` のセッションでは `inject` 以外の扱いを実現できないので、`mask` や
   * `forbid` を持つスコープがある設定はそもそも起動しない。注入だけは
   * マスクを経由しないので効き続ける。
   */
  proxyMasking?: boolean;
}

interface PendingWaiter {
  resolve: (response: DecisionResponse) => void;
  reject: (error: unknown) => void;
}

interface PendingGroup {
  groupKey: string;
  /** 承認の同一性の一部。この確認を起こしたルール、または擬似 ID。 */
  ruleId: string;
  /** 承認の同一性の一部。この確認に至った判定の理由。 */
  reason: DecisionReason;
  /** 承認されたら注入されるヘッダー。名前だけで、値は持たない。 */
  injectHeaders: readonly InjectHeaderPreview[];
  createdAt: string;
  target: AuthorizeRequest["target"];
  requests: Map<string, AuthorizeRequest>;
  decisions: Map<string, AuthzDecision>;
  waiters: Map<string, PendingWaiter>;
  timer: ReturnType<typeof setTimeout>;
  notificationAbort: AbortController;
  /**
   * この確認で選べる粒度。承認 UI に出したものと同じ集合であり、broker が
   * 最後の砦としてもう一度突き合わせる。/api/network/pending を読んで任意の
   * JSON を投げてくる相手が、出ていない粒度に広げることを防ぐ。
   */
  allowedScopes: readonly ApprovalScope[];
}

type BrokerMessage =
  | AuthorizeRequest
  | RequestPolicyOutcomeRequest
  | { type: "approve"; requestId: string; scope?: ApprovalScope }
  | { type: "deny"; requestId: string; scope?: ApprovalScope }
  | { type: "list_pending" };

type BrokerResponse =
  | DecisionResponse
  | RequestPolicyOutcomeResponse
  | { type: "pending"; items: PendingEntry[] }
  | { type: "ack"; requestId: string; decision: "approve" | "deny" }
  | { type: "error"; requestId: string; message: string };

/**
 * 粒度を言わずに押されたときの単位。
 *
 * どこまで広げるつもりだったかは押した側にしか分からないので、黙って広げず
 * そのリクエストにだけ効かせる。どの粒度も選べる確認では `once` が最も狭い。
 */
const DEFAULT_APPROVAL_SCOPE: ApprovalScope = "once";

export class SessionBroker {
  private readonly paths: NetworkRuntimePaths;
  private readonly sessionId: string;
  private readonly document: ResolvedDocument;
  private readonly timeoutSeconds: number;
  private readonly notify: ResolvedNotifyBackend;
  private readonly uiEnabled?: boolean;
  private readonly uiPort?: number;
  private readonly uiIdleTimeout?: number;
  private readonly auditDir?: string;
  private readonly secretValues: SecretValues;
  private readonly proxyMasking: boolean;
  private readonly maskPatterns: string[];
  private socketPath: string | null = null;
  private server: Server | null = null;
  /**
   * 人が押した結果。鍵は (ルール ID, 判定の理由, ターゲット) であり、
   * `approvalKey` が作る。
   *
   * ルール ID を鍵に含めるのは、同じホストに向いた別のルールまで巻き込まない
   * ためである。ID はセッション中に意味を変えない。解決済みドキュメントは
   * セッション開始時に 1 度だけ作られてこの broker と寿命を共にし、承認は
   * セッションを跨いで残らないので、設定を書き換えても生きている承認の指す
   * ルールが入れ替わることはない。
   */
  private readonly approved = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly negativeCache: TtlLruCache<string, true>;
  private readonly groups = new Map<string, PendingGroup>();
  private readonly requestIndex = new Map<string, string>();
  private readonly notificationTasks = new Set<Promise<void>>();

  constructor(options: BrokerOptions) {
    this.paths = options.paths;
    this.sessionId = options.sessionId;
    this.document = options.document;
    this.timeoutSeconds = options.pendingTimeoutSeconds;
    this.notify = options.pendingNotify;
    this.uiEnabled = options.uiEnabled;
    this.uiPort = options.uiPort;
    this.uiIdleTimeout = options.uiIdleTimeout;
    this.auditDir = options.auditDir;
    this.secretValues = options.secretValues ?? {};
    this.proxyMasking = options.proxyMasking !== false;
    // pending エントリに残す reviewContext は、どのスコープの帰結かが決まる前に
    // 作られる。どの秘密がどう扱われるかに関わらず、レジストリにある値はすべて
    // 伏せる。
    this.maskPatterns = expandMaskPatterns(
      Object.values(this.secretValues).flat(),
    );
    this.negativeCache = new TtlLruCache<string, true>({
      maxSize: 1024,
      ttlMs: options.negativeCacheTtlMs ?? 30_000,
    });
  }

  async start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await rm(socketPath, { force: true });
    this.server = await createUnixServer(
      socketPath,
      (socket) => void this.handleConnection(socket),
    );
  }

  async close(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const group of this.groups.values()) {
      clearTimeout(group.timer);
      group.notificationAbort.abort();
      for (const [requestId, waiter] of group.waiters.entries()) {
        waiter.resolve({
          version: 1,
          type: "decision",
          requestId,
          decision: "deny",
          reason: "broker closed",
        });
      }
    }
    await Promise.allSettled(this.notificationTasks);
    this.groups.clear();
    this.requestIndex.clear();
    this.approved.clear();
    this.denied.clear();
    this.negativeCache.clear();
    await removePendingDir(this.paths, this.sessionId);
    const sock =
      this.socketPath ?? brokerSocketPath(this.paths, this.sessionId);
    await rm(sock, { force: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        logInfo(`[nas] NetworkBroker: failed to remove socket: ${e}`);
      }
    });
    await rmdir(path.dirname(sock)).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        logInfo(
          `[nas] NetworkBroker: failed to remove session broker dir: ${e}`,
        );
      }
    });
  }

  async listPending(): Promise<PendingEntry[]> {
    return await listPendingEntries(this.paths, this.sessionId);
  }

  private async handleConnection(socket: Socket): Promise<void> {
    try {
      const line = await readJsonLine(socket);
      if (!line) return;
      const response = await this.handleMessage(
        JSON.parse(line) as BrokerMessage,
      );
      try {
        await writeJsonLine(socket, response);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ECONNRESET") return;
        throw e;
      }
    } finally {
      socket.destroy();
    }
  }

  private async handleMessage(message: BrokerMessage): Promise<BrokerResponse> {
    if (message.type === "authorize") {
      return await this.authorize(message);
    }
    if (message.type === "approve") {
      return await this.approve(message.requestId, message.scope);
    }
    if (message.type === "deny") {
      return await this.deny(message.requestId, message.scope);
    }
    if (message.type === "request_policy_outcome") {
      return await this.recordRequestPolicyOutcome(message);
    }
    return { type: "pending", items: await this.listPending() };
  }

  private async recordRequestPolicyOutcome(
    message: RequestPolicyOutcomeRequest,
  ): Promise<
    | RequestPolicyOutcomeResponse
    | {
        type: "error";
        requestId: string;
        message: string;
      }
  > {
    const validationError = validateRequestPolicyOutcome(
      message,
      this.sessionId,
      this.document,
    );
    if (validationError) {
      return {
        type: "error",
        requestId:
          typeof message.requestId === "string" ? message.requestId : "",
        message: validationError,
      };
    }

    const rule = this.findRuleById(message.ruleId);
    if (
      this.auditDir &&
      (rule?.audit ?? this.document.defaults.audit) !== "off"
    ) {
      const entry: AuditLogEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        domain: "network",
        sessionId: this.sessionId,
        requestId: message.requestId,
        decision: message.result === "block" ? "deny" : "allow",
        reason: message.reason,
        phase: "request-policy",
        ruleId: message.ruleId,
        // 経路はルールが宣言したパターンであって、リクエストのパスではない。
        // リクエストのパスは秘密を含みうるうえ、この報告には載っていない。
        route: rule?.match.paths.map((pattern) => pattern.source).join(" "),
        requestPolicyResult: message.result,
      };
      try {
        await appendAuditLog(entry, this.auditDir);
      } catch {
        return {
          type: "error",
          requestId: message.requestId,
          message: "request-policy outcome audit unavailable",
        };
      }
    }

    return {
      version: 1,
      type: "request_policy_outcome_recorded",
      requestId: message.requestId,
    };
  }

  private async authorize(
    message: AuthorizeRequest,
  ): Promise<DecisionResponse> {
    // NOTE: `message` keeps its original (unmasked) reviewContext for the
    // lifetime of this function. Matching (findMatchingRule pathPrefix,
    // credential pathPrefix via decorateAllow) must run against the real
    // path. Masking is applied only when building the entry persisted via
    // toPendingEntry, further down.
    const targetStr = `${message.target.host}:${message.target.port}`;

    // deny-by-default targets (localhost, loopback, RFC1918, link-local, ULA)
    // are always blocked regardless of the authorization document.
    const denyReason = denyReasonForTarget(message.target);
    if (denyReason) {
      await this.recordAudit(message.requestId, "deny", denyReason, targetStr);
      return denyDecision(message.requestId, denyReason);
    }

    // 認可の判定はドキュメントの上で 1 度だけ行う。addon も同じドキュメントを
    // 読んで同じ選択を再現し、broker が名指ししたルールと食い違ったら fail-closed
    // で止める。セッション中のキャッシュは、帰結が review になったルールの
    // 「ユーザーが押した結果」だけを覚える。
    const decided = decide(
      this.document,
      message.target,
      toAuthzRequest(message),
    );
    const shouldAudit = decided.audit !== "off";

    if (decided.action === "deny") {
      if (shouldAudit) {
        await this.recordAudit(
          message.requestId,
          "deny",
          decided.reason,
          targetStr,
          undefined,
          decided.ruleId,
        );
      }
      return denyDecision(message.requestId, decided.reason);
    }
    if (decided.action === "allow") {
      const decision = this.decorateAllow(
        allowDecision(message.requestId, decided.reason),
        decided,
      );
      if (shouldAudit) {
        const headerNames = decision.injectHeaders?.map((h) => h.name);
        await this.recordAudit(
          message.requestId,
          "allow",
          decided.reason,
          targetStr,
          headerNames,
          decided.ruleId,
        );
      }
      return decision;
    }

    // ここから先はキャッシュの話であり、鍵は (ルール ID, 判定の理由,
    // ターゲット) である。この確認を起こしたルールに、同じ理由で押された答え
    // だけを再利用する。
    const identityKeys = approvalKeys(
      decided.ruleId,
      decided.reason,
      message.target,
    );
    if (identityKeys.some((key) => this.denied.has(key))) {
      if (shouldAudit) {
        await this.recordAudit(
          message.requestId,
          "deny",
          "denied-by-user",
          targetStr,
          undefined,
          decided.ruleId,
        );
      }
      return denyDecision(message.requestId, "denied-by-user");
    }

    if (identityKeys.some((key) => this.approved.has(key))) {
      const decision = this.decorateAllow(
        allowDecision(message.requestId, "approved"),
        decided,
      );
      const headerNames = decision.injectHeaders?.map((h) => h.name);
      if (shouldAudit) {
        await this.recordAudit(
          message.requestId,
          "allow",
          "approved",
          targetStr,
          headerNames,
          decided.ruleId,
        );
      }
      return decision;
    }

    const groupKey = pendingGroupKey(
      this.sessionId,
      decided.ruleId,
      decided.reason,
      message.target,
    );
    if (this.negativeCache.get(groupKey) !== undefined) {
      if (shouldAudit) {
        await this.recordAudit(
          message.requestId,
          "deny",
          "recent-deny",
          targetStr,
          undefined,
          decided.ruleId,
        );
      }
      return denyDecision(message.requestId, "recent-deny");
    }

    const group =
      this.groups.get(groupKey) ??
      (await this.createPendingGroup(groupKey, message, decided));

    if (!group.requests.has(message.requestId)) {
      group.requests.set(message.requestId, message);
      group.decisions.set(message.requestId, decided);
      this.requestIndex.set(message.requestId, groupKey);
      await writePendingEntry(
        this.paths,
        toPendingEntry(message, group, this.maskedReviewContext(message)),
      );
    }

    const deferred = Promise.withResolvers<DecisionResponse>();
    group.waiters.set(message.requestId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
    });
    return await deferred.promise;
  }

  private async createPendingGroup(
    groupKey: string,
    message: AuthorizeRequest,
    decided: AuthzDecision,
  ): Promise<PendingGroup> {
    const createdAt = new Date().toISOString();
    const notificationAbort = new AbortController();
    const timer = setTimeout(() => {
      void this.resolveGroup(
        groupKey,
        denyDecision(message.requestId, "prompt-timeout"),
        "deny",
      );
    }, this.timeoutSeconds * 1000);
    const group: PendingGroup = {
      groupKey,
      ruleId: decided.ruleId,
      reason: decided.reason,
      createdAt,
      target: message.target,
      requests: new Map([[message.requestId, message]]),
      decisions: new Map([[message.requestId, decided]]),
      waiters: new Map(),
      timer,
      notificationAbort,
      allowedScopes: approvalScopesFor(decided),
      injectHeaders: describeInjectHeaders(decided.inject, this.secretValues),
    };
    this.groups.set(groupKey, group);
    this.requestIndex.set(message.requestId, groupKey);
    await writePendingEntry(
      this.paths,
      toPendingEntry(message, group, this.maskedReviewContext(message)),
    );
    const notificationTask = notifyPendingRequest({
      backend: this.notify,
      sessionId: this.sessionId,
      requestId: message.requestId,
      target: group.target,
      uiEnabled: this.uiEnabled,
      uiPort: this.uiPort,
      uiIdleTimeout: this.uiIdleTimeout,
      signal: notificationAbort.signal,
    }).catch((e) =>
      logInfo(`[nas] NetworkBroker: failed to send notification: ${e}`),
    );
    this.notificationTasks.add(notificationTask);
    void notificationTask.finally(() => {
      this.notificationTasks.delete(notificationTask);
    });
    return group;
  }

  private async approve(
    requestId: string,
    scope?: ApprovalScope,
  ): Promise<BrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      return {
        type: "error",
        requestId,
        message: `Pending request not found: ${requestId}`,
      };
    }
    if (scope !== undefined && !group.allowedScopes.includes(scope)) {
      return {
        type: "error",
        requestId,
        message: `scope not allowed for this request: ${scope}`,
      };
    }
    const selectedScope = scope ?? DEFAULT_APPROVAL_SCOPE;
    this.remember(this.approved, this.denied, group, selectedScope);
    await this.resolveGroup(
      group.groupKey,
      allowDecision(requestId, "approved-by-user", selectedScope),
      "allow",
    );
    return { type: "ack", requestId, decision: "approve" };
  }

  private async deny(
    requestId: string,
    scope?: ApprovalScope,
  ): Promise<BrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      return {
        type: "error",
        requestId,
        message: `Pending request not found: ${requestId}`,
      };
    }
    if (scope !== undefined && !group.allowedScopes.includes(scope)) {
      return {
        type: "error",
        requestId,
        message: `scope not allowed for this request: ${scope}`,
      };
    }
    if (scope !== undefined) {
      this.remember(this.denied, this.approved, group, scope);
    }
    await this.resolveGroup(
      group.groupKey,
      denyDecision(requestId, "denied-by-user", scope),
      "deny",
      scope === undefined,
    );
    return { type: "ack", requestId, decision: "deny" };
  }

  private async resolveGroup(
    groupKey: string,
    baseDecision: DecisionResponse,
    outcome: "allow" | "deny",
    useNegativeCache = true,
  ): Promise<void> {
    const group = this.groups.get(groupKey);
    if (!group) return;
    clearTimeout(group.timer);
    this.groups.delete(groupKey);
    group.notificationAbort.abort();
    await closeNotification();
    if (outcome === "deny" && useNegativeCache) {
      // 直近の拒否も承認と同じ単位で覚える。ターゲットだけで覚えると、
      // 人が見ていない別のルールの確認が 30 秒だけ黙って拒否になる。
      this.negativeCache.set(group.groupKey, true);
    }

    for (const [requestId, request] of group.requests.entries()) {
      this.requestIndex.delete(requestId);
      await removePendingEntry(this.paths, this.sessionId, requestId);
      const baseWithId: DecisionResponse = {
        ...baseDecision,
        requestId: request.requestId,
      };
      const decision =
        outcome === "allow"
          ? this.decorateAllow(baseWithId, group.decisions.get(requestId))
          : baseWithId;
      const targetStr = `${request.target.host}:${request.target.port}`;
      const headerNames = decision.injectHeaders?.map((h) => h.name);
      const decided = group.decisions.get(requestId);
      if ((decided?.audit ?? this.document.defaults.audit) !== "off") {
        await this.recordAudit(
          requestId,
          outcome === "allow" ? "allow" : "deny",
          baseDecision.reason,
          targetStr,
          headerNames,
          decided?.ruleId,
        );
      }
      const waiter = group.waiters.get(requestId);
      waiter?.resolve(decision);
    }
  }

  /**
   * 押された答えを (ルール ID, 判定の理由, ターゲット) で覚え、反対の答えを
   * 取り消す。
   *
   * `once` は何も覚えない。同じルールと同じターゲットの次のリクエストは、
   * もう一度人に聞くところからやり直す。
   */
  private remember(
    into: Set<string>,
    opposite: Set<string>,
    group: PendingGroup,
    scope: ApprovalScope,
  ): void {
    if (scope === "once") return;
    const key = approvalKey(group.ruleId, group.reason, group.target, scope);
    into.add(key);
    opposite.delete(key);
  }

  /**
   * reviewContext を pending エントリ永続化用にマスクする。マッチング
   * (findMatchingRule / credential pathPrefix) には絶対に使わないこと。
   */
  private maskedReviewContext(
    message: AuthorizeRequest,
  ): ReviewContext | undefined {
    return maskReviewContextWithPatterns(
      message.reviewContext,
      this.maskPatterns,
    );
  }

  /** 実 ID から解決済みルールを引く。擬似 ID (`<スコープ>.$fallback`) には無い。 */
  private findRuleById(ruleId: string): ResolvedRule | undefined {
    for (const scope of this.document.scopes) {
      const found = scope.rules.find((rule) => rule.id === ruleId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private findGroupByRequestId(requestId: string): PendingGroup | null {
    const groupKey = this.requestIndex.get(requestId);
    if (!groupKey) return null;
    return this.groups.get(groupKey) ?? null;
  }

  private async recordAudit(
    requestId: string,
    decision: "allow" | "deny",
    reason: string,
    target: string,
    injectedHeaders?: string[],
    ruleId?: string,
  ): Promise<void> {
    if (!this.auditDir) return;
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      domain: "network",
      sessionId: this.sessionId,
      requestId,
      decision,
      reason,
      phase: "authorization",
      ruleId,
      target,
      injectedHeaders,
    };
    await appendAuditLog(entry, this.auditDir);
  }

  /**
   * allow 決定に注入ヘッダーと秘密の扱いを載せる。
   *
   * 注入は最終的な帰結が allow になったときにだけ行う。拒否したリクエストには
   * 注入しない。マスクは注入より前に走るので、注入する秘密をマスクの対象から
   * 外す必要はなく、外してもならない。
   */
  private decorateAllow(
    decision: DecisionResponse,
    decided: AuthzDecision | undefined,
  ): DecisionResponse {
    if (decision.decision !== "allow" || decided === undefined) return decision;
    const injectHeaders = renderInjectHeaders(
      decided.inject,
      this.secretValues,
    );
    const maskValues = this.proxyMasking
      ? maskValuesFor(this.secretValues, decided.secrets)
      : [];
    const forbidValues = this.proxyMasking
      ? forbidValuesFor(this.secretValues, decided.secrets)
      : [];
    return {
      ...decision,
      ruleId: decided.ruleId,
      ...(injectHeaders.length > 0 ? { injectHeaders } : {}),
      ...(maskValues.length > 0 ? { maskValues } : {}),
      ...(forbidValues.length > 0 ? { forbidValues } : {}),
    };
  }
}

/**
 * その確認で選べる粒度。マッチしたルールの具体性から導出する。
 *
 * スコープがターゲットを 1 つのホストとポートに固定しているなら、`host` と
 * `host:port` は同じことを二度言うだけになる。残る問いは「いつまで効くか」
 * だけなので、選択肢を「今回のみ」と「このルールが有効な間ずっと」に絞る。
 *
 * それ以外 — ワイルドカードのホスト、ポートを書いていないターゲット、
 * ターゲットを複数持つスコープ、どのスコープにも属さないリクエスト — では、
 * ルールが当たりうるターゲットが 1 つに定まらない。そこで「このルールが
 * 有効な間ずっと」を出すと、承認された相手とは別のホストやポートまで
 * 巻き込むので、ターゲットを手で決める粒度を残す。
 */
function approvalScopesFor(decided: AuthzDecision): readonly ApprovalScope[] {
  return scopePinsTarget(decided.scope)
    ? ["once", "rule"]
    : ["once", "host-port", "host"];
}

function scopePinsTarget(scope: ResolvedScope | null): boolean {
  if (scope === null) return false;
  const target = scope.targets.length === 1 ? scope.targets[0] : undefined;
  return (
    target !== undefined && target.host.kind === "exact" && target.port !== null
  );
}

/**
 * 承認の同一性 (ルール ID, 判定の理由, ターゲット) を 1 本の鍵にする。
 *
 * ルール ID とターゲットはどの粒度でも鍵に入る。粒度が決めるのはターゲット
 * 成分の広さだけであって、成分そのものを落とすことではない。`rule` は
 * 「いつまで効くか」を答える粒度であり、「どこに効くか」を広げる粒度ではない。
 * ここでターゲットを落とすと、承認は人が見せられた相手を越えて届く。その粒度を
 * 出すスコープはターゲットを 1 つのホストとポートに固定しているので
 * (`approvalScopesFor`)、鍵に入れても意図した再利用は狭まらない。区切りに
 * NUL を使うのは、ルール ID もホスト名も NUL を含めないためである。
 *
 * 判定の理由も鍵に入る。同じルールでも、`rule` で確認に至ったリクエストは
 * match が成り立ってボディを読めたものであり、`indeterminate` で確認に至った
 * リクエストはボディを読めなかったものである。後者にはルールの受理条件が 1 つも
 * 適用されない。読めたボディを見て押した人は、読めないボディを通してよいとは
 * 言っていない。
 */
function approvalKey(
  ruleId: string,
  reason: DecisionReason,
  target: NormalizedTarget,
  scope: Exclude<ApprovalScope, "once">,
): string {
  const pinned = scope === "host" ? target.host : targetKey(target);
  return `${ruleId}\u0000${reason}\u0000${scope}\u0000${pinned}`;
}

/** そのリクエストの答えになりうる鍵。広い粒度の答えは狭いリクエストに効く。 */
function approvalKeys(
  ruleId: string,
  reason: DecisionReason,
  target: NormalizedTarget,
): readonly string[] {
  return [
    approvalKey(ruleId, reason, target, "rule"),
    approvalKey(ruleId, reason, target, "host-port"),
    approvalKey(ruleId, reason, target, "host"),
  ];
}

/**
 * 1 つの確認にまとめるリクエストの範囲。
 *
 * 承認の同一性と同じ (ルール ID, 判定の理由, ターゲット) で束ねる。ターゲット
 * だけで束ねると、同じホストに向いた別のルールのリクエストが同じカードに乗り、
 * 片方を押した人が見ていないもう片方まで一緒に通ってしまう。同一性より粗く
 * 束ねても同じことが起きるので、束ねる単位は同一性と一致していなければならない。
 */
function pendingGroupKey(
  sessionId: string,
  ruleId: string,
  reason: DecisionReason,
  target: NormalizedTarget,
): string {
  return `${sessionId}\u0000${ruleId}\u0000${reason}\u0000${targetKey(target)}`;
}

export async function sendBrokerRequest<T extends BrokerResponse>(
  socketPath: string,
  message: BrokerMessage,
): Promise<T> {
  const socket = await connectUnix(socketPath);
  try {
    await writeJsonLine(socket, message);
    const response = await readJsonLine(socket);
    if (!response) {
      throw new Error("empty broker response");
    }
    return JSON.parse(response) as T;
  } finally {
    socket.destroy();
  }
}

/**
 * 認可の判定に渡すリクエストの姿。
 *
 * ボディそのものは broker に来ない。addon が読んで分類した種別だけが来るので、
 * `match.body.format` の 3 値評価に必要な形へ組み直す。値条件 (`equals` /
 * `oneOf` / `graphql`) を `match` に置けるようになったら、ここに実際の値が
 * 要る。
 */
function toAuthzRequest(message: AuthorizeRequest): {
  method: string;
  path: string;
  body: RequestBody;
} {
  return {
    method: message.method.toUpperCase(),
    path: pathForSelection(message.reviewContext?.path ?? ""),
    body: toRequestBody(message.reviewContext?.bodyKind),
  };
}

function toRequestBody(kind: BodyKind | undefined): RequestBody {
  switch (kind) {
    case "empty":
      return { kind: "empty" };
    case "binary":
      return { kind: "binary" };
    case "json":
      return { kind: "json", value: {} };
    default:
      return { kind: "absent" };
  }
}

function toPendingEntry(
  message: AuthorizeRequest,
  group: PendingGroup,
  maskedReviewContext: ReviewContext | undefined,
): PendingEntry {
  return {
    version: 1,
    sessionId: message.sessionId,
    requestId: message.requestId,
    target: message.target,
    method: message.method,
    requestKind: message.requestKind,
    state: "pending",
    createdAt: group.createdAt,
    updatedAt: new Date().toISOString(),
    reviewContext: maskedReviewContext,
    ruleId: group.ruleId,
    // 承認 UI に出すのと同じ集合を載せる。押せるものと通るものを一致させる
    // ために、broker はこの集合の外の粒度を受け付けない。
    approvalScopes: [...group.allowedScopes],
    injectHeaders: [...group.injectHeaders],
  };
}

function allowDecision(
  requestId: string,
  reason: string,
  scope?: ApprovalScope,
): DecisionResponse {
  return {
    version: 1,
    type: "decision",
    requestId,
    decision: "allow",
    reason,
    scope,
  };
}

function denyDecision(
  requestId: string,
  reason: string,
  scope?: ApprovalScope,
): DecisionResponse {
  return {
    version: 1,
    type: "decision",
    requestId,
    decision: "deny",
    reason,
    scope,
    message: reason,
  };
}
