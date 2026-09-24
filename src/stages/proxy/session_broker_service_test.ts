import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { documentWithScopes } from "../../network/authz/testing.ts";
import type { AgentCredentialSource } from "../../network/claude_oauth_source.ts";
import {
  type NetworkRuntimePaths,
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "../../network/registry.ts";
import {
  type SessionBrokerConfig,
  type SessionBrokerLifecycle,
  type SessionBrokerStartDeps,
  startSessionBroker,
} from "./session_broker_service.ts";

let runtimeDir: string;
let paths: NetworkRuntimePaths;

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-svc-unit-"));
  paths = await resolveNetworkRuntimePaths(runtimeDir);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
});

function makeConfig(sessionId: string): SessionBrokerConfig {
  return {
    paths,
    sessionId,
    socketPath: `${paths.brokersDir}/${sessionId}/sock`,
    profileName: "test",
    agent: "claude",
    document: documentWithScopes({}),
    requestBodyAudit: {
      enable: false,
      retentionSeconds: 86_400,
      maxBodyBytes: 4_194_304,
      maxTotalBytes: 67_108_864,
    },
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
    tokenHash: "hash",
    agentCredential: { kind: "claude-oauth", hostHome: "/nonexistent" },
  };
}

function makeSource(): AgentCredentialSource & { closed: number } {
  const source = {
    closed: 0,
    current: () => "token",
    close: async () => {
      source.closed += 1;
    },
  };
  return source;
}

function makeDeps(
  source: AgentCredentialSource,
  createBroker: SessionBrokerStartDeps["createBroker"],
): SessionBrokerStartDeps {
  return { openAgentCredential: async () => source, createBroker };
}

test("startSessionBroker: closes the credential source when constructing the broker throws", async () => {
  const source = makeSource();
  const deps = makeDeps(source, () => {
    throw new Error("construct failed");
  });

  await expect(
    startSessionBroker(makeConfig("sess_ctor"), deps),
  ).rejects.toThrow("construct failed");
  expect(source.closed).toBe(1);
});

test("startSessionBroker: closes the credential source when broker start throws", async () => {
  const source = makeSource();
  const deps = makeDeps(
    source,
    (): SessionBrokerLifecycle => ({
      start: async () => {
        throw new Error("start failed");
      },
      close: async () => {},
    }),
  );

  await expect(
    startSessionBroker(makeConfig("sess_start"), deps),
  ).rejects.toThrow("start failed");
  expect(source.closed).toBe(1);
});

test("startSessionBroker: handle.close closes the source and cleans up even when broker close throws", async () => {
  const source = makeSource();
  const sessionId = "sess_close_throws";
  const deps = makeDeps(
    source,
    (): SessionBrokerLifecycle => ({
      start: async () => {},
      close: async () => {
        throw new Error("close failed");
      },
    }),
  );

  const handle = await startSessionBroker(makeConfig(sessionId), deps);
  expect(await readSessionRegistry(paths, sessionId)).not.toBeNull();

  await Effect.runPromise(handle.close());

  expect(source.closed).toBe(1);
  expect(await readSessionRegistry(paths, sessionId)).toBeNull();
});

test("startSessionBroker: handle.close closes the source after the broker", async () => {
  const order: string[] = [];
  const source: AgentCredentialSource = {
    current: () => "token",
    close: async () => {
      order.push("source");
    },
  };
  const deps = makeDeps(
    source,
    (): SessionBrokerLifecycle => ({
      start: async () => {},
      close: async () => {
        order.push("broker");
      },
    }),
  );

  const handle = await startSessionBroker(makeConfig("sess_order"), deps);
  await Effect.runPromise(handle.close());

  expect(order).toEqual(["broker", "source"]);
});
