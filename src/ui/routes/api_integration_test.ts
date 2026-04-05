/**
 * UI API ルートの単体テスト — Hono の app.request() でテスト
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { createApiRoutes } from "./api.ts";
import type { UiDataContext } from "../data.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";

/** テスト用のダミーコンテキストを作成 */
function createTestContext(dir: string): UiDataContext {
  const networkPaths: NetworkRuntimePaths = {
    runtimeDir: `${dir}/network`,
    sessionsDir: `${dir}/network/sessions`,
    pendingDir: `${dir}/network/pending`,
    brokersDir: `${dir}/network/brokers`,
    authRouterSocket: `${dir}/network/auth-router.sock`,
    authRouterPidFile: `${dir}/network/auth-router.pid`,
    envoyConfigFile: `${dir}/network/envoy.yaml`,
  };
  const hostExecPaths: HostExecRuntimePaths = {
    runtimeDir: `${dir}/hostexec`,
    sessionsDir: `${dir}/hostexec/sessions`,
    pendingDir: `${dir}/hostexec/pending`,
    brokersDir: `${dir}/hostexec/brokers`,
    wrappersDir: `${dir}/hostexec/wrappers`,
  };
  return { networkPaths, hostExecPaths, auditDir: `${dir}/audit` };
}

Deno.test("GET /network/pending returns items array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    // Create required dirs
    await Deno.mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/brokers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/network/pending");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.items), true);
    assertEquals(body.items.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /hostexec/pending returns items array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/hostexec/brokers`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/hostexec/wrappers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/hostexec/pending");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.items), true);
    assertEquals(body.items.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /sessions returns network and hostexec arrays", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/brokers`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/sessions");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.network), true);
    assertEquals(Array.isArray(body.hostexec), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("POST /network/approve returns 400 without required fields", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/brokers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/network/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "sessionId and requestId are required");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("POST /network/deny returns 400 without required fields", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/brokers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/network/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("POST /hostexec/approve returns 400 without required fields", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/hostexec/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("POST /hostexec/deny returns 400 without required fields", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/hostexec/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /network/pending with pending entry returns it", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    const sessionId = "test-session-001";
    const requestId = "req-001";

    await Deno.mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/pending/${sessionId}`, {
      recursive: true,
    });
    await Deno.mkdir(`${tmpDir}/network/brokers`, { recursive: true });

    // Write a pending entry
    const entry = {
      version: 1,
      sessionId,
      requestId,
      target: { host: "example.com", port: 443 },
      method: "CONNECT",
      requestKind: "connect",
      state: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await Deno.writeTextFile(
      `${tmpDir}/network/pending/${sessionId}/${requestId}.json`,
      JSON.stringify(entry),
    );

    // Create a fake broker socket file so GC doesn't remove the session
    const brokerSocketPath = `${tmpDir}/network/brokers/${sessionId}.sock`;
    await Deno.writeTextFile(brokerSocketPath, "");

    // Write a session registry so GC doesn't remove it
    const session = {
      version: 1,
      sessionId,
      tokenHash: "abc",
      brokerSocket: brokerSocketPath,
      profileName: "test",
      allowlist: [],
      createdAt: new Date().toISOString(),
      pid: Deno.pid,
      promptEnabled: true,
    };
    await Deno.writeTextFile(
      `${tmpDir}/network/sessions/${sessionId}.json`,
      JSON.stringify(session),
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/network/pending");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items.length, 1);
    assertEquals(body.items[0].requestId, requestId);
    assertEquals(body.items[0].target.host, "example.com");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /audit returns empty items when no logs exist", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/brokers`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/audit");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.items), true);
    assertEquals(body.items.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /audit returns audit log entries", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/network/brokers`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/audit`, { recursive: true });

    // Write a JSONL audit log file
    const entry = {
      id: "test-id-001",
      timestamp: "2026-03-28T12:00:00Z",
      domain: "network",
      sessionId: "sess-001",
      requestId: "req-001",
      decision: "allow",
      reason: "allowlist match",
      target: "example.com:443",
    };
    await Deno.writeTextFile(
      `${tmpDir}/audit/2026-03-28.jsonl`,
      JSON.stringify(entry) + "\n",
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/audit");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items.length, 1);
    assertEquals(body.items[0].id, "test-id-001");
    assertEquals(body.items[0].domain, "network");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /audit with invalid domain returns 400", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/audit?domain=invalid");
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, 'Invalid domain: must be "network" or "hostexec"');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /audit with invalid limit returns 400", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/audit?limit=abc");
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid limit: must be a positive integer");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /audit respects limit parameter", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/audit`, { recursive: true });

    // Write 3 entries
    const entries = [1, 2, 3].map((i) =>
      JSON.stringify({
        id: `id-${i}`,
        timestamp: `2026-03-28T12:0${i}:00Z`,
        domain: "network",
        sessionId: "sess-001",
        requestId: `req-${i}`,
        decision: "allow",
        reason: "test",
      })
    );
    await Deno.writeTextFile(
      `${tmpDir}/audit/2026-03-28.jsonl`,
      entries.join("\n") + "\n",
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/audit?limit=2");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items.length, 2);
    // Should return the last 2 entries
    assertEquals(body.items[0].id, "id-2");
    assertEquals(body.items[1].id, "id-3");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("GET /audit filters by session parameter", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-ui-test-" });
  try {
    await Deno.mkdir(`${tmpDir}/audit`, { recursive: true });

    const entries = [
      JSON.stringify({
        id: "id-1",
        timestamp: "2026-03-28T12:00:00Z",
        domain: "network",
        sessionId: "sess-001",
        requestId: "req-1",
        decision: "allow",
        reason: "test",
      }),
      JSON.stringify({
        id: "id-2",
        timestamp: "2026-03-28T12:01:00Z",
        domain: "network",
        sessionId: "sess-002",
        requestId: "req-2",
        decision: "deny",
        reason: "test",
      }),
    ];
    await Deno.writeTextFile(
      `${tmpDir}/audit/2026-03-28.jsonl`,
      entries.join("\n") + "\n",
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Hono();
    app.route("/api", api);

    const res = await app.request("/api/audit?session=sess-001");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items.length, 1);
    assertEquals(body.items[0].sessionId, "sess-001");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
