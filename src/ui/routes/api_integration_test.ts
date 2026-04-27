import { expect, test } from "bun:test";

/**
 * UI API ルートの単体テスト — Router.request() でテスト
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAuditLog } from "../../audit/store.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import {
  createSession,
  readSession,
  type SessionRuntimePaths,
  updateSessionTurn,
} from "../../sessions/store.ts";
import type { UiDataContext } from "../data.ts";
import { Router } from "../router.ts";
import { createApiRoutes } from "./api.ts";

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
  const sessionPaths: SessionRuntimePaths = {
    runtimeDir: `${dir}/sessions-root`,
    sessionsDir: `${dir}/sessions-root/sessions`,
  };
  return {
    networkPaths,
    hostExecPaths,
    sessionPaths,
    auditDir: `${dir}/audit`,
    terminalRuntimeDir: `${dir}/dtach`,
  };
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

test("POST /sessions/:sessionId/ack marks session as ack-turn", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    await createSession(ctx.sessionPaths, {
      sessionId: "sess-ack",
      agent: "claude",
      profile: "default",
      startedAt: "2026-04-11T10:00:00.000Z",
    });

    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions/sess-ack/ack", {
      method: "POST",
    });
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.item.turn).toEqual("ack-turn");
    expect(body.item.lastEventKind).toEqual("ack");

    const persisted = await readSession(ctx.sessionPaths, "sess-ack");
    expect(persisted?.turn).toEqual("ack-turn");
    expect(persisted?.lastEventKind).toEqual("ack");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /sessions/:sessionId/ack returns 404 for unknown session", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions/missing/ack", {
      method: "POST",
    });
    expect(res.status).toEqual(404);
    const body = await res.json();
    expect(body.error).toEqual("Session not found: missing");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /sessions/:sessionId/ack returns 409 when session is not user-turn", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    await createSession(ctx.sessionPaths, {
      sessionId: "sess-running",
      agent: "claude",
      profile: "default",
      startedAt: "2026-04-11T10:00:00.000Z",
    });
    await updateSessionTurn(ctx.sessionPaths, "sess-running", "start");

    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions/sess-running/ack", {
      method: "POST",
    });
    expect(res.status).toEqual(409);
    const body = await res.json();
    expect(body.error).toEqual("Cannot acknowledge turn in state: agent-turn");
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
    const brokerSocketDir = `${tmpDir}/network/brokers/${sessionId}`;
    await mkdir(brokerSocketDir, { recursive: true, mode: 0o700 });
    const brokerSocketPath = `${brokerSocketDir}/sock`;
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

    const ctx = createTestContext(tmpDir);
    await appendAuditLog(
      {
        id: "test-id-001",
        timestamp: "2026-03-28T12:00:00Z",
        domain: "network",
        sessionId: "sess-001",
        requestId: "req-001",
        decision: "allow",
        reason: "allowlist match",
        target: "example.com:443",
      },
      ctx.auditDir,
    );
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

    const ctx = createTestContext(tmpDir);
    for (const i of [1, 2, 3]) {
      await appendAuditLog(
        {
          id: `id-${i}`,
          timestamp: `2026-03-28T12:0${i}:00Z`,
          domain: "network",
          sessionId: "sess-001",
          requestId: `req-${i}`,
          decision: "allow",
          reason: "test",
        },
        ctx.auditDir,
      );
    }
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

test("POST /containers/:name/shell returns 500 when container does not exist", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request(
      "/api/containers/nas-agent-nonexistent-container/shell",
      { method: "POST" },
    );
    // docker inspect will fail for a non-existent container → 500
    expect(res.status).toEqual(500);
    const body = await res.json();
    expect(typeof body.error).toEqual("string");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /audit filters by session parameter", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/audit`, { recursive: true });

    const ctx = createTestContext(tmpDir);
    await appendAuditLog(
      {
        id: "id-1",
        timestamp: "2026-03-28T12:00:00Z",
        domain: "network",
        sessionId: "sess-001",
        requestId: "req-1",
        decision: "allow",
        reason: "test",
      },
      ctx.auditDir,
    );
    await appendAuditLog(
      {
        id: "id-2",
        timestamp: "2026-03-28T12:01:00Z",
        domain: "network",
        sessionId: "sess-002",
        requestId: "req-2",
        decision: "deny",
        reason: "test",
      },
      ctx.auditDir,
    );
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/audit?sessions=sess-001");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.items.length).toEqual(1);
    expect(body.items[0].sessionId).toEqual("sess-001");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- UI hardening (fix/ui-hardening) -------------------------------------

test("POST /network/approve rejects unknown scope values with 400", async () => {
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
      body: JSON.stringify({
        sessionId: "sess-1",
        requestId: "req-1",
        // Not in {once, host-port, host} — any escalation attempt here
        // (e.g., "global", "all", "..") must be rejected at the HTTP layer.
        scope: "all",
      }),
    });
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid scope");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /hostexec/approve rejects unknown scope values with 400", async () => {
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
      body: JSON.stringify({
        sessionId: "sess-1",
        requestId: "req-1",
        scope: "host", // not a hostexec scope; must be rejected
      }),
    });
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid scope");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("PATCH /sessions/:id/name rejects names longer than 200 chars", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    await createSession(ctx.sessionPaths, {
      sessionId: "sess-rename",
      agent: "claude",
      profile: "default",
      startedAt: "2026-04-11T10:00:00.000Z",
    });
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions/sess-rename/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(201) }),
    });
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toContain("200");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("PATCH /sessions/:id/name strips control characters and persists the result", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    await createSession(ctx.sessionPaths, {
      sessionId: "sess-ctrl",
      agent: "claude",
      profile: "default",
      startedAt: "2026-04-11T10:00:00.000Z",
    });
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions/sess-ctrl/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a\u0000b\u0007c\u007fd" }),
    });
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.item.name).toEqual("abcd");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("PATCH /sessions/:id/name rejects names that become empty after stripping", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    await createSession(ctx.sessionPaths, {
      sessionId: "sess-empty",
      agent: "claude",
      profile: "default",
      startedAt: "2026-04-11T10:00:00.000Z",
    });
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions/sess-empty/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "\u0001\u0002\u0003" }),
    });
    expect(res.status).toEqual(400);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("PATCH /sessions/:id/name returns 404 for unknown session", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    await mkdir(`${tmpDir}/sessions-root/sessions`, { recursive: true });
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/sessions/sess_missing/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new-name" }),
    });
    expect(res.status).toEqual(404);
    const body = await res.json();
    expect(body).toEqual({
      error: expect.stringMatching(/^Session not found:/),
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /launch/branches with relative cwd returns 400 (LaunchValidationError)", async () => {
  // Verifies that LaunchValidationError thrown from validateCwd() is mapped to
  // a 400 response by withErrorHandling. This is the typed-error wrap path in
  // the refactor — the handler itself does not catch the error explicitly.
  // Docker / git binaries are NOT required: validateCwd() rejects synchronously
  // before any subprocess is spawned.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/launch/branches?cwd=relative-path");
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toEqual("Invalid cwd: must be an absolute path");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- /launch/info (cwd= query param) ---------------------------------------
//
// /api/launch/info accepts an optional ?cwd= query param and forwards it to
// getLaunchInfo(ctx, { cwd }). Empty or missing cwd is equivalent to a bare
// GET (no startDir override).
//
// Tests that exercise loadConfig() control XDG_CONFIG_HOME so the global
// config lookup is deterministic regardless of the developer's environment.

test("GET /launch/info without cwd returns 200 with LaunchInfo shape", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  const xdgDir = path.join(tmpDir, "xdg");
  await mkdir(xdgDir, { recursive: true });
  // Provide a minimal global config so loadConfig() at process.cwd() resolves
  // without depending on whether the developer has a real .agent-sandbox.* in
  // the project root or in ~/.config/nas. Note: process.cwd() may still find a
  // local config and merge it; we only pin shape, not profile contents.
  const nasDir = path.join(xdgDir, "nas");
  await mkdir(nasDir, { recursive: true });
  await writeFile(
    path.join(nasDir, "agent-sandbox.yml"),
    "default: g\nprofiles:\n  g:\n    agent: claude\n",
  );

  const originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
  try {
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/launch/info");
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(typeof body.dtachAvailable).toEqual("boolean");
    expect(Array.isArray(body.profiles)).toEqual(true);
    expect(Array.isArray(body.recentDirectories)).toEqual(true);
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /launch/info?cwd=/abs/path uses the cwd-local config", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  const xdgDir = path.join(tmpDir, "xdg");
  await mkdir(xdgDir, { recursive: true });
  // Empty XDG: no global config so the cwd-local yml is the only source.
  const projectDir = path.join(tmpDir, "proj");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, ".agent-sandbox.yml"),
    "default: cwdprofile\nprofiles:\n  cwdprofile:\n    agent: claude\n",
  );

  const originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
  try {
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request(
      `/api/launch/info?cwd=${encodeURIComponent(projectDir)}`,
    );
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.profiles).toEqual(["cwdprofile"]);
    expect(body.defaultProfile).toEqual("cwdprofile");
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /launch/info?cwd=relative returns 400 (LaunchValidationError)", async () => {
  // validateCwd() rejects synchronously before loadConfig() is called, so no
  // global/local config setup is needed for this case.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const res = await app.request("/api/launch/info?cwd=relative-path");
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error).toEqual("Invalid cwd: must be an absolute path");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /launch/info?cwd= (empty) is equivalent to bare GET", async () => {
  // Empty string must be treated as cwd-unset; it should NOT be forwarded as
  // a relative path (which would 400). This pins backward compatibility for
  // a UI that builds the URL without checking whether the user selected a cwd.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  const xdgDir = path.join(tmpDir, "xdg");
  await mkdir(xdgDir, { recursive: true });
  const nasDir = path.join(xdgDir, "nas");
  await mkdir(nasDir, { recursive: true });
  await writeFile(
    path.join(nasDir, "agent-sandbox.yml"),
    "default: g\nprofiles:\n  g:\n    agent: claude\n",
  );

  const originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
  try {
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const resEmpty = await app.request("/api/launch/info?cwd=");
    expect(resEmpty.status).toEqual(200);
    const bodyEmpty = await resEmpty.json();

    const resBare = await app.request("/api/launch/info");
    expect(resBare.status).toEqual(200);
    const bodyBare = await resBare.json();

    expect(bodyEmpty.profiles).toEqual(bodyBare.profiles);
    expect(bodyEmpty.defaultProfile).toEqual(bodyBare.defaultProfile);
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /containers/clean requires {confirm:true} body", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-ui-test-"));
  try {
    const ctx = createTestContext(tmpDir);
    const api = createApiRoutes(ctx);
    const app = new Router();
    app.route("/api", api);

    const noBody = await app.request("/api/containers/clean", {
      method: "POST",
    });
    expect(noBody.status).toEqual(400);

    const falseConfirm = await app.request("/api/containers/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: false }),
    });
    expect(falseConfirm.status).toEqual(400);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
