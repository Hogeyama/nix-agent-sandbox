import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  type BaseRuntimePaths,
  brokerSocketPath,
  execSocketDir,
  execSocketPath,
  gcRuntime,
  listPendingEntries,
  pendingRequestPath,
  pendingSessionDir,
  sessionBrokerDir,
  sessionRegistryPath,
  writePendingEntry,
  writeSessionRegistry,
} from "./runtime_registry.ts";

const paths: BaseRuntimePaths = {
  runtimeDir: "/tmp/nas-runtime",
  sessionsDir: "/tmp/nas-runtime/sessions",
  pendingDir: "/tmp/nas-runtime/pending",
  brokersDir: "/tmp/nas-runtime/brokers",
};

for (const registered of [false, true]) {
  test.skipIf(process.getuid?.() === 0)(
    `gc continues past an inaccessible ${registered ? "stale" : "orphan"} broker directory and retries later`,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "nas-registry-gc-"));
      const runtimePaths: BaseRuntimePaths = {
        runtimeDir: root,
        sessionsDir: path.join(root, "sessions"),
        pendingDir: path.join(root, "pending"),
        brokersDir: path.join(root, "brokers"),
      };
      const blocked = sessionBrokerDir(runtimePaths, "blocked");
      const liveSocket = brokerSocketPath(runtimePaths, "live");
      try {
        await mkdir(blocked, { recursive: true });
        await writeFile(path.join(blocked, "sock"), "");
        await chmod(blocked, 0o500);
        if (registered) {
          await writeSessionRegistry(runtimePaths, {
            sessionId: "blocked",
            pid: 0,
            brokerSocket: path.join(blocked, "sock"),
          });
          await writePendingEntry(runtimePaths, {
            sessionId: "blocked",
            requestId: "old",
            createdAt: "2026-01-01",
          });
        }
        await mkdir(sessionBrokerDir(runtimePaths, "live"));
        await writeFile(liveSocket, "");
        await writeSessionRegistry(runtimePaths, {
          sessionId: "live",
          pid: process.pid,
          brokerSocket: liveSocket,
        });
        const pending = {
          sessionId: "live",
          requestId: "request",
          createdAt: "2026-01-02",
        };
        await writePendingEntry(runtimePaths, pending);
        await mkdir(sessionBrokerDir(runtimePaths, "removable"));

        // Verify the fixture really fails at the filesystem permission boundary.
        await expect(
          rm(blocked, { recursive: true, force: true }),
        ).rejects.toMatchObject({ code: "EACCES" });
        const result = await gcRuntime(runtimePaths);
        expect(result.skippedBrokerDirs).toEqual([blocked]);
        expect(result.removedBrokerSockets).toEqual([
          brokerSocketPath(runtimePaths, "removable"),
        ]);
        expect(result.removedSessions).toEqual(registered ? ["blocked"] : []);
        expect(await listPendingEntries(runtimePaths)).toEqual([pending]);

        await chmod(blocked, 0o700);
        const retried = await gcRuntime(runtimePaths);
        expect(retried.skippedBrokerDirs).toEqual([]);
        expect(retried.removedBrokerSockets).toEqual([
          path.join(blocked, "sock"),
        ]);
      } finally {
        await chmod(blocked, 0o700).catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("sessionRegistryPath accepts a plain sessionId", () => {
  expect(sessionRegistryPath(paths, "sess_abc123")).toBe(
    path.join(paths.sessionsDir, "sess_abc123.json"),
  );
});

test("sessionRegistryPath rejects traversal via ..", () => {
  expect(() => sessionRegistryPath(paths, "../x")).toThrow(
    /path traversal detected/,
  );
});

test("sessionRegistryPath rejects deeper traversal via ../..", () => {
  expect(() => sessionRegistryPath(paths, "../../../etc/passwd")).toThrow(
    /path traversal detected/,
  );
});

test("brokerSocketPath rejects traversal via ..", () => {
  expect(() => brokerSocketPath(paths, "../x")).toThrow(
    /path traversal detected/,
  );
});

test("brokerSocketPath accepts a plain sessionId", () => {
  expect(brokerSocketPath(paths, "sess_abc123")).toBe(
    path.join(paths.brokersDir, "sess_abc123", "sock"),
  );
});

test("execSocketDir accepts a plain sessionId", () => {
  expect(execSocketDir(paths, "sess_abc123")).toBe(
    path.join(paths.brokersDir, "sess_abc123", "exec"),
  );
});

test("execSocketDir is nested under the session broker dir", () => {
  expect(execSocketDir(paths, "sess_abc123")).toBe(
    path.join(paths.brokersDir, "sess_abc123", "exec"),
  );
});

test("execSocketDir rejects traversal via ..", () => {
  expect(() => execSocketDir(paths, "../escape")).toThrow(
    /path traversal detected/,
  );
});

test("execSocketDir rejects nested traversal", () => {
  expect(() => execSocketDir(paths, "a/../../b")).toThrow(
    /path traversal detected/,
  );
});

test("execSocketPath accepts a plain sessionId", () => {
  expect(execSocketPath(paths, "sess_abc123")).toBe(
    path.join(paths.brokersDir, "sess_abc123", "exec", "sock"),
  );
});

test("execSocketPath is nested under the session broker dir", () => {
  expect(execSocketPath(paths, "sess_abc123")).toBe(
    path.join(sessionBrokerDir(paths, "sess_abc123"), "exec", "sock"),
  );
});

test("execSocketPath rejects traversal via ..", () => {
  expect(() => execSocketPath(paths, "../escape")).toThrow(
    /path traversal detected/,
  );
});

test("execSocketPath rejects nested traversal", () => {
  expect(() => execSocketPath(paths, "a/../../b")).toThrow(
    /path traversal detected/,
  );
});

test("pendingSessionDir rejects traversal via ..", () => {
  expect(() => pendingSessionDir(paths, "../x")).toThrow(
    /path traversal detected/,
  );
});

test("pendingSessionDir accepts a plain sessionId", () => {
  expect(pendingSessionDir(paths, "sess_abc123")).toBe(
    path.join(paths.pendingDir, "sess_abc123"),
  );
});

test("pendingRequestPath rejects traversal in sessionId", () => {
  expect(() => pendingRequestPath(paths, "../x", "req1")).toThrow(
    /path traversal detected/,
  );
});

test("pendingRequestPath rejects traversal in requestId", () => {
  expect(() => pendingRequestPath(paths, "sess_abc", "../evil")).toThrow(
    /path traversal detected/,
  );
});

test("pendingRequestPath accepts plain sessionId + requestId", () => {
  expect(pendingRequestPath(paths, "sess_abc123", "req_001")).toBe(
    path.join(paths.pendingDir, "sess_abc123", "req_001.json"),
  );
});
