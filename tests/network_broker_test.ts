import { assertEquals } from "@std/assert";
import { sendBrokerRequest, SessionBroker } from "../src/network/broker.ts";
import type {
  AuthorizeRequest,
  DecisionResponse,
  PendingEntry,
} from "../src/network/protocol.ts";
import { resolveNetworkRuntimePaths } from "../src/network/registry.ts";

Deno.test("SessionBroker: allowlist hit returns allow immediately", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
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
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_1", "example.com", 443),
    );
    assertEquals(response.decision, "allow");
    assertEquals(response.reason, "allowlist");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SessionBroker: pending request resumes after approve", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
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
    const authorizePromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_approve", "api.openai.com", 443),
    );
    const pending = await waitForPending(socketPath);
    assertEquals(pending.items.length, 1);
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_approve",
      scope: "host-port",
    });
    const decision = await authorizePromise;
    assertEquals(decision.decision, "allow");
    assertEquals(decision.scope, "host-port");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SessionBroker: close resolves pending request after aborting notifications", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
  const notifyDir = await Deno.makeTempDir({ prefix: "nas-broker-notify-" });
  const notifyStartFile = `${notifyDir}/notify-started`;
  const notifyExitFile = `${notifyDir}/notify-exited`;
  const originalPath = Deno.env.get("PATH") ?? "";
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const healthServer = Deno.serve({ port: 0, onListen() {} }, (req) => {
    if (new URL(req.url).pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  });
  try {
    await Deno.writeTextFile(
      `${notifyDir}/notify-send`,
      `#!/usr/bin/env bash
set -eu
echo started > "${notifyStartFile}"
trap 'echo exited > "${notifyExitFile}"; exit 143' TERM
while true; do sleep 0.05; done
`,
    );
    await Deno.writeTextFile(
      `${notifyDir}/xdg-open`,
      `#!/usr/bin/env bash
true
`,
    );
    await Deno.chmod(`${notifyDir}/notify-send`, 0o755);
    await Deno.chmod(`${notifyDir}/xdg-open`, 0o755);
    Deno.env.set("PATH", `${notifyDir}:${originalPath}`);

    const broker = new SessionBroker({
      paths,
      sessionId: "sess_test",
      allowlist: [],
      denylist: [],
      promptEnabled: true,
      timeoutSeconds: 30,
      defaultScope: "host-port",
      notify: "desktop",
      uiPort: healthServer.addr.port,
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
      assertEquals(decision.decision, "deny");
      assertEquals(decision.reason, "broker closed");
      await waitForFile(notifyExitFile);
    } finally {
      await broker.close().catch(() => {});
    }
  } finally {
    Deno.env.set("PATH", originalPath);
    await healthServer.shutdown();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(notifyDir, { recursive: true }).catch(() => {});
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

Deno.test("SessionBroker: denylist hit returns deny immediately", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
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
  });
  const socketPath = `${paths.brokersDir}/sess_test.sock`;
  await broker.start(socketPath);
  try {
    const response = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny", "evil.com", 443),
    );
    assertEquals(response.decision, "deny");
    assertEquals(response.reason, "denylist");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SessionBroker: allowlist=*.example.com allows sub.example.com even if denylist=sub.example.com", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
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
    assertEquals(response.decision, "allow");
    assertEquals(response.reason, "allowlist");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SessionBroker: allowlist=sub.example.com, denylist=*.example.com denies other.example.com", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
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
    assertEquals(allowResponse.decision, "allow");
    assertEquals(allowResponse.reason, "allowlist");

    // other.example.com matches denylist *.example.com → deny
    const denyResponse = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny_other", "other.example.com", 443),
    );
    assertEquals(denyResponse.decision, "deny");
    assertEquals(denyResponse.reason, "denylist");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SessionBroker: denied target is cached as recent-deny", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
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
    assertEquals(firstDecision.decision, "deny");
    assertEquals(firstDecision.reason, "denied-by-user");

    // Second request to the same target should be immediately denied
    const secondDecision = await sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_deny_cache_2", "cached.example.com", 443),
    );
    assertEquals(secondDecision.decision, "deny");
    assertEquals(secondDecision.reason, "recent-deny");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SessionBroker: negative cache expires after TTL", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-broker-" });
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
    assertEquals(cachedDecision.decision, "deny");
    assertEquals(cachedDecision.reason, "recent-deny");

    // Wait for TTL to expire, then should go to prompt again
    await new Promise((resolve) => setTimeout(resolve, 100));

    const afterTtlPromise = sendBrokerRequest<DecisionResponse>(
      socketPath,
      authorize("sess_test", "req_ttl_3", "ttl.example.com", 443),
    );
    // If the cache expired, the request goes to prompt (pending)
    const pending = await waitForPending(socketPath);
    assertEquals(pending.items.length, 1);

    // Clean up: approve to resolve the pending request
    await sendBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_ttl_3",
    });
    const decision = await afterTtlPromise;
    assertEquals(decision.decision, "allow");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

async function waitForPending(
  socketPath: string,
): Promise<{ type: "pending"; items: PendingEntry[] }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pending = await sendBrokerRequest<
      { type: "pending"; items: PendingEntry[] }
    >(
      socketPath,
      { type: "list_pending" },
    );
    if (pending.items.length > 0) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for pending broker entry");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const exists = await Deno.stat(path).then(() => true).catch(() => false);
    if (exists) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}
