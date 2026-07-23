import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "../../network/registry.ts";
import {
  type SessionBrokerConfig,
  SessionBrokerService,
  SessionBrokerServiceLive,
} from "./session_broker_service.ts";

test("SessionBrokerService: writes the session registry entry", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-svc-"));
  try {
    const paths = await resolveNetworkRuntimePaths(runtimeDir);
    const sessionId = "sess_registry";
    const socketPath = `${paths.brokersDir}/${sessionId}/sock`;
    const config: SessionBrokerConfig = {
      paths,
      sessionId,
      socketPath,
      profileName: "test",
      agent: "claude",
      reviewRules: [{ action: "deny" }],
      pendingTimeoutSeconds: 30,
      pendingDefaultScope: "host-port",
      pendingNotify: "off",
      tokenHash: "hash",
    };

    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionBrokerService;
        return yield* svc.start(config);
      }).pipe(Effect.provide(SessionBrokerServiceLive)),
    );
    try {
      const entry = await readSessionRegistry(paths, sessionId);
      expect(entry?.agent).toBe("claude");
    } finally {
      await Effect.runPromise(handle.close());
    }
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
