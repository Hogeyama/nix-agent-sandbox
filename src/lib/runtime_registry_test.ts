import { expect, test } from "bun:test";
import * as path from "node:path";
import {
  type BaseRuntimePaths,
  brokerSocketPath,
  execSocketDir,
  execSocketPath,
  pendingRequestPath,
  pendingSessionDir,
  sessionBrokerDir,
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
