import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectUnix, readJsonLine } from "../lib/unix_socket.ts";
import { documentWithScopes } from "./authz/testing.ts";
import {
  BROKER_REQUEST_MAX_BYTES,
  parseBrokerMessage,
  SessionBroker,
  sendBrokerRequest,
} from "./broker.ts";
import { resolveNetworkRuntimePaths } from "./registry.ts";

test("parseBrokerMessage: accepts known message envelopes", () => {
  expect(parseBrokerMessage({ type: "list_pending" })).toEqual({
    type: "list_pending",
  });
  expect(
    parseBrokerMessage({ type: "approve", requestId: "r1", scope: "host" }),
  ).toEqual({ type: "approve", requestId: "r1", scope: "host" });
  expect(parseBrokerMessage({ type: "deny", requestId: "r1" })).toEqual({
    type: "deny",
    requestId: "r1",
  });
  // The payload of authorize-like messages is checked by their own
  // validators after dispatch; the envelope only needs a known type.
  expect(parseBrokerMessage({ type: "authorize" })).not.toBeNull();
});

test("parseBrokerMessage: rejects malformed or unknown messages", () => {
  for (const value of [
    null,
    42,
    "list_pending",
    [],
    {},
    { type: 1 },
    { type: "shutdown" },
    { type: "approve" },
    { type: "approve", requestId: 1 },
    { type: "approve", requestId: "r1", scope: 1 },
    { type: "deny", requestId: "r1", scope: null },
  ]) {
    expect(parseBrokerMessage(value)).toBeNull();
  }
});

async function withBroker(
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-limit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_limit",
    document: documentWithScopes({}),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_limit/sock`;
  await broker.start(socketPath);
  try {
    await fn(socketPath);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Writes raw bytes and returns the reply line, or null if closed silently. */
async function sendRaw(
  socketPath: string,
  payload: string | Buffer,
): Promise<string | null> {
  const socket = await connectUnix(socketPath);
  socket.on("error", () => {});
  try {
    const reply = readJsonLine(socket, 1024 * 1024).catch(() => null);
    socket.write(payload);
    return await reply;
  } finally {
    socket.destroy();
  }
}

test("SessionBroker: a line over the byte limit is dropped and the broker keeps serving", async () => {
  await withBroker(async (socketPath) => {
    const oversized = Buffer.alloc(BROKER_REQUEST_MAX_BYTES + 1, 0x61);
    expect(await sendRaw(socketPath, oversized)).toBeNull();

    const response = await sendBrokerRequest(socketPath, {
      type: "list_pending",
    });
    expect(response).toEqual({ type: "pending", items: [] });
  });
});

test("SessionBroker: an unknown message type is dropped instead of listing pending", async () => {
  await withBroker(async (socketPath) => {
    expect(
      await sendRaw(socketPath, `${JSON.stringify({ type: "shutdown" })}\n`),
    ).toBeNull();
    expect(await sendRaw(socketPath, "[]\n")).toBeNull();
  });
});

function principalRequest(
  requestId: string,
  principal: "agent" | "dind" = "agent",
  overrides: Partial<import("./protocol.ts").AuthorizeRequest> = {},
): import("./protocol.ts").AuthorizeRequest {
  return {
    version: 1,
    type: "authorize",
    requestId,
    sessionId: "sess_roles",
    principal,
    target: { host: "registry.example.com", port: 443 },
    method: "GET",
    transport: "http",
    requestKind: "forward",
    observedAt: new Date().toISOString(),
    bodyTruth: {},
    bodyDiagnostics: {},
    requestBodyCapture: { state: "disabled" },
    reviewContext: {
      path: "/v2/images/manifests/latest",
      contentType: null,
      bodySize: 0,
    },
    ...overrides,
  };
}

async function withPrincipalBroker(
  options: Partial<ConstructorParameters<typeof SessionBroker>[0]>,
  fn: (socketPath: string, auditDir: string) => Promise<void>,
): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-roles-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const auditDir = path.join(runtimeDir, "audit");
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_roles",
    document: documentWithScopes({
      agent: { targets: ["agent.example.com"], fallback: "allow" },
    }),
    dindDocument: documentWithScopes({
      registry: {
        targets: ["registry.example.com"],
        rules: {
          read: {
            match: { methods: ["GET"], paths: ["/v2/**"] },
            onMatch: "allow",
          },
        },
      },
    }),
    pendingTimeoutSeconds: 2,
    pendingNotify: "off",
    auditDir,
    ...options,
  });
  const socketPath = `${paths.brokersDir}/sess_roles/sock`;
  try {
    await broker.start(socketPath);
    await fn(socketPath, auditDir);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

test("SessionBroker: DinD allows registry reads, denies writes and agent-only targets, and records principal", async () => {
  await withPrincipalBroker({}, async (socketPath, auditDir) => {
    const read = await sendBrokerRequest<
      import("./protocol.ts").DecisionResponse
    >(
      socketPath,
      principalRequest("read", "dind", {
        bodyTruth: { "registry.read": "true" },
      }),
    );
    expect(read).toMatchObject({ decision: "allow", ruleId: "registry.read" });
    const write = await sendBrokerRequest<
      import("./protocol.ts").DecisionResponse
    >(socketPath, principalRequest("write", "dind", { method: "POST" }));
    expect(write.decision).toBe("deny");
    const target = { host: "agent.example.com", port: 443 };
    expect(
      (
        await sendBrokerRequest<import("./protocol.ts").DecisionResponse>(
          socketPath,
          principalRequest("agent", "agent", { target }),
        )
      ).decision,
    ).toBe("allow");
    expect(
      (
        await sendBrokerRequest<import("./protocol.ts").DecisionResponse>(
          socketPath,
          principalRequest("stolen", "dind", { target }),
        )
      ).decision,
    ).toBe("deny");
    const { queryAuditLogs } = await import("../audit/store.ts");
    const logs = await queryAuditLogs({}, auditDir);
    expect(logs.map((entry) => [entry.requestId, entry.principal])).toEqual([
      ["read", "dind"],
      ["write", "dind"],
      ["agent", "agent"],
      ["stolen", "dind"],
    ]);
  });
});

test("SessionBroker: DinD never receives automatic agent credentials but can inject an explicit registry secret", async () => {
  const { resolvedDocument } = await import("./authz/testing.ts");
  const dindDocument = resolvedDocument({
    secrets: { registryToken: { from: "env:REGISTRY_TOKEN" } },
    network: {
      scopes: {
        registry: {
          targets: ["registry.example.com"],
          fallback: "allow",
          secrets: { registryToken: "inject" },
          inject: [{ name: "x-registry-token", value: "secret:registryToken" }],
        },
      },
    },
  });
  await withPrincipalBroker(
    {
      document: documentWithScopes({
        registry: { targets: ["registry.example.com"], fallback: "allow" },
      }),
      dindDocument,
      secretValues: { registryToken: ["registry-value"] },
      agentCredentials: [
        {
          injectsInto: () => true,
          removeHeaders: ["x-agent-key"],
          isHostOwnedRefresh: () => false,
          headers: () => [
            { name: "Authorization", value: "Bearer agent-only-value" },
          ],
          close: async () => {},
        },
      ],
    },
    async (socketPath) => {
      const agent = await sendBrokerRequest<
        import("./protocol.ts").DecisionResponse
      >(socketPath, principalRequest("agent"));
      expect(agent.injectHeaders).toContainEqual({
        name: "Authorization",
        value: "Bearer agent-only-value",
      });
      const dind = await sendBrokerRequest<
        import("./protocol.ts").DecisionResponse
      >(socketPath, principalRequest("dind", "dind"));
      expect(dind.decision).toBe("allow");
      expect(dind.injectHeaders).toEqual([
        { name: "x-registry-token", value: "registry-value" },
      ]);
      expect(dind.removeHeaders).toBeUndefined();
    },
  );
});

test("SessionBroker: a cached agent approval never permits DinD even when rule IDs collide", async () => {
  const document = documentWithScopes({
    registry: { targets: ["registry.example.com"], fallback: "review" },
  });
  await withPrincipalBroker(
    { document, dindDocument: document },
    async (socketPath) => {
      const outstanding = sendBrokerRequest<
        import("./protocol.ts").DecisionResponse
      >(socketPath, principalRequest("pending"));
      try {
        let pending: import("./protocol.ts").PendingEntry[] = [];
        for (
          let attempts = 0;
          attempts < 100 && pending.length === 0;
          attempts += 1
        ) {
          pending = (
            await sendBrokerRequest<{
              type: "pending";
              items: import("./protocol.ts").PendingEntry[];
            }>(socketPath, { type: "list_pending" })
          ).items;
          if (pending.length === 0) await Bun.sleep(5);
        }
        expect(pending).toHaveLength(1);
        await sendBrokerRequest(socketPath, {
          type: "approve",
          requestId: "pending",
          scope: "host",
        });
        expect((await outstanding).decision).toBe("allow");
        expect(
          (
            await sendBrokerRequest<import("./protocol.ts").DecisionResponse>(
              socketPath,
              principalRequest("cached"),
            )
          ).decision,
        ).toBe("allow");
        expect(
          (
            await sendBrokerRequest<import("./protocol.ts").DecisionResponse>(
              socketPath,
              principalRequest("dind", "dind"),
            )
          ).decision,
        ).toBe("deny");
        expect(
          (
            await sendBrokerRequest<{
              type: "pending";
              items: import("./protocol.ts").PendingEntry[];
            }>(socketPath, { type: "list_pending" })
          ).items,
        ).toEqual([]);
        const review = await sendBrokerRequest<
          import("./protocol.ts").DecisionResponse
        >(socketPath, {
          type: "request_policy_review",
          version: 1,
          sessionId: "sess_roles",
          principal: "dind",
          requestId: "dind-review",
          ruleId: "registry.$fallback",
          target: { host: "registry.example.com", port: 443 },
          method: "GET",
          findings: [],
        });
        expect(review).toMatchObject({
          decision: "deny",
          reason: "dind-review-forbidden",
        });
      } finally {
        await sendBrokerRequest(socketPath, {
          type: "deny",
          requestId: "pending",
        });
        await outstanding;
      }
    },
  );
});

test("SessionBroker: absent DinD policy and unknown principals fail closed; legacy requests remain agent", async () => {
  await withPrincipalBroker(
    {
      document: documentWithScopes({
        registry: { targets: ["registry.example.com"], fallback: "allow" },
      }),
      dindDocument: undefined,
    },
    async (socketPath) => {
      const request = principalRequest("legacy");
      delete request.principal;
      expect(
        (
          await sendBrokerRequest<import("./protocol.ts").DecisionResponse>(
            socketPath,
            request,
          )
        ).decision,
      ).toBe("allow");
      const dind = await sendBrokerRequest(
        socketPath,
        principalRequest("missing", "dind"),
      );
      expect(dind).toMatchObject({
        type: "error",
        message: "network principal policy unavailable",
      });
      const unknown = await sendBrokerRequest(socketPath, {
        ...request,
        principal: "other",
      } as never);
      expect(unknown).toMatchObject({
        type: "error",
        message: "invalid network principal",
      });
    },
  );
});

test("SessionBroker: colliding outcome rule IDs audit the principal's own route", async () => {
  const doc = (route: string) =>
    documentWithScopes({
      registry: {
        targets: ["registry.example.com"],
        rules: {
          read: {
            match: { methods: ["GET"], paths: [route] },
            onMatch: "allow",
          },
        },
      },
    });
  await withPrincipalBroker(
    { document: doc("/agent/**"), dindDocument: doc("/v2/**") },
    async (socketPath, auditDir) => {
      for (const principal of ["agent", "dind"] as const) {
        const response = await sendBrokerRequest(socketPath, {
          version: 1,
          type: "request_policy_outcome",
          sessionId: "sess_roles",
          principal,
          requestId: `outcome-${principal}`,
          ruleId: "registry.read",
          result: "pass",
          reason: "no-inspection",
          findings: [],
        });
        expect(response.type).toBe("request_policy_outcome_recorded");
      }
      const { queryAuditLogs } = await import("../audit/store.ts");
      expect(
        (await queryAuditLogs({}, auditDir)).map((entry) => [
          entry.principal,
          entry.route,
        ]),
      ).toEqual([
        ["agent", "/agent/**"],
        ["dind", "/v2/**"],
      ]);
    },
  );
});
