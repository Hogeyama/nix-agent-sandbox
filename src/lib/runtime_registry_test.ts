import { expect, test } from "bun:test";
import * as path from "node:path";
import {
  type BaseRuntimePaths,
  brokerSocketPath,
  pendingRequestPath,
  pendingSessionDir,
  sessionRegistryPath,
} from "./runtime_registry.ts";

const paths: BaseRuntimePaths = {
  runtimeDir: "/tmp/nas-runtime",
  sessionsDir: "/tmp/nas-runtime/sessions",
  pendingDir: "/tmp/nas-runtime/pending",
  brokersDir: "/tmp/nas-runtime/brokers",
};

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
