import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { queryAuditLogs } from "../audit/store.ts";
import { _resetNotifySendCache } from "../lib/notify_utils.ts";
import { SessionBroker, sendBrokerRequest } from "./broker.ts";
import type {
  AuthorizeRequest,
  DecisionResponse,
  PendingEntry,
  RequestPolicyOutcomeRequest,
  RequestPolicyOutcomeResponse,
} from "./protocol.ts";
import { resolveNetworkRuntimePaths } from "./registry.ts";

test("SessionBroker: allow rule returns allow immediately", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ host: "example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    expect(response.reason).toEqual("review-rule");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("allow");
    expect(logs[0].reason).toEqual("review-rule");
    expect(logs[0].phase).toEqual("authorization");
    expect(logs[0].target).toEqual("example.com:443");
    expect(logs[0].requestId).toEqual("req_1");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

const JSON_REQUEST_POLICY = {
  kind: "json" as const,
  maxBodyBytes: 1024,
  maxDepth: 8,
  maxNodes: 100,
  maxDecodedBytes: 1024,
  taggedUnions: [],
  encodedFields: [],
};
const OUTCOME_RULES = [
  {
    id: "policy.bodyless",
    method: "GET",
    path: "/health",
    action: "allow" as const,
    requestPolicy: { kind: "bodyless" as const },
  },
  {
    id: "policy.json",
    method: "POST",
    path: "/v1/messages",
    action: "allow" as const,
    requestPolicy: JSON_REQUEST_POLICY,
  },
  { id: "ordinary", action: "allow" as const },
  { action: "allow" as const },
];

test("SessionBroker: request policy outcome rejects the closed invalid matrix without auditing", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    reviewRules: OUTCOME_RULES,
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
      ["non-policy rule ID", { ruleId: "ordinary" }],
      ["unknown result", { result: "allow" }],
      ["unknown reason", { reason: "raw-secret-reason" }],
      [
        "bodyless/JSON mismatch",
        {
          ruleId: "policy.bodyless",
          result: "pass",
          reason: "recognized-json",
        },
      ],
      [
        "JSON/bodyless mismatch",
        { ruleId: "policy.json", result: "pass", reason: "empty-body" },
      ],
      [
        "invalid rewrite",
        {
          ruleId: "policy.bodyless",
          result: "rewrite",
          reason: "masked-json",
        },
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
    reviewRules: OUTCOME_RULES,
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
        method: "GET",
        route: "/health",
        kind: "bodyless",
      },
      {
        requestId: "req-json-rewrite",
        ruleId: "policy.json",
        result: "rewrite",
        reason: "masked-json",
        decision: "allow",
        method: "POST",
        route: "/v1/messages",
        kind: "json",
      },
      {
        requestId: "req-json-block",
        ruleId: "policy.json",
        result: "block",
        reason: "invalid-json",
        decision: "deny",
        method: "POST",
        route: "/v1/messages",
        kind: "json",
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
        method: outcome.method,
        route: outcome.route,
        requestPolicyKind: outcome.kind,
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

test("SessionBroker: request policy outcome is acknowledged without an audit directory", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-policy-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_policy",
    reviewRules: OUTCOME_RULES,
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    reviewRules: OUTCOME_RULES.map((rule) =>
      rule.id === "policy.json" ? { ...rule, audit: false } : rule,
    ),
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    reviewRules: OUTCOME_RULES.map((rule) =>
      rule.id === "policy.json" ? { ...rule, audit: false } : rule,
    ),
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    reviewRules: OUTCOME_RULES,
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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

test("SessionBroker: grouped pending waiters retain rule ID credentials and audit behavior", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-grouped-"));
  const auditDir = await mkdtemp(
    path.join(tmpdir(), "nas-broker-grouped-audit-"),
  );
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_grouped",
    reviewRules: [
      {
        id: "review.path-a",
        method: "POST",
        path: "/path-a",
        action: "review",
        audit: true,
      },
      {
        id: "review.path-b",
        method: "POST",
        path: "/path-b",
        action: "review",
        audit: false,
      },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "once",
    pendingNotify: "off",
    auditDir,
    resolvedCredentials: [
      {
        host: "api.example.com",
        pathPrefix: "/path-a",
        header: "X-Path-A",
        value: "credential-a",
      },
      {
        host: "api.example.com",
        pathPrefix: "/path-b",
        header: "X-Path-B",
        value: "credential-b",
      },
    ],
  });
  const socketPath = `${paths.brokersDir}/sess_grouped/sock`;
  await broker.start(socketPath);
  try {
    const pathA = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_grouped", "req_grouped_a", "api.example.com", 443),
      method: "POST",
      reviewContext: {
        path: "/path-a",
        contentType: null,
        bodyPreview: null,
        bodySize: 0,
      },
    });
    const pathB = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_grouped", "req_grouped_b", "api.example.com", 443),
      method: "POST",
      reviewContext: {
        path: "/path-b",
        contentType: null,
        bodyPreview: null,
        bodySize: 0,
      },
    });

    const pending = await waitForPending(socketPath, 2);
    expect(pending.items.map((item) => item.requestId).sort()).toEqual([
      "req_grouped_a",
      "req_grouped_b",
    ]);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_grouped_a",
      scope: "once",
    });

    expect(await pathA).toMatchObject({
      decision: "allow",
      ruleId: "review.path-a",
      injectHeaders: [{ name: "X-Path-A", value: "credential-a" }],
    });
    expect(await pathB).toMatchObject({
      decision: "allow",
      ruleId: "review.path-b",
      injectHeaders: [{ name: "X-Path-B", value: "credential-b" }],
    });

    const authorizationLogs = (
      await queryAuditLogs({ domain: "network" }, auditDir)
    ).filter((entry) => entry.phase === "authorization");
    expect(authorizationLogs).toHaveLength(1);
    expect(authorizationLogs[0].requestId).toEqual("req_grouped_a");
    expect(authorizationLogs[0].injectedHeaders).toEqual(["X-Path-A"]);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
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
      reviewRules: [{ action: "review" }],
      pendingTimeoutSeconds: 30,
      pendingDefaultScope: "host-port",
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
): AuthorizeRequest {
  return {
    version: 1,
    type: "authorize",
    requestId,
    sessionId,
    target: { host, port },
    method: "CONNECT",
    requestKind: "connect",
    observedAt: new Date().toISOString(),
  };
}

test("SessionBroker: deny rule returns deny immediately", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ host: "evil.com", action: "deny" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    expect(response.reason).toEqual("review-rule");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("review-rule");
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
    reviewRules: [{ host: "*.example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    expect(response.reason).toEqual("review-rule");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: first-match: sub.example.com allow wins over *.example.com deny for other.example.com", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [
      { host: "sub.example.com", action: "allow" },
      { host: "*.example.com", action: "deny" },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // sub.example.com matches first rule → allow
    const allowResponse = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_allow_sub", "sub.example.com", 443),
    );
    expect(allowResponse.decision).toEqual("allow");
    expect(allowResponse.reason).toEqual("review-rule");

    // other.example.com skips first rule, matches second → deny
    const denyResponse = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny_other", "other.example.com", 443),
    );
    expect(denyResponse.decision).toEqual("deny");
    expect(denyResponse.reason).toEqual("review-rule");
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
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
      reviewRules: [{ host: host, action: "allow" }],
      pendingTimeoutSeconds: 30,
      pendingDefaultScope: "host-port",
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
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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

test("SessionBroker: close resolves pending request", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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

test("SessionBroker: review rule on POST sends to pending, allow rule handles GET", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [
      { method: "POST", host: "*.openai.com", action: "review" },
      { host: "api.openai.com", action: "allow" },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // POST to api.openai.com: first rule matches (POST + *.openai.com) → pending
    const authorizePromise = sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_test", "req_review_1", "api.openai.com", 443),
      method: "POST",
      reviewContext: {
        path: "/v1/chat/completions",
        contentType: "application/json",
        bodyPreview: '{"model":"gpt-4"}',
        bodySize: 18,
      },
    });
    const pending = await waitForPending(socketPath);
    expect(pending.items.length).toEqual(1);
    expect(pending.items[0].reviewContext).toBeDefined();
    expect(pending.items[0].reviewContext!.path).toEqual(
      "/v1/chat/completions",
    );
    expect(pending.items[0].reviewContext!.bodyPreview).toEqual(
      '{"model":"gpt-4"}',
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

test("SessionBroker: GET to host with review-POST rule falls through to allow rule", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [
      { method: "POST", host: "*.openai.com", action: "review" },
      { host: "api.openai.com", action: "allow" },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    // GET to api.openai.com: first rule skipped (method mismatch), second rule matches → allow
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_get", "api.openai.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("review-rule");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: no matching rule returns deny", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [{ host: "allowed.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
    expect(response.reason).toEqual("no-matching-rule");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

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
    reviewRules: [{ host: "github.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    auditDir,
    resolvedCredentials: [
      {
        host: "github.com",
        header: "Authorization",
        value: "token ghp_test123",
      },
    ],
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
    reviewRules: [{ host: "github.com", action: "deny" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    resolvedCredentials: [
      {
        host: "github.com",
        header: "Authorization",
        value: "token ghp_test123",
      },
    ],
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
    reviewRules: [{ host: "example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
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
    reviewRules: [{ host: "example.com", action: "deny" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
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
    reviewRules: [{ action: "review" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const message = {
      ...authorize("sess_test", "req_mask3", "api.example.com", 443),
      reviewContext: {
        path: "/upload?token=s3cret-value",
        contentType: "application/x-www-form-urlencoded",
        bodyPreview: "data=s3cret-value",
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
    expect(pending.items[0].reviewContext?.bodyPreview).toEqual("data=****");
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

test("SessionBroker: review-rule pathPrefix matches unmasked path even when it contains a mask secret", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    reviewRules: [
      {
        host: "api.example.com",
        pathPrefix: "/accounts/s3cret-value",
        action: "allow",
      },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
  });
  const socketPath = `${paths.brokersDir}/sess_test/sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_test", "req_pathprefix_mask", "api.example.com", 443),
      reviewContext: {
        path: "/accounts/s3cret-value/info",
        contentType: null,
        bodyPreview: null,
        bodySize: 0,
      },
    });
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("review-rule");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: credential pathPrefix matches unmasked path even when it contains a mask secret", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cred_mask",
    reviewRules: [{ host: "api.example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    maskValues: ["s3cret-value"],
    resolvedCredentials: [
      {
        host: "api.example.com",
        header: "Authorization",
        value: "token ghp_test123",
        pathPrefix: "/accounts/s3cret-value",
      },
    ],
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
      reviewContext: {
        path: "/accounts/s3cret-value/info",
        contentType: null,
        bodyPreview: null,
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

test("SessionBroker: all-match injects multiple credentials for same host", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_multi",
    reviewRules: [{ host: "api.example.com", action: "allow" }],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
    resolvedCredentials: [
      { host: "api.example.com", header: "Authorization", value: "Bearer tok" },
      { host: "api.example.com", header: "X-API-Key", value: "key123" },
    ],
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
    reviewRules: [
      { id: "deny-post", method: "POST", action: "deny" },
      { id: "review-get", method: "GET", action: "review" },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host",
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
    });
    expect(denied.decision).toEqual("deny");
    expect(denied.reason).toEqual("review-rule");
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
    reviewRules: [
      { id: "allow-post", method: "POST", action: "allow" },
      { id: "review-get", method: "GET", action: "review" },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host",
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
    });
    expect(allowed.decision).toEqual("allow");
    expect(allowed.reason).toEqual("review-rule");
    expect(allowed.ruleId).toEqual("allow-post");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: approval cache applies only to a matched review rule and returns its rule ID", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-cache-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_cache_review",
    reviewRules: [
      { id: "review-get", method: "GET", action: "review" },
      { id: "review-post", method: "POST", action: "review" },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host",
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
    });
    await waitForPending(socketPath);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_cache_first",
      scope: "host",
    });
    expect((await pendingDecision).ruleId).toEqual("review-get");

    const cached = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize(
        "sess_cache_review",
        "req_cache_second",
        "api.example.com",
        443,
      ),
      method: "POST",
    });
    expect(cached.decision).toEqual("allow");
    expect(cached.ruleId).toEqual("review-post");

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
    expect(noMatch.reason).toEqual("no-matching-rule");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: allow carries policy rule ID and ID-less allow omits rule ID", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-rule-id-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_rule_id",
    reviewRules: [
      {
        id: "policy-get",
        method: "GET",
        action: "allow",
        requestPolicy: { kind: "bodyless" },
      },
      { method: "POST", action: "allow" },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_rule_id/sock`;
  await broker.start(socketPath);
  try {
    const policy = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_rule_id", "req_policy_id", "api.example.com", 443),
      method: "GET",
    });
    expect(policy.ruleId).toEqual("policy-get");

    const ordinary = await sendBrokerRequest<DecisionResponse>(socketPath, {
      ...authorize("sess_rule_id", "req_no_id", "api.example.com", 443),
      method: "POST",
    });
    expect(ordinary.ruleId).toBeUndefined();
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
    reviewRules: [
      {
        id: "exact",
        method: "POST",
        path: "/v1/messages",
        action: "allow",
      },
    ],
    pendingTimeoutSeconds: 30,
    pendingDefaultScope: "host-port",
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
        reviewContext: {
          path: requestPath,
          contentType: null,
          bodyPreview: null,
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
