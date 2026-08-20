import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { queryAuditLogs } from "../audit/store.ts";
import { _resetNotifySendCache } from "../lib/notify_utils.ts";
import type { ResolvedDocument } from "./authz/resolve.ts";
import { documentWithScopes, resolvedDocument } from "./authz/testing.ts";
import { SessionBroker, sendBrokerRequest } from "./broker.ts";
import type {
  AuthorizeRequest,
  DecisionResponse,
  PendingEntry,
  RequestPolicyOutcomeRequest,
  RequestPolicyOutcomeResponse,
  RequestPolicyReviewRequest,
  ViolationFinding,
} from "./protocol.ts";
import { resolveNetworkRuntimePaths } from "./registry.ts";

test("SessionBroker: allow rule returns allow immediately", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      example: { targets: ["example.com"], fallback: "allow" },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_1", "example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("scope-fallback");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("allow");
    expect(logs[0].reason).toEqual("scope-fallback");
    expect(logs[0].phase).toEqual("authorization");
    expect(logs[0].target).toEqual("example.com:443");
    expect(logs[0].requestId).toEqual("req_1");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

const OUTCOME_DOCUMENT = documentWithScopes({
  policy: {
    targets: ["api.example.com"],
    fallback: "allow",
    rules: {
      bodyless: {
        match: { methods: ["GET"], paths: ["/health"] },
        onMatch: "allow",
        expect: [{ kind: "emptyBody" }],
      },
      json: {
        match: {
          methods: ["POST"],
          paths: ["/v1/messages"],
          body: { format: "json" },
        },
        onMatch: "allow",
      },
    },
  },
});

const POST_REVIEW_DOCUMENT = documentWithScopes({
  openai: {
    targets: ["*.openai.com"],
    fallback: "allow",
    rules: {
      post: {
        match: { methods: ["POST"], paths: ["/**"] },
        onMatch: "review",
      },
    },
  },
});

const UNAUDITED_OUTCOME_DOCUMENT = documentWithScopes({
  policy: {
    targets: ["api.example.com"],
    fallback: "allow",
    audit: "off",
    rules: {
      bodyless: {
        match: { methods: ["GET"], paths: ["/health"] },
        onMatch: "allow",
        expect: [{ kind: "emptyBody" }],
      },
      json: {
        match: {
          methods: ["POST"],
          paths: ["/v1/messages"],
          body: { format: "json" },
        },
        onMatch: "allow",
      },
    },
  },
});

test("SessionBroker: request policy outcome rejects the closed invalid matrix without auditing", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    const invalidOutcomes = [
      ["mismatched session", { sessionId: "sess_other" }],
      ["malformed rule ID", { ruleId: "Policy JSON" }],
      ["unknown rule ID", { ruleId: "unknown" }],
      ["ID-less rule ID", { ruleId: "" }],
      ["rule ID from another scope", { ruleId: "other.json" }],
      ["unknown result", { result: "allow" }],
      ["unknown reason", { reason: "raw-secret-reason" }],
      ["pass with a rewrite reason", { result: "pass", reason: "masked-json" }],
      ["pass with a block reason", { result: "pass", reason: "invalid-json" }],
      [
        "rewrite with a pass reason",
        { result: "rewrite", reason: "recognized-json" },
      ],
      ["block with success reason", { result: "block", reason: "masked-json" }],
      ["unexpected raw target", { target: "sensitive.example" }],
    ] as const;

    for (const [name, overrides] of invalidOutcomes) {
      const response = await sendBrokerRequest<{
        type: "error";
        requestId: string;
        message: string;
      }>(socketPath, {
        version: 1,
        type: "request_policy_outcome",
        requestId: `req-invalid-${name}`,
        sessionId: "sess_policy",
        ruleId: "policy.json",
        result: "pass",
        reason: "recognized-json",
        ...overrides,
      } as unknown as RequestPolicyOutcomeRequest);
      expect(response.type).toEqual("error");
    }
    expect(await queryAuditLogs({ domain: "network" }, auditDir)).toEqual([]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: request policy outcome derives audit metadata from broker rules", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    const outcomes = [
      {
        requestId: "req-bodyless-pass",
        ruleId: "policy.bodyless",
        result: "pass",
        reason: "empty-body",
        decision: "allow",
        route: "/health",
      },
      {
        requestId: "req-json-rewrite",
        ruleId: "policy.json",
        result: "rewrite",
        reason: "masked-json",
        decision: "allow",
        route: "/v1/messages",
      },
      {
        requestId: "req-json-block",
        ruleId: "policy.json",
        result: "block",
        reason: "invalid-json",
        decision: "deny",
        route: "/v1/messages",
      },
    ] as const;

    for (const outcome of outcomes) {
      const response = await sendBrokerRequest<RequestPolicyOutcomeResponse>(
        socketPath,
        {
          version: 1,
          type: "request_policy_outcome",
          requestId: outcome.requestId,
          sessionId: "sess_policy",
          ruleId: outcome.ruleId,
          result: outcome.result,
          reason: outcome.reason,
        },
      );
      expect(response).toEqual({
        version: 1,
        type: "request_policy_outcome_recorded",
        requestId: outcome.requestId,
      });
    }

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs).toHaveLength(outcomes.length);
    for (const outcome of outcomes) {
      const log = logs.find((entry) => entry.requestId === outcome.requestId);
      expect(log).toMatchObject({
        phase: "request-policy",
        requestId: outcome.requestId,
        ruleId: outcome.ruleId,
        decision: outcome.decision,
        reason: outcome.reason,
        // 経路はルールが宣言したパターン。リクエストのパスは報告に載らない。
        route: outcome.route,
        requestPolicyResult: outcome.result,
      });
      expect(log?.target).toBeUndefined();
      expect(log?.injectedHeaders).toBeUndefined();
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: the audit records which condition a violation broke", async () => {
  // 理由は閉じた語彙なので `schema-mismatch` としか言えない。どの受理条件が
  // どの値で落ちたかは所見にしかないので、所見が記録に入らないとセッションが
  // 終わったあとに何も分からない。
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    await sendBrokerRequest<RequestPolicyOutcomeResponse>(socketPath, {
      version: 1,
      type: "request_policy_outcome",
      requestId: "req-violations",
      sessionId: "sess_policy",
      ruleId: "policy.json",
      result: "block",
      reason: "schema-mismatch",
      findings: [
        {
          expect: 0,
          expectKind: "unionShape",
          at: "/**/content/*",
          kind: "schema-mismatch",
          pointer: "/messages/0/content/1",
          value: "future_block",
          excerpt: '{"type":"future_block"}',
          count: 2,
        },
      ],
    });

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs).toHaveLength(1);
    // 抜粋は載らない。承認 UI が違反箇所を見せるための成果物であって、ログを
    // 読む人が違反を特定するのに要るものではない。
    expect(logs[0].violations).toEqual([
      {
        expect: 0,
        at: "/**/content/*",
        kind: "schema-mismatch",
        pointer: "/messages/0/content/1",
        value: "future_block",
        count: 2,
      },
    ]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: an outcome with no violation records none", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    await sendBrokerRequest<RequestPolicyOutcomeResponse>(socketPath, {
      version: 1,
      type: "request_policy_outcome",
      requestId: "req-clean",
      sessionId: "sess_policy",
      ruleId: "policy.json",
      result: "pass",
      reason: "recognized-json",
      findings: [],
    });

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs).toHaveLength(1);
    expect(logs[0].violations).toBeUndefined();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

function review(
  requestId: string,
  findings: ViolationFinding[],
  ruleId = "policy.json",
): RequestPolicyReviewRequest {
  return {
    version: 1,
    type: "request_policy_review",
    requestId,
    sessionId: "sess_policy",
    ruleId,
    target: { host: "api.example.com", port: 443 },
    method: "POST",
    findings,
  };
}

function finding(
  value: string | null,
  overrides: Partial<ViolationFinding> = {},
): ViolationFinding {
  return {
    expect: 0,
    expectKind: "unionShape",
    at: "/**/content/*",
    kind: "schema-mismatch",
    pointer: "/messages/0/content/1",
    value,
    excerpt: `{"type":"${value}"}`,
    count: 1,
    ...overrides,
  };
}

async function withReviewBroker(
  body: (context: {
    socketPath: string;
    auditDir: string;
    broker: SessionBroker;
  }) => Promise<void>,
): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-review-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    await body({ socketPath, auditDir, broker });
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
}

test("SessionBroker: a violation is confirmed with the finding on the card", async () => {
  await withReviewBroker(async ({ socketPath, auditDir }) => {
    const pendingDecision = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-review-1", [finding("future_block")]),
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items).toHaveLength(1);
    // 押せる対象そのものがカードに載る。ボディの先頭 1024 バイトでは
    // 100KB のリクエストの違反箇所は見えない。
    expect(pending.items[0].violations).toEqual([finding("future_block")]);
    expect(pending.items[0].ruleId).toEqual("policy.json");
    // 判定の理由は載らない。この確認の理由は上に並んでいる違反である。
    expect(pending.items[0].askReason).toBeUndefined();
    // ターゲットは同一性に入らないので、広さを選ぶ粒度は出さない。
    expect(pending.items[0].approvalScopes).toEqual(["once", "violation"]);
    // この答えが通しても資格情報は増えない。
    expect(pending.items[0].injectHeaders).toEqual([]);

    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req-review-1",
      scope: "violation",
    });
    expect((await pendingDecision).decision).toEqual("allow");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs).toHaveLength(1);
    expect(logs[0].phase).toEqual("request-policy");
    expect(logs[0].reason).toEqual("approved-by-user");
    expect(logs[0].violations?.[0].value).toEqual("future_block");
  });
});

test("SessionBroker: a finding is masked again with the whole registry", async () => {
  // addon がマスクに使うのは、そのルールで `mask` と宣言された秘密だけである。
  // `ignore` の秘密が違反ノードの中にいれば addon のマスクは通り抜けるので、
  // 人が読む面へ出す前に reviewContext と同じ広さで伏せ直す。
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-review-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
    secretValues: { ignored: ["s3cret-value"] },
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    const decision = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-masked", [
        finding("future_block", {
          pointer: "/messages/s3cret-value/content/1",
          excerpt: '{"type":"future_block","note":"s3cret-value"}',
        }),
      ]),
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items[0].violations?.[0]).toMatchObject({
      pointer: "/messages/****/content/1",
      excerpt: '{"type":"future_block","note":"****"}',
    });

    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req-masked",
    });
    await decision;
    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs[0].violations?.[0].pointer).toEqual("/messages/****/content/1");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: an approved violation is not confirmed again", async () => {
  // 会話履歴は毎リクエスト再送されるので、これが効かないと 1 度押した確認が
  // ターンごとに戻ってくる。
  await withReviewBroker(async ({ socketPath }) => {
    const first = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-first", [finding("future_block")]),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req-first",
      scope: "violation",
    });
    await first;

    const second = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-second", [finding("future_block")]),
    );
    expect(second).toMatchObject({ decision: "allow", reason: "approved" });
    const pending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    expect(pending.items).toHaveLength(0);
  });
});

test("SessionBroker: an approval covers the value it was shown and no other", async () => {
  await withReviewBroker(async ({ socketPath }) => {
    const first = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-approved", [finding("future_block")]),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req-approved",
      scope: "violation",
    });
    await first;

    // 別の値は別の許可である。
    const otherValue = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-other-value", [finding("other_block")]),
    );
    // 同じ値でも、見つけた受理条件が違えば別の許可である。`/**/content/*` で
    // 1 件承認したつもりが `/system/*` でも通ってはならない。
    const otherCondition = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-other-condition", [
        finding("future_block", { expect: 1, at: "/system/*" }),
      ]),
    );
    const pending = await waitForPending(socketPath, 2);
    expect(pending.items.map((item) => item.requestId).sort()).toEqual([
      "req-other-condition",
      "req-other-value",
    ]);

    for (const requestId of ["req-other-value", "req-other-condition"]) {
      await sendBrokerRequest(socketPath, { type: "deny", requestId });
    }
    expect((await otherValue).decision).toEqual("deny");
    expect((await otherCondition).decision).toEqual("deny");
  });
});

test("SessionBroker: approving a rule does not approve its violations", async () => {
  // 2 種類の承認は別の集合にある。「このホストへこのルールを通してよい」と
  // 押した人は、そのルールが未知の値を見ても通してよいとは言っていない。
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-review-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: documentWithScopes(
      {
        policy: {
          targets: ["api.example.com"],
          fallback: "deny",
          rules: {
            json: {
              match: {
                methods: ["POST"],
                paths: ["/v1/messages"],
                body: { format: "json" },
              },
              onMatch: "review",
              expect: [
                {
                  kind: "unionShape",
                  at: "/**/content/*",
                  discriminator: "type",
                  allowed: ["text"],
                  onViolation: "review",
                },
              ],
            },
          },
        },
      },
      "deny",
    ),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    const authorized = sendBrokerRequest<DecisionResponse>(socketPath, {
      version: 1,
      type: "authorize",
      requestId: "req-rule",
      sessionId: "sess_policy",
      target: { host: "api.example.com", port: 443 },
      method: "POST",
      transport: "http",
      requestKind: "forward",
      observedAt: new Date().toISOString(),
      bodyTruth: { "policy.json": "true" },
      reviewContext: {
        path: "/v1/messages",
        contentType: "application/json",
        bodySize: 2,
      },
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req-rule",
      scope: "host-port",
    });
    expect((await authorized).decision).toEqual("allow");

    // 同じルールの違反はまだ誰も押していない。
    const violation = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-violation", [finding("future_block")], "policy.json"),
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items[0].requestId).toEqual("req-violation");
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req-violation",
    });
    expect((await violation).decision).toEqual("deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: an empty value is not the same violation as no value", async () => {
  // `UnionShape` は、対象がオブジェクトでない・discriminator が無い・文字列で
  // ないのいずれでも値の無い違反を出し、`{"type": ""}` は値が空文字列の違反を
  // 出す。前者を承認した人は後者を見ていない。
  await withReviewBroker(async ({ socketPath }) => {
    const first = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-null-value", [finding(null)]),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req-null-value",
      scope: "violation",
    });
    await first;

    const emptyValue = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-empty-value", [finding("")]),
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items[0].requestId).toEqual("req-empty-value");
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req-empty-value",
    });
    expect((await emptyValue).decision).toEqual("deny");
  });
});

const MIXED_CONSEQUENCE_DOCUMENT = documentWithScopes({
  policy: {
    targets: ["api.example.com"],
    fallback: "deny",
    rules: {
      json: {
        match: {
          methods: ["POST"],
          paths: ["/v1/messages"],
          body: { format: "json" },
        },
        onMatch: "allow",
        audit: "always",
        expect: [
          {
            kind: "unionShape",
            at: "/**/content/*",
            discriminator: "type",
            allowed: ["text"],
            onViolation: "allow",
          },
          {
            kind: "unionShape",
            at: "/system/*",
            discriminator: "type",
            allowed: ["text"],
            onViolation: "review",
          },
        ],
      },
    },
  },
});

async function withMixedBroker(
  body: (socketPath: string) => Promise<void>,
): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-mixed-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: MIXED_CONSEQUENCE_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    await body(socketPath);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
}

test("SessionBroker: a recorded violation does not become a question", async () => {
  // `onViolation = "allow"` は「記録して通せ、訊くな」である。所見には載る
  // ので承認者はリクエスト全体を見られるが、押す対象にはならない。ここを
  // 分けないと、リクエストごとに変わる値のせいで確認が毎ターン出る。
  await withMixedBroker(async (socketPath) => {
    const recorded = finding("recorded_a", { expect: 0 });
    const asked = finding("asked", { expect: 1, at: "/system/*" });
    const first = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-mixed-1", [recorded, asked]),
    );
    const pending = await waitForPending(socketPath);
    // カードには両方載る。押した結果が覆うのは `review` の側だけである。
    expect(
      pending.items[0].violations?.map((violation) => violation.value),
    ).toEqual(["recorded_a", "asked"]);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req-mixed-1",
      scope: "violation",
    });
    expect((await first).decision).toEqual("allow");

    // 次のターン: `allow` の側の値だけが変わっている。同じ問いは戻らない。
    const second = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-mixed-2", [finding("recorded_b", { expect: 0 }), asked]),
    );
    expect(second).toMatchObject({ decision: "allow", reason: "approved" });
  });
});

test("SessionBroker: a recorded violation overflowing its allowance is not a refusal", async () => {
  // 打ち切りの記録は承認に変換できない。だが `allow` の条件が自分の上限を
  // 埋めただけなら、答えを要する違反は 1 つも失われていない。
  await withMixedBroker(async (socketPath) => {
    const decision = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-mixed-truncated", [
        finding(null, { expect: 0, kind: "findings-truncated", count: 40 }),
        finding("asked", { expect: 1, at: "/system/*" }),
      ]),
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items[0].requestId).toEqual("req-mixed-truncated");
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req-mixed-truncated",
      scope: "violation",
    });
    expect((await decision).decision).toEqual("allow");
  });
});

test("SessionBroker: a review with nothing to answer is refused", async () => {
  // addon は `review` の違反があるときだけ問い合わせる。1 件も見当たらない
  // なら両者が別のドキュメントを読んでいるので、fail-closed で止める。
  await withMixedBroker(async (socketPath) => {
    const decision = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-mixed-none", [finding("recorded", { expect: 0 })]),
    );
    expect(decision).toMatchObject({
      decision: "deny",
      reason: "review-condition-mismatch",
    });
  });
});

test("SessionBroker: a malformed review context is refused, not fatal", async () => {
  // broker はカードに出す前に path をマスクする。文字列でなければマスクが
  // 例外を投げるので、形を検証しないと 1 通でセッションのネットワークごと
  // 落とせる。
  await withReviewBroker(async ({ socketPath }) => {
    const response = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, {
      ...review("req-bad-context", [finding("future_block")]),
      reviewContext: { path: 1 },
    } as unknown as RequestPolicyReviewRequest);
    expect(response.type).toEqual("error");

    // broker は生きている。
    const pending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    expect(pending.items).toHaveLength(0);
  });
});

test("SessionBroker: a malformed authorization truth table is rejected whole", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-truth-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_truth",
    document: POST_REVIEW_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_truth/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, {
      ...post("sess_truth", "req_bad_truth", "/x"),
      bodyTruth: { "openai.post": "yes" },
    } as unknown as AuthorizeRequest);

    expect(response.type).toEqual("error");
    expect(await broker.listPending()).toEqual([]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a denied violation stays denied without asking again", async () => {
  await withReviewBroker(async ({ socketPath }) => {
    const first = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-denied", [finding("future_block")]),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req-denied",
      scope: "violation",
    });
    expect((await first).decision).toEqual("deny");

    const second = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-denied-again", [finding("future_block")]),
    );
    expect(second).toMatchObject({
      decision: "deny",
      reason: "denied-by-user",
    });
  });
});

test("SessionBroker: a violation nobody can approve is refused, not asked about", async () => {
  // 走査が完了しなかった記録と、保持上限で畳まれた記録は受理条件か値を欠く。
  // 承認 UI に出しても押した人のリクエストは通らないままになる。
  await withReviewBroker(async ({ socketPath, auditDir }) => {
    for (const [requestId, unapprovable] of [
      [
        "req-incomplete",
        finding(null, {
          expect: -1,
          expectKind: "",
          kind: "inspection-incomplete",
          excerpt: null,
        }),
      ],
      [
        "req-truncated",
        finding(null, { kind: "findings-truncated", excerpt: null }),
      ],
    ] as const) {
      const decision = await sendBrokerRequest<DecisionResponse>(
        socketPath,
        review(requestId, [finding("future_block"), unapprovable]),
      );
      expect(decision).toMatchObject({
        decision: "deny",
        reason: "unapprovable-violation",
      });
    }
    const pending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    expect(pending.items).toHaveLength(0);
    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.map((entry) => entry.reason)).toEqual([
      "unapprovable-violation",
      "unapprovable-violation",
    ]);
  });
});

test("SessionBroker: a violation card only offers the grains it was built with", async () => {
  await withReviewBroker(async ({ socketPath }) => {
    const decision = sendBrokerRequest<DecisionResponse>(
      socketPath,
      review("req-scope", [finding("future_block")]),
    );
    await waitForPending(socketPath);
    const refused = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, { type: "approve", requestId: "req-scope", scope: "host" });
    expect(refused.type).toEqual("error");

    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req-scope",
    });
    expect((await decision).decision).toEqual("deny");
  });
});

test("SessionBroker: a review naming a rule with no expectations is refused", async () => {
  await withReviewBroker(async ({ socketPath }) => {
    const response = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(
      socketPath,
      review("req-fallback", [finding("future_block")], "policy.$fallback"),
    );
    expect(response.type).toEqual("error");
  });
});

test("SessionBroker: an invalid review is refused without a card", async () => {
  await withReviewBroker(async ({ socketPath }) => {
    const invalid = [
      ["another session", { sessionId: "sess_other" }],
      ["an unknown rule", { ruleId: "policy.unknown" }],
      ["no violation at all", { findings: [] }],
      ["an unusable target", { target: { host: "", port: 443 } }],
      ["a method that is not one", { method: "POST /v1/messages" }],
      ["an unknown field", { bodyPreview: "raw body" }],
    ] as const;
    for (const [name, overrides] of invalid) {
      const response = await sendBrokerRequest<{
        type: "error";
        requestId: string;
        message: string;
      }>(socketPath, {
        ...review(`req-invalid-${name}`, [finding("future_block")]),
        ...overrides,
      } as unknown as RequestPolicyReviewRequest);
      expect(response.type).toEqual("error");
    }
    const pending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    expect(pending.items).toHaveLength(0);
  });
});

test("SessionBroker: request policy outcome is acknowledged without an audit directory", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<RequestPolicyOutcomeResponse>(
      socketPath,
      {
        version: 1,
        type: "request_policy_outcome",
        requestId: "req-policy-no-audit",
        sessionId: "sess_policy",
        ruleId: "policy.bodyless",
        result: "pass",
        reason: "empty-body",
      },
    );
    expect(response.type).toEqual("request_policy_outcome_recorded");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: request policy outcome with audit false records no row", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy_no_audit",
    document: UNAUDITED_OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy_no_audit/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<RequestPolicyOutcomeResponse>(
      socketPath,
      {
        version: 1,
        type: "request_policy_outcome",
        requestId: "req-policy-audit-disabled",
        sessionId: "sess_policy_no_audit",
        ruleId: "policy.json",
        result: "pass",
        reason: "recognized-json",
      },
    );

    expect(response.type).toEqual("request_policy_outcome_recorded");
    expect(await queryAuditLogs({ domain: "network" }, auditDir)).toEqual([]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: request policy outcome with audit false ignores audit-store failure", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const invalidAuditDir = path.join(runtimeDir, "audit-file");
  await writeFile(invalidAuditDir, "not a directory");
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy_no_audit",
    document: UNAUDITED_OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir: invalidAuditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy_no_audit/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<RequestPolicyOutcomeResponse>(
      socketPath,
      {
        version: 1,
        type: "request_policy_outcome",
        requestId: "req-policy-audit-disabled-store-failure",
        sessionId: "sess_policy_no_audit",
        ruleId: "policy.json",
        result: "block",
        reason: "processing-failed",
      },
    );

    expect(response).toEqual({
      version: 1,
      type: "request_policy_outcome_recorded",
      requestId: "req-policy-audit-disabled-store-failure",
    });
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: request-policy outcome audit unavailable returns a sanitized error", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const invalidAuditDir = path.join(runtimeDir, "audit-file");
  await writeFile(invalidAuditDir, "not a directory");
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    document: OUTCOME_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir: invalidAuditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_policy/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, {
      version: 1,
      type: "request_policy_outcome",
      requestId: "req-policy-audit-failure",
      sessionId: "sess_policy",
      ruleId: "policy.json",
      result: "block",
      reason: "processing-failed",
    });

    expect(response).toEqual({
      type: "error",
      requestId: "req-policy-audit-failure",
      message: "request-policy outcome audit unavailable",
    });
    expect(JSON.stringify(response)).not.toContain(invalidAuditDir);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: pending request resumes after approve", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_approve", "api.openai.com", 443),
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items.length).toEqual(1);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_approve",
      scope: "host-port",
    });
    const decision = await authorizePromise;
    expect(decision.decision).toEqual("allow");
    expect(decision.scope).toEqual("host-port");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("allow");
    expect(logs[0].reason).toEqual("approved-by-user");
    expect(logs[0].target).toEqual("api.openai.com:443");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: each rule's waiters keep their own credentials and audit behavior", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grouped-"));
  const auditDir = await mkdtemp(
    path.join(tmpdir(), "nas-broker-grouped-audit-"),
  );
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_grouped",
    document: resolvedDocument({
      secrets: {
        "cred-a": { from: "env:A" },
        "cred-b": { from: "env:B" },
        "cred-c": { from: "env:C" },
      },
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            secrets: {
              "cred-a": "inject",
              "cred-b": "inject",
              "cred-c": "inject",
            },
            rules: {
              "path-a": {
                match: { methods: ["POST"], paths: ["/path-a"] },
                onMatch: "review",
                inject: [{ name: "X-Path-A", value: "secret:cred-a" }],
              },
              "path-b": {
                match: { methods: ["POST"], paths: ["/path-b"] },
                onMatch: "review",
                inject: [{ name: "X-Path-B", value: "secret:cred-b" }],
              },
              "path-c": {
                match: { methods: ["POST"], paths: ["/path-c"] },
                onMatch: "review",
                audit: "off",
                inject: [{ name: "X-Path-C", value: "secret:cred-c" }],
              },
            },
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
    secretValues: {
      "cred-a": ["credential-a"],
      "cred-b": ["credential-b"],
      "cred-c": ["credential-c"],
    },
  });
  const socketPath = `${paths.brokersDir}/sess_grouped/sock`;
  await broker.start(socketPath);
  const authorizationLogs = async () =>
    (await queryAuditLogs({ domain: "network" }, auditDir)).filter(
      (entry) => entry.phase === "authorization",
    );
  try {
    const firstA = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_grouped",
        "req_grouped_a1",
        "/path-a",
        "api.example.com",
        443,
        "api.path-a",
      ),
    );
    const secondA = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_grouped",
        "req_grouped_a2",
        "/path-a",
        "api.example.com",
        443,
        "api.path-a",
      ),
    );
    const pathB = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_grouped",
        "req_grouped_b",
        "/path-b",
        "api.example.com",
        443,
        "api.path-b",
      ),
    );
    const pathC = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_grouped",
        "req_grouped_c",
        "/path-c",
        "api.example.com",
        443,
        "api.path-c",
      ),
    );

    const pending = await waitForPending(socketPath, 4);
    expect(pending.items.map((item) => item.requestId).sort()).toEqual([
      "req_grouped_a1",
      "req_grouped_a2",
      "req_grouped_b",
      "req_grouped_c",
    ]);

    // Both /path-a requests are the same rule against the same target, so
    // one press answers for both — and for neither of the other rules'.
    expect(
      await sendBrokerRequest(socketPath, {
        type: "approve",
        requestId: "req_grouped_a1",
        scope: "once",
      }),
    ).toEqual({
      type: "ack",
      requestId: "req_grouped_a1",
      decision: "approve",
    });
    for (const decision of [await firstA, await secondA]) {
      expect(decision).toMatchObject({
        decision: "allow",
        ruleId: "api.path-a",
        injectHeaders: [{ name: "X-Path-A", value: "credential-a" }],
      });
    }

    // The card that was answered showed the /path-a requests and the header
    // api.path-a injects. The other rules' requests were not on it, so they
    // are still waiting and nothing has been let through in their name.
    // Their entries are removed while `approve` is being answered, so this
    // is the settled list rather than a snapshot taken mid-flight.
    const stillPending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    expect(stillPending.items.map((item) => item.requestId).sort()).toEqual([
      "req_grouped_b",
      "req_grouped_c",
    ]);
    const afterA = await authorizationLogs();
    expect(afterA.map((entry) => entry.requestId).sort()).toEqual([
      "req_grouped_a1",
      "req_grouped_a2",
    ]);
    for (const entry of afterA) {
      expect(entry.injectedHeaders).toEqual(["X-Path-A"]);
    }

    // Each of the others still needs its own press, and gets its own
    // credential when it is answered.
    expect(
      await sendBrokerRequest(socketPath, {
        type: "approve",
        requestId: "req_grouped_b",
        scope: "once",
      }),
    ).toEqual({ type: "ack", requestId: "req_grouped_b", decision: "approve" });
    expect(await pathB).toMatchObject({
      decision: "allow",
      ruleId: "api.path-b",
      injectHeaders: [{ name: "X-Path-B", value: "credential-b" }],
    });

    expect(
      await sendBrokerRequest(socketPath, {
        type: "approve",
        requestId: "req_grouped_c",
        scope: "once",
      }),
    ).toEqual({ type: "ack", requestId: "req_grouped_c", decision: "approve" });
    expect(await pathC).toMatchObject({
      decision: "allow",
      ruleId: "api.path-c",
      injectHeaders: [{ name: "X-Path-C", value: "credential-c" }],
    });

    // api.path-c sets audit = "off", so its approval leaves no record while
    // the other two rules keep theirs, each with the header it injects.
    const finalLogs = await authorizationLogs();
    expect(
      finalLogs.map((entry) => [entry.requestId, entry.injectedHeaders]).sort(),
    ).toEqual([
      ["req_grouped_a1", ["X-Path-A"]],
      ["req_grouped_a2", ["X-Path-A"]],
      ["req_grouped_b", ["X-Path-B"]],
    ]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * 実 ID が衝突した解決済みドキュメントを手で組む。
 *
 * この形は設定検査が弾くので `resolveAuthzConfig` からは出てこない。broker が
 * その検査の結果だけに頼らず、承認をそれが出たターゲットに閉じ込めていることを
 * 確かめるために、検査を通さずに組み立てる。
 */
function documentWithSharedRuleId(): ResolvedDocument {
  const base = resolvedDocument({
    secrets: { deploy: { from: "env:DEPLOY_TOKEN" } },
    network: {
      scopes: {
        github: {
          targets: ["api.github.com:443"],
          rules: {
            read: {
              match: { methods: ["POST"], paths: ["/**"] },
              onMatch: "review",
            },
          },
        },
        internal: {
          targets: ["internal.example.com:443"],
          secrets: { deploy: "inject" },
          rules: {
            read: {
              match: { methods: ["POST"], paths: ["/**"] },
              onMatch: "review",
              inject: [
                // biome-ignore lint/suspicious/noTemplateCurlyInString: `template:` の参照構文であってテンプレートリテラルではない
                { name: "Authorization", value: "template:Bearer ${deploy}" },
              ],
            },
          },
        },
      },
    },
  });
  return {
    ...base,
    scopes: base.scopes.map((scope) => ({
      ...scope,
      rules: scope.rules.map((rule) => ({ ...rule, id: "github.api.read" })),
    })),
  };
}

test("SessionBroker: a rule-grain approval releases only its own target", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grain-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_grain",
    document: documentWithSharedRuleId(),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { deploy: ["deploy-token"] },
  });
  const socketPath = `${paths.brokersDir}/sess_grain/sock`;
  await broker.start(socketPath);
  try {
    const shown = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_grain",
        "req_shown",
        "/x",
        "api.github.com",
        443,
        "github.api.read",
      ),
    );
    const shownPending = await waitForPending(socketPath);
    // ターゲットを 1 つに固定したスコープなので「このルールが有効な間ずっと」を選べる。
    expect(shownPending.items[0]?.approvalScopes).toContain("rule");
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_shown",
      scope: "rule",
    });
    expect(await shown).toMatchObject({ decision: "allow" });

    // 承認された相手は api.github.com:443 だけである。実 ID が同じでも、人が
    // 見ていない internal.example.com:443 に答えが流用されてはならない。
    const unseen = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_grain",
        "req_unseen",
        "/x",
        "internal.example.com",
        443,
        "github.api.read",
      ),
    );
    expect(
      await Promise.race([
        unseen.then((decision) => decision as DecisionResponse | "still-open"),
        new Promise<"still-open">((resolve) =>
          setTimeout(() => resolve("still-open"), 250),
        ),
      ]),
    ).toEqual("still-open");
    const unseenPending = await waitForPending(socketPath);
    expect(unseenPending.items.map((item) => item.requestId)).toEqual([
      "req_unseen",
    ]);

    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_unseen",
      scope: "once",
    });
    const denied = await unseen;
    expect(denied).toMatchObject({ decision: "deny" });
    expect(JSON.stringify(denied)).not.toContain("deploy-token");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: close resolves pending request after aborting notifications", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const notifyDir = await mkdtemp(path.join(tmpdir(), "nas-broker-notify-"));
  const notifyStartFile = `${notifyDir}/notify-started`;
  const notifyExitFile = `${notifyDir}/notify-exited`;
  const originalPath = process.env.PATH ?? "";
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const healthServer = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname === "/api/health") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  try {
    await writeFile(
      `${notifyDir}/notify-send`,
      `#!/usr/bin/env bash
set -eu
echo started > "${notifyStartFile}"
trap 'echo exited > "${notifyExitFile}"; exit 143' TERM
while true; do sleep 0.05; done
`,
    );
    await writeFile(
      `${notifyDir}/xdg-open`,
      `#!/usr/bin/env bash
true
`,
    );
    await chmod(`${notifyDir}/notify-send`, 0o755);
    await chmod(`${notifyDir}/xdg-open`, 0o755);
    process.env.PATH = `${notifyDir}:${originalPath}`;
    _resetNotifySendCache();

    const broker = new SessionBroker({
      paths,
      sessionId: "sess_test",
      document: documentWithScopes({}, "review"),
      pendingTimeoutSeconds: 30,
      pendingNotify: "desktop",
      uiPort: healthServer.port,
    });
    const socketPath = `${paths.brokersDir}/sess_test/sock`;
    await broker.start(socketPath);
    try {
      const authorizePromise = sendBrokerRequest<DecisionResponse>(
        socketPath,
        authorize("sess_test", "req_close", "api.openai.com", 443),
      );

      await waitForPending(socketPath);
      await waitForFile(notifyStartFile);

      await broker.close();

      const decision = await authorizePromise;
      expect(decision.decision).toEqual("deny");
      expect(decision.reason).toEqual("broker closed");
      await waitForFile(notifyExitFile);
    } finally {
      await broker.close().catch(() => {});
    }
  } finally {
    process.env.PATH = originalPath;
    _resetNotifySendCache();
    await healthServer.stop();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(notifyDir, { recursive: true, force: true }).catch(() => {});
  }
});

function authorize(
  sessionId: string,
  requestId: string,
  host: string,
  port: number,
  ruleId?: string,
  transport: "http" | "websocket" = "http",
): AuthorizeRequest & { transport: "http" | "websocket" } {
  return {
    version: 1,
    type: "authorize",
    requestId,
    sessionId,
    target: { host, port },
    method: "CONNECT",
    transport,
    requestKind: "connect",
    observedAt: new Date().toISOString(),
    bodyTruth: ruleId ? { [ruleId]: "true" } : {},
  };
}

test("SessionBroker: default-denied WebSocket returns immediately without pending", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes(
      {
        api: {
          targets: ["api.example.com"],
          fallback: "review",
          rules: { ws: { match: { paths: ["/**"] }, onMatch: "allow" } },
        },
      },
      "review",
    ),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize(
        "sess_test",
        "req_websocket_deny",
        "api.example.com",
        443,
        undefined,
        "websocket",
      ),
    );

    expect(response).toMatchObject({
      decision: "deny",
      reason: "websocket-denied",
    });
    expect(await broker.listPending()).toEqual([]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: allowed WebSocket review creates one handshake pending group", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        webSocket: "allow",
        rules: {
          ws: {
            match: { methods: ["GET"], paths: ["/ws"] },
            onMatch: "review",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const pendingDecision = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_test",
        "req_websocket_review",
        "api.example.com",
        443,
        "api.ws",
        "websocket",
      ),
      method: "GET",
      requestKind: "forward",
      reviewContext: { path: "/ws", contentType: null, bodySize: 0 },
    });

    const pending = await waitForPending(socketPath);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.requestId).toBe("req_websocket_review");
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_websocket_review",
      scope: "once",
    });
    expect((await pendingDecision).decision).toBe("allow");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny rule returns deny immediately", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      evil: { targets: ["evil.com"], fallback: "deny" },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny", "evil.com", 443),
    );
    expect(response.decision).toEqual("deny");
    expect(response.reason).toEqual("scope-fallback");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("scope-fallback");
    expect(logs[0].target).toEqual("evil.com:443");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: first-match: *.example.com allow rule matches sub.example.com", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      example: { targets: ["*.example.com"], fallback: "allow" },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_wild_allow", "sub.example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("scope-fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: the narrower scope wins over the wildcard that contains it", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      // 宣言順は特異な側が先だが、選択は位置ではなくターゲットの特異度で決まる。
      sub: { targets: ["sub.example.com"], fallback: "allow" },
      wide: { targets: ["*.example.com"], fallback: "deny" },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // sub.example.com belongs to the exact scope even though the wildcard
    // also matches it.
    const allowResponse = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_allow_sub", "sub.example.com", 443),
    );
    expect(allowResponse.decision).toEqual("allow");
    expect(allowResponse.ruleId).toEqual("sub.$fallback");

    // other.example.com only matches the wildcard.
    const denyResponse = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny_other", "other.example.com", 443),
    );
    expect(denyResponse.decision).toEqual("deny");
    expect(denyResponse.reason).toEqual("scope-fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: denied target is cached as recent-deny", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // Send an authorize request that goes to prompt, then deny it
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny_cache", "cached.example.com", 443),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_deny_cache",
    });
    const firstDecision = await authorizePromise;
    expect(firstDecision.decision).toEqual("deny");
    expect(firstDecision.reason).toEqual("denied-by-user");

    // Second request to the same target should be immediately denied
    const secondDecision = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny_cache_2", "cached.example.com", 443),
    );
    expect(secondDecision.decision).toEqual("deny");
    expect(secondDecision.reason).toEqual("recent-deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: negative cache expires after TTL", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    negativeCacheTtlMs: 50,
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // Deny a request to populate the negative cache
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_ttl_1", "ttl.example.com", 443),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_ttl_1",
    });
    await authorizePromise;

    // Immediately should get recent-deny
    const cachedDecision = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_ttl_2", "ttl.example.com", 443),
    );
    expect(cachedDecision.decision).toEqual("deny");
    expect(cachedDecision.reason).toEqual("recent-deny");

    // Wait for TTL to expire, then should go to prompt again
    await new Promise((resolve) => setTimeout(resolve, 100));

    const afterTtlPromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_ttl_3", "ttl.example.com", 443),
    );
    // If the cache expired, the request goes to prompt (pending)
    const pending = await waitForPending(socketPath);
    expect(pending.items.length).toEqual(1);

    // Clean up: approve to resolve the pending request
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_ttl_3",
    });
    const decision = await afterTtlPromise;
    expect(decision.decision).toEqual("allow");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny with host-port scope persists beyond negative-cache TTL", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    negativeCacheTtlMs: 50,
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_scope_deny_1", "persist.example.com", 443),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_scope_deny_1",
      scope: "host-port",
    });
    const firstDecision = await authorizePromise;
    expect(firstDecision.decision).toEqual("deny");
    expect(firstDecision.reason).toEqual("denied-by-user");

    await new Promise((resolve) => setTimeout(resolve, 100));

    const secondDecision = await withTimeout(
      sendBrokerRequest<DecisionResponse>(
        socketPath,
        authorize("sess_test", "req_scope_deny_2", "persist.example.com", 443),
      ),
      500,
    );
    expect(secondDecision.decision).toEqual("deny");
    expect(secondDecision.reason).toEqual("denied-by-user");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: approve after group already resolved returns error", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // Two concurrent authorize requests to the same host:port
    const auth1Promise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_group_a", "grouped.example.com", 443),
    );
    const auth2Promise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_group_b", "grouped.example.com", 443),
    );

    // Wait until both are pending in the group
    await waitForPending(socketPath, 2);

    // Approve via first requestId → entire group resolves (both allowed)
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_group_a",
      scope: "host-port",
    });
    const decision1 = await auth1Promise;
    const decision2 = await auth2Promise;
    expect(decision1.decision).toEqual("allow");
    expect(decision2.decision).toEqual("allow");

    // Now approve the second requestId → group already gone, should not crash
    const ack = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, {
      type: "approve",
      requestId: "req_group_b",
    });
    expect(ack.type).toEqual("error");
    expect(ack.requestId).toEqual("req_group_b");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny-by-default targets blocked even with allow rule", async () => {
  // Regression: allow rules must not bypass the deny-by-default rule for
  // private/loopback addresses.
  const cases: Array<{ host: string; reason: string }> = [
    { host: "localhost", reason: "blocked-special-host" },
    { host: "127.0.0.1", reason: "blocked-private-ip" },
    { host: "10.0.0.1", reason: "blocked-private-ip" },
    { host: "172.16.0.1", reason: "blocked-private-ip" },
    { host: "192.168.1.1", reason: "blocked-private-ip" },
    { host: "169.254.0.1", reason: "blocked-private-ip" },
    { host: "::1", reason: "blocked-private-ip" },
    { host: "fc00::1", reason: "blocked-private-ip" },
    { host: "fe80::1", reason: "blocked-private-ip" },
  ];

  for (const { host, reason } of cases) {
    const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
    const paths = await resolveNetworkRuntimePaths(runtimeDir);
    // Put the deny-by-default host in an allow rule.
    const broker = new SessionBroker({
      paths,
      sessionId: "sess_test",
      document: documentWithScopes({
        target: { targets: [host], fallback: "allow" },
      }),
      pendingTimeoutSeconds: 30,
      pendingNotify: "off",
    });
    const socketPath = `${paths.brokersDir}/sess_test/sock`;
    await broker.start(socketPath);
    try {
      const response = await sendBrokerRequest<DecisionResponse>(
        socketPath,
        authorize("sess_test", `req_${host.replace(/[:.]/g, "_")}`, host, 80),
      );
      expect(response.decision).toEqual("deny");
      expect(response.reason).toEqual(reason);
    } finally {
      await broker.close();
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

test("SessionBroker: approve with unknown scope is rejected and request stays pending", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_scope",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_scope/sock`;
  await broker.start(socketPath);
  try {
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_scope", "req_bad_scope", "example.com", 443),
    );
    await waitForPending(socketPath);
    // Attacker forges a scope value not in the UI-advertised set. The
    // broker must reject the scope without resolving the pending group.
    const response = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, {
      type: "approve",
      requestId: "req_bad_scope",
      scope: "all" as never,
    });
    expect(response.type).toEqual("error");
    expect(response.message.toLowerCase()).toContain("scope not allowed");

    // The pending request must still be pending (not resolved).
    const stillPending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    expect(stillPending.items.length).toEqual(1);

    // Clean up: approve with a valid scope so the socket client unblocks.
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_bad_scope",
      scope: "once",
    });
    const decision = await authorizePromise;
    expect(decision.decision).toEqual("allow");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

const GRANULARITY_DOCUMENT = documentWithScopes(
  {
    pinned: {
      targets: ["api.example.com:443"],
      rules: {
        ask: { match: { paths: ["/**"] }, onMatch: "review" },
      },
    },
    wild: {
      targets: ["*.example.org"],
      rules: {
        ask: { match: { paths: ["/**"] }, onMatch: "review" },
      },
    },
  },
  "review",
);

test("SessionBroker: the offered granularity follows the scope's target", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grain-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_grain",
    document: GRANULARITY_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_grain/sock`;
  await broker.start(socketPath);
  try {
    const waiting = [
      sendBrokerRequest<DecisionResponse>(
        socketPath,
        authorize(
          "sess_grain",
          "req_pinned",
          "api.example.com",
          443,
          "pinned.ask",
        ),
      ),
      sendBrokerRequest<DecisionResponse>(
        socketPath,
        authorize("sess_grain", "req_wild", "sub.example.org", 443, "wild.ask"),
      ),
      sendBrokerRequest<DecisionResponse>(
        socketPath,
        authorize("sess_grain", "req_unscoped", "elsewhere.test", 443),
      ),
    ];
    const pending = await waitForPending(socketPath, 3);
    const grainOf = (requestId: string) =>
      pending.items.find((item) => item.requestId === requestId);

    // The scope fixes host and port, so host / host:port would say the same
    // thing twice. The only real question left is how long it lasts.
    expect(grainOf("req_pinned")).toMatchObject({
      ruleId: "pinned.ask",
      // 押す人には、ルール自身が review を宣言したのか、どのルールも
      // 引き受けなかったのかが見えなければならない。
      askReason: "rule",
      approvalScopes: ["once", "rule"],
    });
    // A wildcard scope does not say which host the rule ran against, so the
    // target still has to be pinned by hand.
    expect(grainOf("req_wild")).toMatchObject({
      ruleId: "wild.ask",
      approvalScopes: ["once", "host-port", "host"],
    });
    // Nothing claimed this target at all.
    expect(grainOf("req_unscoped")).toMatchObject({
      ruleId: "$fallback",
      askReason: "network-fallback",
      approvalScopes: ["once", "host-port", "host"],
    });

    for (const requestId of ["req_pinned", "req_wild", "req_unscoped"]) {
      await sendBrokerRequest(socketPath, {
        type: "deny",
        requestId,
        scope: "once",
      });
    }
    await Promise.all(waiting);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a granularity the entry does not offer is refused", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grain-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_grain_refuse",
    document: GRANULARITY_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_grain_refuse/sock`;
  await broker.start(socketPath);
  try {
    const waiting = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize(
        "sess_grain_refuse",
        "req_pinned",
        "api.example.com",
        443,
        "pinned.ask",
      ),
    );
    await waitForPending(socketPath);
    const refused = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, {
      type: "approve",
      requestId: "req_pinned",
      scope: "host",
    });
    expect(refused.type).toEqual("error");
    expect(refused.message.toLowerCase()).toContain("scope not allowed");

    // The wildcard scope is the one that offers "host"; "rule" is refused
    // there for the same reason, in the other direction.
    const wildWaiting = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize(
        "sess_grain_refuse",
        "req_wild",
        "sub.example.org",
        443,
        "wild.ask",
      ),
    );
    await waitForPending(socketPath, 2);
    const refusedRule = await sendBrokerRequest<{
      type: "error";
      requestId: string;
      message: string;
    }>(socketPath, {
      type: "approve",
      requestId: "req_wild",
      scope: "rule",
    });
    expect(refusedRule.type).toEqual("error");

    for (const requestId of ["req_pinned", "req_wild"]) {
      await sendBrokerRequest(socketPath, {
        type: "deny",
        requestId,
        scope: "once",
      });
    }
    expect((await waiting).decision).toEqual("deny");
    expect((await wildWaiting).decision).toEqual("deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: approving for the life of the rule answers its later requests", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grain-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_grain_rule",
    document: GRANULARITY_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_grain_rule/sock`;
  await broker.start(socketPath);
  try {
    const waiting = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize(
        "sess_grain_rule",
        "req_first",
        "api.example.com",
        443,
        "pinned.ask",
      ),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_first",
      scope: "rule",
    });
    expect((await waiting).decision).toEqual("allow");

    const later = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize(
        "sess_grain_rule",
        "req_later",
        "api.example.com",
        443,
        "pinned.ask",
      ),
    );
    expect(later.decision).toEqual("allow");
    expect(later.reason).toEqual("approved");
    expect(later.ruleId).toEqual("pinned.ask");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: an approval for an inspected body does not release an uninspectable one", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grain-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_reason",
    document: resolvedDocument({
      network: {
        scopes: {
          api: {
            targets: ["api.example.com:443"],
            rules: {
              messages: {
                match: { paths: ["/v1/messages"], body: { format: "json" } },
                onMatch: "review",
                onIndeterminate: "review",
                expect: [{ kind: "jsonRoot", rootType: "object" }],
              },
            },
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_reason/sock`;
  await broker.start(socketPath);
  try {
    const parseable = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...post("sess_reason", "req_json", "/v1/messages"),
      reviewContext: {
        path: "/v1/messages",
        contentType: "application/json",
        bodySize: 2,
      },
      bodyTruth: { "api.messages": "true" },
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_json",
      scope: "rule",
    });
    expect((await parseable).decision).toEqual("allow");

    // The table omits the candidate. A missing leaf is indeterminate rather
    // than false, so the approval just granted for a matched rule does not
    // answer for it and a broader rule cannot silently take over.
    const broken = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...post("sess_reason", "req_broken", "/v1/messages"),
      reviewContext: {
        path: "/v1/messages",
        contentType: "application/json",
        bodySize: 7,
      },
      bodyTruth: {},
    });
    const answeredFromCache = await Promise.race([
      broken,
      waitForPending(socketPath).then(() => null),
    ]);
    expect(answeredFromCache).toBeNull();

    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_broken",
      scope: "once",
    });
    expect((await broken).decision).toEqual("deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: an approval that names no granularity is not remembered", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grain-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_grain_default",
    document: GRANULARITY_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_grain_default/sock`;
  await broker.start(socketPath);
  try {
    const waiting = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize(
        "sess_grain_default",
        "req_first",
        "sub.example.org",
        443,
        "wild.ask",
      ),
    );
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_first",
    });
    expect((await waiting).decision).toEqual("allow");

    // Nobody said how far that approval reached, so the next request of the
    // same rule against the same target asks again.
    const later = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize(
        "sess_grain_default",
        "req_later",
        "sub.example.org",
        443,
        "wild.ask",
      ),
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items.map((item) => item.requestId)).toEqual(["req_later"]);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_later",
      scope: "once",
    });
    expect((await later).decision).toEqual("deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: close resolves pending request", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  const authorizePromise = sendBrokerRequest<DecisionResponse>(
    socketPath,
    authorize("sess_test", "req_close2", "api.openai.com", 443),
  );
  await waitForPending(socketPath);
  await broker.close();
  const decision = await authorizePromise;
  expect(decision.decision).toEqual("deny");
  expect(decision.reason).toEqual("broker closed");
  await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
});

test("SessionBroker: a POST rule sends to pending while the scope fallback allows GET", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: POST_REVIEW_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // POST に一致するルールが引き受けるので pending に回る。
    const authorizePromise = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_test", "req_review_1", "api.openai.com", 443),
      method: "POST",
      bodyTruth: { "openai.post": "true" },
      reviewContext: {
        path: "/v1/chat/completions",
        contentType: "application/json",
        bodySize: 18,
      },
    });
    const pending = await waitForPending(socketPath);
    expect(pending.items.length).toEqual(1);
    expect(pending.items[0].reviewContext).toBeDefined();
    expect("bodyTruth" in pending.items[0]).toBe(false);
    expect(pending.items[0].reviewContext!.path).toEqual(
      "/v1/chat/completions",
    );

    // Approve to unblock
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_review_1",
      scope: "once",
    });
    const decision = await authorizePromise;
    expect(decision.decision).toEqual("allow");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a GET the POST rule declines falls to the scope fallback", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: POST_REVIEW_DOCUMENT,
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // メソッドが合わないのでルールは辞退し、スコープの fallback が拾う。
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_get", "api.openai.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("scope-fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a target outside every scope falls to the network fallback", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      allowed: { targets: ["allowed.com"], fallback: "allow" },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_no_match", "other.com", 443),
    );
    expect(response.decision).toEqual("deny");
    expect(response.reason).toEqual("network-fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

function post(
  sessionId: string,
  requestId: string,
  requestPath: string,
  host = "api.example.com",
  port = 443,
  ruleId?: string,
): AuthorizeRequest {
  return {
    ...authorize(sessionId, requestId, host, port),
    method: "POST",
    requestKind: "forward",
    bodyTruth: ruleId ? { [ruleId]: "true" } : {},
    reviewContext: {
      path: requestPath,
      contentType: null,
      bodySize: 0,
    },
  };
}

async function waitForPending(
  socketPath: string,
  minCount = 1,
): Promise<{ type: "pending"; items: PendingEntry[] }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pending = await sendBrokerRequest<{
      type: "pending";
      items: PendingEntry[];
    }>(socketPath, { type: "list_pending" });
    if (pending.items.length >= minCount) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for pending broker entry");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const exists = await stat(path)
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Timed out waiting for result in ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

test("SessionBroker: allow decision includes injectHeaders for matching credentials", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cred",
    document: resolvedDocument({
      secrets: { "gh-token": { from: "env:GH" } },
      network: {
        scopes: {
          github: {
            targets: ["github.com"],
            fallback: "allow",
            secrets: { "gh-token": "inject" },
            inject: [{ name: "Authorization", value: "secret:gh-token" }],
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    auditDir,
    secretValues: { "gh-token": ["token ghp_test123"] },
  });
  const socketPath = `${paths.brokersDir}/sess_cred/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_cred", "req_cred_1", "github.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.injectHeaders).toEqual([
      { name: "Authorization", value: "token ghp_test123" },
    ]);

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].injectedHeaders).toEqual(["Authorization"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny decision does not include injectHeaders", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cred",
    document: resolvedDocument({
      secrets: { "gh-token": { from: "env:GH" } },
      network: {
        scopes: {
          github: {
            targets: ["github.com"],
            fallback: "deny",
            secrets: { "gh-token": "inject" },
            inject: [{ name: "Authorization", value: "secret:gh-token" }],
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { "gh-token": ["token ghp_test123"] },
  });
  const socketPath = `${paths.brokersDir}/sess_cred/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_cred", "req_cred_deny", "github.com", 443),
    );
    expect(response.decision).toEqual("deny");
    expect(response.injectHeaders).toBeUndefined();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: allow decision includes maskValues", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      example: { targets: ["example.com"], fallback: "allow" },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { workspace: ["s3cret-value"] },
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_mask1", "example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.maskValues).toEqual(["s3cret-value"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: deny decision does not include maskValues", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      example: { targets: ["example.com"], fallback: "deny" },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { workspace: ["s3cret-value"] },
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_mask2", "example.com", 443),
    );
    expect(response.decision).toEqual("deny");
    expect(response.maskValues).toBeUndefined();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: pending entry reviewContext is masked", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({}, "review"),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { workspace: ["s3cret-value"] },
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const message = {
      ...authorize("sess_test", "req_mask3", "api.example.com", 443),
      reviewContext: {
        path: "/upload?token=s3cret-value",
        contentType: "application/x-www-form-urlencoded",
        bodySize: 17,
      },
    };
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      message,
    );
    const pending = await waitForPending(socketPath);
    expect(pending.items.length).toEqual(1);
    expect(pending.items[0].reviewContext?.path).toEqual("/upload?token=****");
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_mask3",
      scope: "host-port",
    });
    const decision = await authorizePromise;
    expect(decision.decision).toEqual("allow");
    expect(decision.maskValues).toEqual(["s3cret-value"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a rule's path matches the unmasked path even when it holds a secret", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        fallback: "deny",
        rules: {
          account: {
            match: { paths: ["/accounts/s3cret-value/**"] },
            onMatch: "allow",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { workspace: ["s3cret-value"] },
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_test", "req_pathprefix_mask", "api.example.com", 443),
      bodyTruth: { "api.account": "true" },
      reviewContext: {
        path: "/accounts/s3cret-value/info",
        contentType: null,
        bodySize: 0,
      },
    });
    expect(response.decision).toEqual("allow");
    expect(response.ruleId).toEqual("api.account");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: an inject rule matches the unmasked path even when it holds a secret", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cred_mask",
    document: resolvedDocument({
      secrets: {
        workspace: { from: "env:WORKSPACE" },
        "api-token": { from: "env:API" },
      },
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            fallback: "allow",
            secrets: { "api-token": "inject" },
            rules: {
              account: {
                match: { paths: ["/accounts/s3cret-value/**"] },
                onMatch: "allow",
                inject: [{ name: "Authorization", value: "secret:api-token" }],
              },
            },
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: {
      workspace: ["s3cret-value"],
      "api-token": ["token ghp_test123"],
    },
  });
  const socketPath = `${paths.brokersDir}/sess_cred_mask/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cred_mask",
        "req_cred_pathprefix_mask",
        "api.example.com",
        443,
      ),
      bodyTruth: { "api.account": "true" },
      reviewContext: {
        path: "/accounts/s3cret-value/info",
        contentType: null,
        bodySize: 0,
      },
    });
    expect(response.decision).toEqual("allow");
    expect(response.injectHeaders).toEqual([
      { name: "Authorization", value: "token ghp_test123" },
    ]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a scope may inject more than one header", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_multi",
    document: resolvedDocument({
      secrets: {
        bearer: { from: "env:BEARER" },
        "api-key": { from: "env:KEY" },
      },
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            fallback: "allow",
            secrets: { bearer: "inject", "api-key": "inject" },
            inject: [
              // biome-ignore lint/suspicious/noTemplateCurlyInString: `template:` の参照構文であってテンプレートリテラルではない
              { name: "Authorization", value: "template:Bearer ${bearer}" },
              { name: "X-API-Key", value: "secret:api-key" },
            ],
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { bearer: ["tok"], "api-key": ["key123"] },
  });
  const socketPath = `${paths.brokersDir}/sess_multi/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_multi", "req_multi", "api.example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.injectHeaders).toEqual([
      { name: "Authorization", value: "Bearer tok" },
      { name: "X-API-Key", value: "key123" },
    ]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: approval cache cannot override an explicit deny", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-cache-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cache_deny",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        rules: {
          "deny-post": {
            match: { methods: ["POST"], paths: ["/**"] },
            onMatch: "deny",
          },
          "review-get": {
            match: { methods: ["GET"], paths: ["/**"] },
            onMatch: "review",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_cache_deny/sock`;
  await broker.start(socketPath);
  try {
    const pendingDecision = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_deny",
        "req_cache_approve",
        "api.example.com",
        443,
      ),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_cache_approve",
      scope: "host",
    });
    await pendingDecision;

    const denied = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_deny",
        "req_explicit_deny",
        "api.example.com",
        443,
      ),
      method: "POST",
      bodyTruth: { "api.deny-post": "true" },
    });
    expect(denied.decision).toEqual("deny");
    expect(denied.reason).toEqual("rule");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: denial cache cannot override an explicit allow", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-cache-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cache_allow",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        rules: {
          "allow-post": {
            match: { methods: ["POST"], paths: ["/**"] },
            onMatch: "allow",
          },
          "review-get": {
            match: { methods: ["GET"], paths: ["/**"] },
            onMatch: "review",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_cache_allow/sock`;
  await broker.start(socketPath);
  try {
    const pendingDecision = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_allow",
        "req_cache_deny",
        "api.example.com",
        443,
      ),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_cache_deny",
      scope: "host",
    });
    await pendingDecision;

    const allowed = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_allow",
        "req_explicit_allow",
        "api.example.com",
        443,
      ),
      method: "POST",
      bodyTruth: { "api.allow-post": "true" },
    });
    expect(allowed.decision).toEqual("allow");
    expect(allowed.ruleId).toEqual("api.allow-post");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a host-wide approval spans ports but not other rules", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-cache-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cache_review",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        rules: {
          "review-get": {
            match: { methods: ["GET"], paths: ["/**"] },
            onMatch: "review",
          },
          "review-post": {
            match: { methods: ["POST"], paths: ["/**"] },
            onMatch: "review",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_cache_review/sock`;
  await broker.start(socketPath);
  try {
    const pendingDecision = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_review",
        "req_cache_first",
        "api.example.com",
        443,
      ),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_cache_first",
      scope: "host",
    });
    expect((await pendingDecision).ruleId).toEqual("api.review-get");

    const cached = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_review",
        "req_cache_second",
        "api.example.com",
        8443,
      ),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    expect(cached.decision).toEqual("allow");
    expect(cached.reason).toEqual("approved");
    expect(cached.ruleId).toEqual("api.review-get");

    const noMatch = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_review",
        "req_cache_no_match",
        "api.example.com",
        443,
      ),
      method: "DELETE",
    });
    expect(noMatch.decision).toEqual("deny");
    expect(noMatch.reason).toEqual("scope-fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a pending entry names the headers approval would inject", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-inject-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_inject_preview",
    document: resolvedDocument({
      secrets: { "gh-token": { from: "env:GH" } },
      network: {
        scopes: {
          github: {
            targets: ["api.github.com:443"],
            secrets: { "gh-token": "inject" },
            inject: [{ name: "X-Scope", value: "literal:plain" }],
            rules: {
              write: {
                match: { methods: ["POST"], paths: ["/graphql"] },
                onMatch: "review",
                inject: [
                  {
                    name: "Authorization",
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: `template:` の参照構文であってテンプレートリテラルではない
                    value: "template:Bearer ${gh-token}",
                  },
                ],
              },
            },
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    secretValues: { "gh-token": ["ghp_realtokenvalue"] },
  });
  const socketPath = `${paths.brokersDir}/sess_inject_preview/sock`;
  await broker.start(socketPath);
  try {
    const waiting = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_inject_preview",
        "req_gql",
        "/graphql",
        "api.github.com",
        443,
        "github.write",
      ),
    );
    const pending = await waitForPending(socketPath);
    const entry = pending.items[0];

    // Approving hands a credential to that host. The person pressing the
    // button has to be able to see that, by header and by secret name.
    expect(entry?.injectHeaders).toEqual([
      { name: "X-Scope", secrets: [] },
      { name: "Authorization", secrets: ["gh-token"] },
    ]);
    // The name is the whole of it. Nothing that reaches a screen or the
    // pending file on disk may carry the value.
    expect(JSON.stringify(entry)).not.toContain("ghp_realtokenvalue");

    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_gql",
      scope: "once",
    });
    // What was shown is what goes out: the same headers, now with values.
    expect((await waiting).injectHeaders).toEqual([
      { name: "X-Scope", value: "plain" },
      { name: "Authorization", value: "Bearer ghp_realtokenvalue" },
    ]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: an approval covers only the rule that raised it", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-identity-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_identity",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        rules: {
          "review-get": {
            match: { methods: ["GET"], paths: ["/**"] },
            onMatch: "review",
          },
          "review-post": {
            match: { methods: ["POST"], paths: ["/**"] },
            onMatch: "review",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_identity/sock`;
  await broker.start(socketPath);
  try {
    const approved = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_identity", "req_get", "api.example.com", 443),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_get",
      scope: "host",
    });
    expect((await approved).ruleId).toEqual("api.review-get");

    // The same rule against the same target is what was approved, so a
    // second GET goes straight through.
    const sameRule = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_identity", "req_get_again", "api.example.com", 443),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    expect(sameRule.decision).toEqual("allow");
    expect(sameRule.reason).toEqual("approved");

    // A POST is a different rule. Nobody approved it, so it has to wait for
    // a human even though the host is the one that was approved.
    const otherRule = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_identity", "req_post", "api.example.com", 443),
      method: "POST",
      bodyTruth: { "api.review-post": "true" },
    });
    const pending = await waitForPending(socketPath);
    expect(pending.items.map((item) => item.requestId)).toEqual(["req_post"]);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_post",
      scope: "once",
    });
    expect((await otherRule).decision).toEqual("deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: a denial covers only the rule that raised it", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-identity-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_deny_identity",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        rules: {
          "review-get": {
            match: { methods: ["GET"], paths: ["/**"] },
            onMatch: "review",
          },
          "review-post": {
            match: { methods: ["POST"], paths: ["/**"] },
            onMatch: "review",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_deny_identity/sock`;
  await broker.start(socketPath);
  try {
    const denied = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_deny_identity", "req_get", "api.example.com", 443),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_get",
      scope: "host",
    });
    expect((await denied).decision).toEqual("deny");

    const sameRule = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_deny_identity",
        "req_get_again",
        "api.example.com",
        443,
      ),
      method: "GET",
      bodyTruth: { "api.review-get": "true" },
    });
    expect(sameRule.decision).toEqual("deny");
    expect(sameRule.reason).toEqual("denied-by-user");

    // The POST rule was never shown to anyone, so the denial of the GET rule
    // must not answer for it.
    const otherRule = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_deny_identity", "req_post", "api.example.com", 443),
      method: "POST",
      bodyTruth: { "api.review-post": "true" },
    });
    const pending = await waitForPending(socketPath);
    expect(pending.items.map((item) => item.requestId)).toEqual(["req_post"]);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_post",
      scope: "once",
    });
    expect((await otherRule).decision).toEqual("deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: one decision resolves only the requests of its own rule", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-groups-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_groups",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        rules: {
          "path-a": {
            match: { methods: ["POST"], paths: ["/path-a"] },
            onMatch: "review",
          },
          "path-b": {
            match: { methods: ["POST"], paths: ["/path-b"] },
            onMatch: "review",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_groups/sock`;
  await broker.start(socketPath);
  try {
    const pathA = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_groups",
        "req_a",
        "/path-a",
        "api.example.com",
        443,
        "api.path-a",
      ),
    );
    const pathB = sendBrokerRequest<DecisionResponse>(
      socketPath,
      post(
        "sess_groups",
        "req_b",
        "/path-b",
        "api.example.com",
        443,
        "api.path-b",
      ),
    );
    await waitForPending(socketPath, 2);

    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_a",
      scope: "once",
    });
    expect(await pathA).toMatchObject({
      decision: "allow",
      ruleId: "api.path-a",
    });

    // /path-b belongs to another rule, so it is still waiting.
    const stillPending = await waitForPending(socketPath);
    expect(stillPending.items.map((item) => item.requestId)).toEqual(["req_b"]);
    await sendBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_b",
      scope: "once",
    });
    expect(await pathB).toMatchObject({
      decision: "deny",
      reason: "denied-by-user",
    });
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: allow carries the rule ID, and a fallback carries the pseudo ID", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-rule-id-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_rule_id",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        fallback: "allow",
        rules: {
          "policy-get": {
            match: { methods: ["GET"], paths: ["/**"] },
            onMatch: "allow",
            expect: [{ kind: "emptyBody" }],
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_rule_id/sock`;
  await broker.start(socketPath);
  try {
    const policy = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_rule_id", "req_policy_id", "api.example.com", 443),
      method: "GET",
      bodyTruth: { "api.policy-get": "true" },
    });
    expect(policy.ruleId).toEqual("api.policy-get");

    // どのルールも引き受けなかったリクエストは、承認の同一性のために
    // スコープの擬似 ID を持つ。ID が無いルールという概念は無くなった。
    const ordinary = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_rule_id", "req_no_id", "api.example.com", 443),
      method: "POST",
    });
    expect(ordinary.ruleId).toEqual("api.$fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: exact path accepts a query and rejects normalized or encoded lookalikes", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-path-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_exact_path",
    document: documentWithScopes({
      api: {
        targets: ["api.example.com"],
        rules: {
          exact: {
            match: { methods: ["POST"], paths: ["/v1/messages"] },
            onMatch: "allow",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_exact_path/sock`;
  await broker.start(socketPath);
  try {
    for (const [requestId, requestPath, decision] of [
      ["query", "/v1/messages?beta=true", "allow"],
      ["dot", "/v1/./messages", "deny"],
      ["encoded", "/v1/%6dessages", "deny"],
    ] as const) {
      const response = await sendBrokerRequest<DecisionResponse>(socketPath, {
        ...authorize(
          "sess_exact_path",
          `req_exact_${requestId}`,
          "api.example.com",
          443,
        ),
        method: "POST",
        bodyTruth:
          requestId === "query" ? { "api.exact": "true" as const } : {},
        reviewContext: {
          path: requestPath,
          contentType: null,
          bodySize: 0,
        },
      });
      expect(response.decision).toEqual(decision);
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
