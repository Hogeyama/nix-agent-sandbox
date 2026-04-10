import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
/**
 * UI API ルートの単体テスト — Router.request() でテスト
 */

import { Router } from "../router.ts";
import { createApiRoutes } from "./api.ts";
import type { UiDataContext } from "../data.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

test("GET /network/pending returns items array", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    // Create required dirs
    await mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await mkdir(`${tmpDir}/network/brokers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/network/pending");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toEqual(true);
    expect(body.items.length).toEqual(0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /hostexec/pending returns items array", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });
    await mkdir(`${tmpDir}/hostexec/brokers`, { recursive: true });
    await mkdir(`${tmpDir}/hostexec/wrappers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/hostexec/pending");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toEqual(true);
    expect(body.items.length).toEqual(0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /sessions returns network and hostexec arrays", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await mkdir(`${tmpDir}/network/brokers`, { recursive: true });
    await mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(Array.isArray(body.network)).toEqual(true);
    expect(Array.isArray(body.hostexec)).toEqual(true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /network/approve returns 400 without required fields", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await mkdir(`${tmpDir}/network/brokers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/network/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toEqual("sessionId and requestId are required");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /network/deny returns 400 without required fields", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await mkdir(`${tmpDir}/network/brokers`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/network/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toEqual(400);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /hostexec/approve returns 400 without required fields", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/hostexec/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toEqual(400);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /hostexec/deny returns 400 without required fields", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/hostexec/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/hostexec/pending`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/hostexec/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toEqual(400);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /network/pending with pending entry returns it", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    const sessionId = "test-session-001";
    const requestId = "req-001";

    await mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/network/pending/${sessionId}`, {
      recursive: true,
    });
    await mkdir(`${tmpDir}/network/brokers`, { recursive: true });

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
    await writeFile(
      `${tmpDir}/network/pending/${sessionId}/${requestId}.json`,
      JSON.stringify(entry),
    );

    // Create a fake broker socket file so GC doesn't remove the session
    const brokerSocketPath = `${tmpDir}/network/brokers/${sessionId}.sock`;
    await writeFile(brokerSocketPath, "");

    // Write a session registry so GC doesn't remove it
    const session = {
      version: 1,
      sessionId,
      tokenHash: "abc",
      brokerSocket: brokerSocketPath,
      profileName: "test",
      allowlist: [],
      createdAt: new Date().toISOString(),
      pid: process.pid,
      promptEnabled: true,
    };
    await writeFile(
      `${tmpDir}/network/sessions/${sessionId}.json`,
      JSON.stringify(session),
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/network/pending");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.items.length).toEqual(1);
    expect(body.items[0].requestId).toEqual(requestId);
    expect(body.items[0].target.host).toEqual("example.com");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit returns empty items when no logs exist", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await mkdir(`${tmpDir}/network/brokers`, { recursive: true });
    await mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/audit");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toEqual(true);
    expect(body.items.length).toEqual(0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit returns audit log entries", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/network/sessions`, { recursive: true });
    await mkdir(`${tmpDir}/network/pending`, { recursive: true });
    await mkdir(`${tmpDir}/network/brokers`, { recursive: true });
    await mkdir(`${tmpDir}/audit`, { recursive: true });

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
    await writeFile(
      `${tmpDir}/audit/2026-03-28.jsonl`,
      JSON.stringify(entry) + "\n",
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/audit");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.items.length).toEqual(1);
    expect(body.items[0].id).toEqual("test-id-001");
    expect(body.items[0].domain).toEqual("network");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit with invalid domain returns 400", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/audit?domain=invalid");
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toEqual(
      'Invalid domain: must be "network" or "hostexec"',
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit with before cursor returns only older entries", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/audit`, { recursive: true });

    const base = {
      domain: "network",
      sessionId: "sess-001",
      decision: "allow",
      reason: "allowlist match",
    };
    const lines = [
      { ...base, id: "a", timestamp: "2026-03-28T09:00:00Z", requestId: "a" },
      { ...base, id: "b", timestamp: "2026-03-28T10:00:00Z", requestId: "b" },
      { ...base, id: "c", timestamp: "2026-03-28T11:00:00Z", requestId: "c" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(`${tmpDir}/audit/2026-03-28.jsonl`, lines);

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request(
      "/api/audit?before=2026-03-28T11:00:00Z",
    );
    expect(res.status).toEqual(200);
    const body = await res.json();
    const ids = body.items.map((e: { id: string }) => e.id);
    expect(ids).toEqual(["a", "b"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit with invalid before returns 400", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/audit?before=not-a-date");
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toEqual(
      "Invalid before: must be an ISO-8601 timestamp",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit with invalid limit returns 400", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/audit?limit=abc");
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toEqual("Invalid limit: must be a positive integer");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit respects limit parameter", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/audit`, { recursive: true });

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
    await writeFile(
      `${tmpDir}/audit/2026-03-28.jsonl`,
      entries.join("\n") + "\n",
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/audit?limit=2");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.items.length).toEqual(2);
    // Should return the last 2 entries
    expect(body.items[0].id).toEqual("id-2");
    expect(body.items[1].id).toEqual("id-3");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit filters by sessions set and sessionContains", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/audit`, { recursive: true });

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
      JSON.stringify({
        id: "id-3",
        timestamp: "2026-03-28T12:02:00Z",
        domain: "network",
        sessionId: "other-003",
        requestId: "req-3",
        decision: "allow",
        reason: "test",
      }),
    ];
    await writeFile(
      `${tmpDir}/audit/2026-03-28.jsonl`,
      entries.join("\n") + "\n",
    );

    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    // Set membership (comma-separated)
    const setRes = await app.request(
      "/api/audit?sessions=sess-001,sess-002",
    );
    expect(setRes.status).toEqual(200);
    const setBody = await setRes.json();
    expect(setBody.items.length).toEqual(2);
    const ids = new Set(
      setBody.items.map((e: { sessionId: string }) => e.sessionId),
    );
    expect(ids.has("sess-001")).toEqual(true);
    expect(ids.has("sess-002")).toEqual(true);

    // Substring match
    const subRes = await app.request(
      "/api/audit?sessionContains=sess",
    );
    expect(subRes.status).toEqual(200);
    const subBody = await subRes.json();
    expect(subBody.items.length).toEqual(2);

    // Empty sessions set returns nothing
    const emptyRes = await app.request("/api/audit?sessions=");
    expect(emptyRes.status).toEqual(200);
    const emptyBody = await emptyRes.json();
    expect(emptyBody.items.length).toEqual(0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
