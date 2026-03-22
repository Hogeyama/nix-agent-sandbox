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
