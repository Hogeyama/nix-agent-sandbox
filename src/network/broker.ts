import { mkdir, rm, rmdir } from "node:fs/promises";
import * as path from "node:path";
import { appendAuditLog } from "../audit/store.ts";
import type { AuditLogEntry, AuditViolation } from "../audit/types.ts";
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
import {
  expandMaskPatterns,
  maskReviewContextWithPatterns,
  maskText,
} from "./mask_patterns.ts";
import {
  closeNotification,
  notifyPendingRequest,
  type ResolvedNotifyBackend,
} from "./notify.ts";
import {
  type ApprovalScope,
  type AuthorizeRequest,
  type DecisionResponse,
  denyReasonForTarget,
  type InjectHeaderPreview,
  isApprovableFinding,
  type NormalizedTarget,
  type PendingEntry,
  type RequestPolicyOutcomeRequest,
  type RequestPolicyOutcomeResponse,
  type RequestPolicyReviewRequest,
  type ReviewContext,
  targetKey,
  type ViolationFinding,
  validateAuthorizeRequest,
  validateRequestPolicyOutcome,
  validateRequestPolicyReview,
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

interface PendingGroupBase {
  groupKey: string;
  /** 承認の同一性の一部。この確認を起こしたルール、または擬似 ID。 */
  ruleId: string;
  createdAt: string;
  target: NormalizedTarget;
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

/** ルールの `review` から生じた確認。同一性はターゲットを含む。 */
interface AuthorizePendingGroup extends PendingGroupBase {
  kind: "authorize";
  /** 承認の同一性の一部。この確認に至った判定の理由。 */
  reason: DecisionReason;
  /** 承認されたら注入されるヘッダー。名前だけで、値は持たない。 */
  injectHeaders: readonly InjectHeaderPreview[];
  requests: Map<string, AuthorizeRequest>;
  decisions: Map<string, AuthzDecision>;
}

/**
 * 受理条件の違反から生じた確認。同一性はターゲットを含まない。
 *
 * 会話履歴は毎リクエスト再送されるので、未知タグが 1 つ混ざると以後のすべての
 * リクエストが同じ違反を起こす。リクエストを単位にするとターンごとに同じ確認が
 * 出てセッションが進まないので、単位は違反そのものになる。
 */
interface ViolationPendingGroup extends PendingGroupBase {
  kind: "violation";
  /** 承認したときに覚える鍵。`findings` と 1 対 1 で対応する。 */
  identities: readonly string[];
  /** 承認 UI に出す違反。押せる対象と出したものを一致させる。 */
  findings: readonly ViolationFinding[];
  requests: Map<string, RequestPolicyReviewRequest>;
}

type PendingGroup = AuthorizePendingGroup | ViolationPendingGroup;

type BrokerMessage =
  | AuthorizeRequest
  | RequestPolicyOutcomeRequest
  | RequestPolicyReviewRequest
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
  /**
   * 受理条件の違反について人が押した結果。鍵は (ルール ID, 受理条件の位置,
   * 違反した値) であり、`violationKey` が作る。
   *
   * `approved` / `denied` と別の集合にしてあるのは、2 種類の承認が互いを
   * 解放してはならないからである。「このホストへのこのルールを通してよい」と
   * 「このルールがこの値を見ても通してよい」は別の許可であり、鍵の形が
   * たまたま似ていても、片方を押した人はもう片方を見ていない。集合を分けて
   * おけば、鍵の作り方を後から変えても混ざりようがない。
   */
  private readonly approvedViolations = new Set<string>();
  private readonly deniedViolations = new Set<string>();
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
    this.approvedViolations.clear();
    this.deniedViolations.clear();
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
    } catch (e) {
      // この呼び出しは待たれていない (`void this.handleConnection`) ので、
      // ここで捕まえないと 1 通の壊れたメッセージが unhandled rejection に
      // なり、セッションのネットワークごと broker が落ちる。答えを返さずに
      // 切るので、問うた側には空応答が見え、fail-closed のまま拒否になる。
      logInfo(`[nas] NetworkBroker: dropping malformed request: ${e}`);
    } finally {
      socket.destroy();
    }
  }

  private async handleMessage(message: BrokerMessage): Promise<BrokerResponse> {
    if (message.type === "authorize") {
      const validationError = validateAuthorizeRequest(
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
    if (message.type === "request_policy_review") {
      return await this.reviewViolations(message);
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
        ...(message.findings && message.findings.length > 0
          ? {
              violations: this.maskedFindings(message.findings).map(
                toAuditViolation,
              ),
            }
          : {}),
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

  /**
   * 受理条件の違反に帰結を与える。
   *
   * 承認済みの組はここで即答する。会話履歴の再送で同じ違反が毎ターン届くので、
   * ここが効かないと 1 度押した確認がターンごとに戻ってくる。
   */
  private async reviewViolations(
    message: RequestPolicyReviewRequest,
  ): Promise<
    DecisionResponse | { type: "error"; requestId: string; message: string }
  > {
    const validationError = validateRequestPolicyReview(
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
    if (rule === undefined) {
      // 擬似 ID は受理条件を持たないので、その名前で違反は起こりえない。
      return {
        type: "error",
        requestId: message.requestId,
        message: "request-policy review names a rule that has no expectations",
      };
    }

    const shouldAudit = (rule.audit ?? this.document.defaults.audit) !== "off";
    const targetStr = targetKey(message.target);
    const audit = (decision: "allow" | "deny", reason: string) =>
      shouldAudit
        ? this.recordViolationAudit(
            message,
            decision,
            reason,
            targetStr,
            message.findings,
          )
        : Promise.resolve();

    // 所見には `onViolation = "allow"` の違反も載っている。承認者はリクエスト
    // 全体を見て押すので、記録に回った違反を隠す理由はない。ただし答えを要する
    // のは `review` の違反だけである。`allow` の違反まで承認の対象にすると、
    // 設定が「訊くな」と言った条件のせいで確認が出る — その値はリクエストごとに
    // 変わりうるので、1 度承認しても次のターンでまた出る。
    const asked = message.findings.filter((finding) =>
      violationNeedsApproval(rule, finding),
    );
    if (asked.length === 0) {
      // addon は `review` の違反があるときだけここへ来る。1 件も見当たらない
      // なら、両者が別のドキュメントを読んでいる。
      await audit("deny", "review-condition-mismatch");
      return denyDecision(message.requestId, "review-condition-mismatch");
    }

    // 押せない所見が混ざっていたら、そのリクエストは承認では通せない。押した
    // 人が通したつもりのリクエストが通らないまま残るより、ここで断る方が
    // 正直である。走査が完了しなかった記録と、保持上限で畳まれた記録がそれで
    // あり、どちらも受理条件か値を欠いている。`allow` の条件が上限を埋めた
    // だけの打ち切りは答えを要さないので、ここには来ない。
    if (asked.some((finding) => !isApprovableFinding(finding))) {
      await audit("deny", "unapprovable-violation");
      return denyDecision(message.requestId, "unapprovable-violation");
    }

    const identities = asked.map((finding) =>
      violationKey(message.ruleId, finding),
    );
    if (identities.some((key) => this.deniedViolations.has(key))) {
      await audit("deny", "denied-by-user");
      return denyDecision(message.requestId, "denied-by-user");
    }
    const undecided = asked.filter(
      (finding) =>
        !this.approvedViolations.has(violationKey(message.ruleId, finding)),
    );
    if (undecided.length === 0) {
      await audit("allow", "approved");
      return allowDecision(message.requestId, "approved");
    }

    // 束ねる単位は、まだ答えの無い違反の集合である。既に承認済みの違反を
    // 鍵に混ぜると、同じ問いが違うカードに分かれる。
    const groupKey = violationGroupKey(
      this.sessionId,
      message.ruleId,
      undecided.map((finding) => violationKey(message.ruleId, finding)),
    );
    if (this.negativeCache.get(groupKey) !== undefined) {
      await audit("deny", "recent-deny");
      return denyDecision(message.requestId, "recent-deny");
    }

    const open = this.groups.get(groupKey);
    const group =
      open?.kind === "violation"
        ? open
        : await this.createViolationGroup(
            groupKey,
            message,
            undecided,
            message.findings,
          );
    if (!group.requests.has(message.requestId)) {
      group.requests.set(message.requestId, message);
      this.requestIndex.set(message.requestId, groupKey);
      await writePendingEntry(
        this.paths,
        toViolationPendingEntry(
          message,
          group,
          this.maskedReviewContext(message.reviewContext),
          this.maskedFindings(group.findings),
        ),
      );
    }

    const deferred = Promise.withResolvers<DecisionResponse>();
    group.waiters.set(message.requestId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
    });
    return await deferred.promise;
  }

  private async createViolationGroup(
    groupKey: string,
    message: RequestPolicyReviewRequest,
    asked: readonly ViolationFinding[],
    shown: readonly ViolationFinding[],
  ): Promise<ViolationPendingGroup> {
    const notificationAbort = new AbortController();
    const timer = setTimeout(() => {
      void this.resolveGroup(
        groupKey,
        denyDecision(message.requestId, "prompt-timeout"),
        "deny",
      );
    }, this.timeoutSeconds * 1000);
    const group: ViolationPendingGroup = {
      kind: "violation",
      groupKey,
      ruleId: message.ruleId,
      createdAt: new Date().toISOString(),
      target: message.target,
      requests: new Map([[message.requestId, message]]),
      waiters: new Map(),
      timer,
      notificationAbort,
      // ターゲットは同一性に入らないので、広さを選ぶ粒度は出さない。残る問いは
      // 「この違反を覚えるかどうか」だけである。
      allowedScopes: ["once", "violation"],
      identities: asked.map((finding) => violationKey(message.ruleId, finding)),
      findings: [...shown],
    };
    this.groups.set(groupKey, group);
    this.requestIndex.set(message.requestId, groupKey);
    await writePendingEntry(
      this.paths,
      toViolationPendingEntry(
        message,
        group,
        this.maskedReviewContext(message.reviewContext),
        this.maskedFindings(group.findings),
      ),
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
      (rule) => message.bodyTruth[rule.id] ?? "indeterminate",
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

    const open = this.groups.get(groupKey);
    const group =
      open?.kind === "authorize"
        ? open
        : await this.createPendingGroup(groupKey, message, decided);

    if (!group.requests.has(message.requestId)) {
      group.requests.set(message.requestId, message);
      group.decisions.set(message.requestId, decided);
      this.requestIndex.set(message.requestId, groupKey);
      await writePendingEntry(
        this.paths,
        toPendingEntry(
          message,
          group,
          this.maskedReviewContext(message.reviewContext),
        ),
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
  ): Promise<AuthorizePendingGroup> {
    const createdAt = new Date().toISOString();
    const notificationAbort = new AbortController();
    const timer = setTimeout(() => {
      void this.resolveGroup(
        groupKey,
        denyDecision(message.requestId, "prompt-timeout"),
        "deny",
      );
    }, this.timeoutSeconds * 1000);
    const group: AuthorizePendingGroup = {
      kind: "authorize",
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
      toPendingEntry(
        message,
        group,
        this.maskedReviewContext(message.reviewContext),
      ),
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
    this.remember(group, selectedScope, "approve");
    const decision = allowDecision(
      requestId,
      "approved-by-user",
      selectedScope,
    );
    if (selectedScope === "once") {
      await this.resolveRequest(requestId, decision, "allow");
    } else {
      await this.resolveGroup(group.groupKey, decision, "allow");
    }
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
      this.remember(group, scope, "deny");
    }
    const decision = denyDecision(requestId, "denied-by-user", scope);
    if (scope === "once") {
      await this.resolveRequest(requestId, decision, "deny");
    } else {
      await this.resolveGroup(
        group.groupKey,
        decision,
        "deny",
        scope === undefined,
      );
    }
    return { type: "ack", requestId, decision: "deny" };
  }

  private async resolveRequest(
    requestId: string,
    baseDecision: DecisionResponse,
    outcome: "allow" | "deny",
  ): Promise<void> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) return;

    const waiter = group.waiters.get(requestId);
    if (group.kind === "violation") {
      const request = group.requests.get(requestId);
      if (!request) return;
      await this.detachRequest(group, requestId);
      await removePendingEntry(this.paths, this.sessionId, requestId);
      const rule = this.findRuleById(group.ruleId);
      if ((rule?.audit ?? this.document.defaults.audit) !== "off") {
        await this.recordViolationAudit(
          request,
          outcome,
          baseDecision.reason,
          targetKey(request.target),
          group.findings,
        );
      }
      waiter?.resolve({ ...baseDecision, requestId });
      return;
    }

    const request = group.requests.get(requestId);
    if (!request) return;
    const decided = group.decisions.get(requestId);
    await this.detachRequest(group, requestId);
    await removePendingEntry(this.paths, this.sessionId, requestId);
    const baseWithId: DecisionResponse = { ...baseDecision, requestId };
    const decision =
      outcome === "allow"
        ? this.decorateAllow(baseWithId, decided)
        : baseWithId;
    if ((decided?.audit ?? this.document.defaults.audit) !== "off") {
      await this.recordAudit(
        requestId,
        outcome,
        baseDecision.reason,
        targetKey(request.target),
        decision.injectHeaders?.map((header) => header.name),
        decided?.ruleId,
      );
    }
    waiter?.resolve(decision);
  }

  private async detachRequest(
    group: PendingGroup,
    requestId: string,
  ): Promise<void> {
    this.requestIndex.delete(requestId);
    group.requests.delete(requestId);
    group.waiters.delete(requestId);
    if (group.kind === "authorize") {
      group.decisions.delete(requestId);
    }
    if (group.requests.size > 0) return;

    clearTimeout(group.timer);
    this.groups.delete(group.groupKey);
    group.notificationAbort.abort();
    await closeNotification();
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

    if (group.kind === "violation") {
      await this.resolveViolationGroup(group, baseDecision, outcome);
      return;
    }
    await this.resolveAuthorizeGroup(group, baseDecision, outcome);
  }

  private async resolveAuthorizeGroup(
    group: AuthorizePendingGroup,
    baseDecision: DecisionResponse,
    outcome: "allow" | "deny",
  ): Promise<void> {
    for (const [requestId, request] of group.requests.entries()) {
      this.requestIndex.delete(requestId);
      await removePendingEntry(this.paths, this.sessionId, requestId);
      const baseWithId: DecisionResponse = {
        ...baseDecision,
        requestId: request.requestId,
      };
      const decided = group.decisions.get(requestId);
      const decision =
        outcome === "allow"
          ? this.decorateAllow(baseWithId, decided)
          : baseWithId;
      if ((decided?.audit ?? this.document.defaults.audit) !== "off") {
        await this.recordAudit(
          requestId,
          outcome,
          baseDecision.reason,
          targetKey(request.target),
          decision.injectHeaders?.map((h) => h.name),
          decided?.ruleId,
        );
      }
      group.waiters.get(requestId)?.resolve(decision);
    }
  }

  private async resolveViolationGroup(
    group: ViolationPendingGroup,
    baseDecision: DecisionResponse,
    outcome: "allow" | "deny",
  ): Promise<void> {
    const rule = this.findRuleById(group.ruleId);
    const shouldAudit = (rule?.audit ?? this.document.defaults.audit) !== "off";
    for (const [requestId, request] of group.requests.entries()) {
      this.requestIndex.delete(requestId);
      await removePendingEntry(this.paths, this.sessionId, requestId);
      // 注入ヘッダーは載せない。この答えが決めるのは違反を通すかどうかだけで
      // あり、資格情報を付けるかどうかは authorize が既に決めている。
      const decision: DecisionResponse = { ...baseDecision, requestId };
      if (shouldAudit) {
        await this.recordViolationAudit(
          request,
          outcome,
          baseDecision.reason,
          targetKey(request.target),
          group.findings,
        );
      }
      group.waiters.get(requestId)?.resolve(decision);
    }
  }

  /**
   * 押された答えをその確認の同一性で覚え、反対の答えを取り消す。
   *
   * 確認の種類ごとに別の集合へ入れる。ルールの `review` から生じた承認は
   * (ルール ID, 判定の理由, ターゲット) を、受理条件の違反から生じた承認は
   * (ルール ID, 受理条件の位置, 違反した値) を単位とする。**一方が他方を
   * 解放してはならない。** 「このホストへこのルールを通してよい」と押した人は、
   * そのルールが未知の値を見ても通してよいとは言っていない。
   *
   * `once` は何も覚えない。次の同じリクエストは、もう一度人に聞くところから
   * やり直す。
   */
  private remember(
    group: PendingGroup,
    scope: ApprovalScope,
    outcome: "approve" | "deny",
  ): void {
    if (scope === "once") return;
    if (group.kind === "violation") {
      // 粒度は `violation` しか出していないので、他の値が来たら押せる集合の
      // 外である。呼び出し側が突き合わせているが、ここでも取り違えない。
      if (scope !== "violation") return;
      const into =
        outcome === "approve" ? this.approvedViolations : this.deniedViolations;
      const opposite =
        outcome === "approve" ? this.deniedViolations : this.approvedViolations;
      for (const key of group.identities) {
        into.add(key);
        opposite.delete(key);
      }
      return;
    }
    if (scope === "violation") return;
    const into = outcome === "approve" ? this.approved : this.denied;
    const opposite = outcome === "approve" ? this.denied : this.approved;
    const key = approvalKey(group.ruleId, group.reason, group.target, scope);
    into.add(key);
    opposite.delete(key);
  }

  /**
   * reviewContext を pending エントリ永続化用にマスクする。マッチング
   * (findMatchingRule / credential pathPrefix) には絶対に使わないこと。
   */
  private maskedReviewContext(
    reviewContext: ReviewContext | undefined,
  ): ReviewContext | undefined {
    return maskReviewContextWithPatterns(reviewContext, this.maskPatterns);
  }

  /**
   * 所見を人が読む面へ出す前に、レジストリの全ての値で伏せ直す。
   *
   * addon は既にマスクしているが、そこで使うパターンはそのルールで `mask` と
   * 宣言された秘密だけである。`ignore` や `inject` の秘密がボディに現れて違反
   * ノードの中に入っていれば、addon のマスクは通り抜ける。pending エントリと
   * 監査ログは扱いが決まる前から人が読む面なので、reviewContext と同じ広さ
   * — レジストリにある値すべて — で伏せる。
   *
   * 承認の鍵はここを通らない。鍵は届いた値のままで作るので、伏せた結果が
   * 衝突しても別々の違反は別々の承認のままである。カードに出るものが実際の
   * 値より少ないことはあるが、多いことはない。
   */
  private maskedFindings(
    findings: readonly ViolationFinding[],
  ): ViolationFinding[] {
    if (this.maskPatterns.length === 0) return [...findings];
    return findings.map((finding) => ({
      ...finding,
      pointer: maskText(finding.pointer, this.maskPatterns),
      value:
        finding.value === null
          ? null
          : maskText(finding.value, this.maskPatterns),
      excerpt:
        finding.excerpt === null
          ? null
          : maskText(finding.excerpt, this.maskPatterns),
    }));
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

  /**
   * 違反の確認の帰結を記録する。
   *
   * 帰結が承認でも拒否でも、押した人が見たのと同じ違反の一覧を残す。理由の
   * 語彙は「承認された」としか言えないので、何が承認されたかはここにしかない。
   */
  private async recordViolationAudit(
    message: RequestPolicyReviewRequest,
    decision: "allow" | "deny",
    reason: string,
    target: string,
    findings: readonly ViolationFinding[],
  ): Promise<void> {
    if (!this.auditDir) return;
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      domain: "network",
      sessionId: this.sessionId,
      requestId: message.requestId,
      decision,
      reason,
      phase: "request-policy",
      ruleId: message.ruleId,
      target,
      violations: this.maskedFindings(findings).map(toAuditViolation),
    };
    await appendAuditLog(entry, this.auditDir);
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
 * 所見を監査ログの形に落とす。
 *
 * 抜粋は落とす。承認 UI が違反箇所を見せるための成果物であって、ログを読む人が
 * 違反を特定するのに要るのは受理条件と Pointer と値だからである。1 件あたり
 * 数百バイトを JSONL に毎回書くだけの見返りがない。
 */
function toAuditViolation(finding: ViolationFinding): AuditViolation {
  return {
    expect: finding.expect,
    at: finding.at,
    kind: finding.kind,
    pointer: finding.pointer,
    value: finding.value,
    count: finding.count,
  };
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

/**
 * その所見が人の答えを要するか。
 *
 * 所見の列には `onViolation` が `allow` の違反も混ざっている。承認 UI には
 * 全部出すが (承認者はリクエスト全体を見て押す)、答えを要するのは `review` の
 * 違反だけである。どの受理条件から出た所見かは位置で分かり、解決済み
 * ドキュメントはこの broker が持っているので、ここで引ける。
 *
 * 受理条件に紐づかない所見 — 走査が完了しなかった記録 — はどの条件が違反した
 * はずかを言えない。検査未完了はルールが宣言する中で最も厳しい帰結を取り、
 * それが `review` だったからここへ来ているので、答えを要する側に数える。
 * 承認には変換できないので、呼び出し側がそこで拒否する。
 */
function violationNeedsApproval(
  rule: ResolvedRule,
  finding: ViolationFinding,
): boolean {
  if (finding.expect < 0) return true;
  const expect = rule.expect[finding.expect];
  // 位置が解決済みルールの外を指すなら、addon と broker が別のドキュメントを
  // 読んでいる。黙って無視せず、答えを要する側に数えて呼び出し側で止める。
  return expect === undefined || expect.onViolation === "review";
}

/**
 * 違反の承認の同一性 (ルール ID, 受理条件の位置, 違反した値) を 1 本の鍵にする。
 *
 * ターゲットは入らない。ルールはちょうど 1 つのスコープに属し、スコープが
 * ターゲット集合を決めるので、ルール ID が既に「どこに向けて」を閉じている。
 *
 * 受理条件の位置が入るのは、ルール ID と値だけでは粗いからである。
 * `anthropic.messages` で `"fallback"` を承認したとき、`/**` + `/content/*` で
 * 見つけた 1 件を承認したつもりが `/system/*` でも通ってしまう。
 *
 * 位置で識別できるのは、解決済みドキュメントがセッション開始時に 1 度だけ
 * 作られてこの broker と寿命を共にするからである。承認をセッションを跨いで
 * 永続化するなら位置では足りず、`expect` にキーを与える必要がある。
 *
 * 値を持たない受理条件 (`EmptyBody` / `JsonRoot`) では値の成分が無くなり、
 * 「この受理条件をこのセッションの間は満たさなくてよい」を意味する。ルール
 * 全体を無効にするわけではないので、同じルールの他の受理条件は効き続ける。
 *
 * 「値が無い」と「値が空文字列」は別の違反である。`UnionShape` は、対象が
 * オブジェクトでない・discriminator が無い・文字列でない、のいずれでも値の
 * 無い違反を出す一方、`{"type": ""}` は値が空文字列の違反を出す。前者を承認
 * した人は後者を見ていないので、同じ鍵に落としてはならない。`JSON.stringify`
 * が `null` と `""` を書き分けるので、それを鍵の成分にする。
 */
function violationKey(ruleId: string, finding: ViolationFinding): string {
  return `${ruleId}\u0000${finding.expect}\u0000${JSON.stringify(finding.value)}`;
}

/**
 * 1 つのカードにまとめる違反の範囲。
 *
 * まだ答えの無い違反の集合そのもので束ねる。同じ組み合わせを持つリクエストは
 * 同じ問いなので 1 枚のカードで足り、会話履歴の再送で飛んでくる同じ違反が
 * カードを増やさない。
 */
function violationGroupKey(
  sessionId: string,
  ruleId: string,
  identities: readonly string[],
): string {
  return [sessionId, ruleId, ...[...identities].sort()].join("\u0000");
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
 * ボディそのものは broker に来ない。候補ごとのボディ条件の真偽は `decide`
 * へ注入する別の葉述語が読むので、ここでは候補を集める構文部分だけを渡す。
 */
function toAuthzRequest(message: AuthorizeRequest): {
  method: string;
  path: string;
  transport: AuthorizeRequest["transport"];
} {
  return {
    method: message.method.toUpperCase(),
    path: pathForSelection(message.reviewContext?.path ?? ""),
    transport: message.transport,
  };
}

/**
 * 違反の確認を pending エントリにする。
 *
 * `violations` に載せるのは、その確認で押せる違反そのものである。カードに
 * 出したものと承認が覚えるものが同じでなければ、押した人は見ていないものを
 * 通すことになる。
 */
function toViolationPendingEntry(
  message: RequestPolicyReviewRequest,
  group: ViolationPendingGroup,
  maskedReviewContext: ReviewContext | undefined,
  maskedFindings: ViolationFinding[],
): PendingEntry {
  return {
    version: 1,
    sessionId: message.sessionId,
    requestId: message.requestId,
    target: message.target,
    method: message.method,
    // ボディを読んだ後に起きる確認なので、CONNECT ではありえない。
    requestKind: "forward",
    state: "pending",
    createdAt: group.createdAt,
    updatedAt: new Date().toISOString(),
    reviewContext: maskedReviewContext,
    ruleId: group.ruleId,
    // `askReason` は載せない。この確認の理由は判定の理由ではなく、下に並ぶ
    // 違反そのものである。
    approvalScopes: [...group.allowedScopes],
    // この確認が通しても資格情報は増えない。注入するかどうかは authorize が
    // 既に決めていて、ここでの答えは違反を通すかどうかだけである。
    injectHeaders: [],
    violations: maskedFindings,
  };
}

function toPendingEntry(
  message: AuthorizeRequest,
  group: AuthorizePendingGroup,
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
    // この確認が出た理由。承認の同一性に入っているものをそのまま出す
    // (`pendingGroupKey` / `approvalKeys` が同じ値を鍵に使う) ので、カードは
    // 押した答えが何に対して覚えられるかを言えるようになる。
    askReason: group.reason,
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
