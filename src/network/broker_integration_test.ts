import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sendBrokerRequest, SessionBroker } from "./broker.ts";
import type {
  AuthorizeRequest,
  DecisionResponse,
  PendingEntry,
} from "./protocol.ts";
import { resolveNetworkRuntimePaths } from "./registry.ts";
import { queryAuditLogs } from "../audit/store.ts";
import { _resetNotifySendCache } from "../lib/notify_utils.ts";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("SessionBroker: allowlist hit returns allow immediately", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    allowlist: ["example.com"],
    denylist: [],
    promptEnabled: false,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_1", "example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("allowlist");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("allow");
    expect(logs[0].reason).toEqual("allowlist");
    expect(logs[0].target).toEqual("example.com:443");
    expect(logs[0].requestId).toEqual("req_1");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: pending request resumes after approve", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    allowlist: [],
    denylist: [],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
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

test("SessionBroker: close resolves pending request after aborting notifications", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const notifyDir = await mkdtemp(path.join(tmpdir(), "nas-broker-notify-"));
  const notifyStartFile = `${notifyDir}/notify-started`;
  const notifyExitFile = `${notifyDir}/notify-exited`;
  const originalPath = process.env["PATH"] ?? "";
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
    process.env["PATH"] = `${notifyDir}:${originalPath}`;
    _resetNotifySendCache();

    const broker = new SessionBroker({
      paths,
      sessionId: "sess_test",
      allowlist: [],
      denylist: [],
      promptEnabled: true,
      timeoutSeconds: 30,
      defaultScope: "host-port",
      notify: "desktop",
      uiPort: healthServer.port,
    });
    const socketPath = `${paths.brokersDir}/sess_test.sock`;
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
    process.env["PATH"] = originalPath;
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

test("SessionBroker: denylist hit returns deny immediately", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-broker-audit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    allowlist: [],
    denylist: ["evil.com"],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
    auditDir,
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny", "evil.com", 443),
    );
    expect(response.decision).toEqual("deny");
    expect(response.reason).toEqual("denylist");

    const logs = await queryAuditLogs({ domain: "network" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("denylist");
    expect(logs[0].target).toEqual("evil.com:443");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: allowlist=*.example.com allows sub.example.com even if denylist=sub.example.com", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    allowlist: ["*.example.com"],
    denylist: ["sub.example.com"],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_wild_allow", "sub.example.com", 443),
    );
    expect(response.decision).toEqual("allow");
    expect(response.reason).toEqual("allowlist");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SessionBroker: allowlist=sub.example.com, denylist=*.example.com denies other.example.com", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_test",
    allowlist: ["sub.example.com"],
    denylist: ["*.example.com"],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
  await broker.start(socketPath);
  try {
    // sub.example.com is in allowlist → allow
    const allowResponse = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_allow_sub", "sub.example.com", 443),
    );
    expect(allowResponse.decision).toEqual("allow");
    expect(allowResponse.reason).toEqual("allowlist");

    // other.example.com matches denylist *.example.com → deny
    const denyResponse = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny_other", "other.example.com", 443),
    );
    expect(denyResponse.decision).toEqual("deny");
    expect(denyResponse.reason).toEqual("denylist");
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
    allowlist: [],
    denylist: [],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
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
    allowlist: [],
    denylist: [],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
    negativeCacheTtlMs: 50,
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
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
    allowlist: [],
    denylist: [],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
    negativeCacheTtlMs: 50,
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
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
    allowlist: [],
    denylist: [],
    promptEnabled: true,
    timeoutSeconds: 30,
    defaultScope: "host-port",
    notify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
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

test("SessionBroker: deny-by-default targets blocked even when in allowlist", async () => {
  // Regression: allowlist used to be checked before denyReasonForTarget,
  // allowing private/loopback addresses to bypass the deny-by-default rule.
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
    // Put the deny-by-default host directly in the allowlist.
    const broker = new SessionBroker({
      paths,
      sessionId: "sess_test",
      allowlist: [host],
      denylist: [],
      promptEnabled: true,
      timeoutSeconds: 30,
      defaultScope: "host-port",
      notify: "off",
    });
    const socketPath = `${paths.brokersDir}/sess_test.sock`;
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
