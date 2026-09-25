import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Exit, Layer } from "effect";
import { containerNameForSession } from "../../docker/nas_resources.ts";
import { pathExists } from "../../lib/fs_utils.ts";
import type { AgentCredential } from "../../network/agent_credential.ts";
import { documentWithScopes } from "../../network/authz/testing.ts";
import {
  gcNetworkRuntime,
  type NetworkRuntimePaths,
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "../../network/registry.ts";
import { runPipelineState } from "../../pipeline/pipeline.ts";
import { makeDockerServiceFake } from "../../services/docker.ts";
import {
  ContainerLaunchService,
  ContainerLaunchServiceLive,
} from "../launch/container_launch_service.ts";
import {
  makeSessionBrokerServiceLayer,
  type SessionBrokerConfig,
  type SessionBrokerLifecycle,
  SessionBrokerService,
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
    agentCredentials: [
      { kind: "claude-oauth", hostHome: "/nonexistent" },
      { kind: "codex-oauth", hostHome: "/nonexistent" },
    ],
  };
}

function makeSource(): AgentCredential & { closed: number } {
  const source = {
    closed: 0,
    injectsInto: () => false,
    removeHeaders: [],
    isHostOwnedRefresh: () => false,
    headers: () => [],
    close: async () => {
      source.closed += 1;
    },
  };
  return source;
}

function makeDeps(
  source: AgentCredential,
  createBroker: SessionBrokerStartDeps["createBroker"],
): SessionBrokerStartDeps {
  return {
    openAgentCredential: async () => source,
    createBroker,
    killContainer: async () => {},
    sleep: async () => {},
  };
}

test("startSessionBroker: closes the credential source when constructing the broker throws", async () => {
  const source = makeSource();
  const deps = makeDeps(source, () => {
    throw new Error("construct failed");
  });

  await expect(
    startSessionBroker(makeConfig("sess_ctor"), deps),
  ).rejects.toThrow("construct failed");
  expect(source.closed).toBe(2);
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
  expect(source.closed).toBe(2);
});

test("startSessionBroker: runtime GC during broker start keeps the session", async () => {
  const sessionId = "sess_gc_race";
  const config = makeConfig(sessionId);
  const deps = makeDeps(
    makeSource(),
    (): SessionBrokerLifecycle => ({
      start: async (socketPath) => {
        await mkdir(path.dirname(socketPath), { recursive: true });
        await gcNetworkRuntime(paths);
        expect(await pathExists(path.dirname(socketPath))).toBe(true);
        await writeFile(socketPath, "");
      },
      close: async () => {},
    }),
  );

  await startSessionBroker(config, deps);

  const entry = await readSessionRegistry(paths, sessionId);
  expect(entry).not.toBeNull();
  expect(entry?.starting).toBeUndefined();
});

test("startSessionBroker: removes the reserved registry when broker start throws", async () => {
  const sessionId = "sess_start_registry";
  const deps = makeDeps(
    makeSource(),
    (): SessionBrokerLifecycle => ({
      start: async () => {
        expect((await readSessionRegistry(paths, sessionId))?.starting).toBe(
          true,
        );
        throw new Error("start failed");
      },
      close: async () => {},
    }),
  );

  await expect(startSessionBroker(makeConfig(sessionId), deps)).rejects.toThrow(
    "start failed",
  );
  expect(await readSessionRegistry(paths, sessionId)).toBeNull();
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

  expect(source.closed).toBe(2);
  expect(await readSessionRegistry(paths, sessionId)).toBeNull();
});

test("startSessionBroker: handle.close closes the source after the broker", async () => {
  const order: string[] = [];
  const source: AgentCredential = {
    injectsInto: () => false,
    removeHeaders: [],
    isHostOwnedRefresh: () => false,
    headers: () => [],
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

  expect(order).toEqual(["broker", "source", "source"]);
});

test("startSessionBroker: closes the credentials already opened when a later one fails", async () => {
  const first = makeSource();
  let opened = 0;
  const deps: SessionBrokerStartDeps = {
    openAgentCredential: async (config) => {
      opened += 1;
      if (config.kind === "codex-oauth") throw new Error("no auth.json");
      return first;
    },
    createBroker: () => {
      throw new Error("must not be constructed");
    },
    killContainer: async () => {},
    sleep: async () => {},
  };
  await expect(
    startSessionBroker(makeConfig("sess_partial"), deps),
  ).rejects.toThrow("no auth.json");
  expect(opened).toBe(2);
  expect(first.closed).toBe(1);
});

test("startSessionBroker: passes every opened credential to the broker", async () => {
  const source = makeSource();
  const seen: unknown[] = [];
  const deps = makeDeps(source, (options) => {
    seen.push(options.agentCredentials);
    return { start: async () => {}, close: async () => {} };
  });
  const handle = await startSessionBroker(makeConfig("sess_all"), deps);
  expect(seen).toEqual([[source, source]]);
  await Effect.runPromise(handle.close());
});

// ---------------------------------------------------------------------------
// ホストの credential の失効
// ---------------------------------------------------------------------------

interface RevocationHarness {
  readonly deps: SessionBrokerStartDeps;
  /** 監視が失効を通知する。 */
  revoke(): void;
  readonly kills: string[];
}

/**
 * container が無いか動いていない間は kill が失敗する docker を模す。
 * `running()` が true を返すようになってから kill が成功する。
 */
function makeRevocationHarness(running: () => boolean): RevocationHarness {
  let onRevoked: (() => void) | undefined;
  const kills: string[] = [];
  const source = makeSource();
  return {
    kills,
    revoke: () => {
      if (onRevoked === undefined) throw new Error("credential not opened");
      onRevoked();
    },
    deps: {
      openAgentCredential: async (_config, revoked) => {
        onRevoked = revoked;
        return source;
      },
      createBroker: () => ({ start: async () => {}, close: async () => {} }),
      killContainer: async (name) => {
        kills.push(name);
        if (!running()) throw new Error(`No such container: ${name}`);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 100)),
    },
  };
}

function brokerStage(config: SessionBrokerConfig) {
  return {
    name: "BrokerStage",
    needs: [] as const,
    run: () =>
      Effect.gen(function* () {
        const service = yield* SessionBrokerService;
        yield* Effect.acquireRelease(service.start(config), (handle) =>
          handle.close(),
        );
        return {};
      }),
  };
}

/** DinD の起動のように、launch の前で時間のかかるステージ。 */
function slowStage(reached: () => void) {
  return {
    name: "SlowStage",
    needs: [] as const,
    run: () =>
      Effect.sync(reached).pipe(
        Effect.andThen(Effect.sleep("200 millis")),
        Effect.as({}),
      ),
  };
}

function launchStage() {
  return {
    name: "LaunchStage",
    needs: [] as const,
    run: () =>
      Effect.gen(function* () {
        const launcher = yield* ContainerLaunchService;
        yield* launcher.launch({
          image: "img",
          name: "unused",
          args: [],
          envVars: {},
          command: [],
        });
        return {};
      }),
  };
}

test("a host credential revoked before the launch stops the pipeline before docker run", async () => {
  const sessionId = "sess_revoked_early";
  let launched = false;
  const harness = makeRevocationHarness(() => false);
  let reachedSlowStage!: () => void;
  const slowStageReached = new Promise<void>((resolve) => {
    reachedSlowStage = resolve;
  });

  const run = Effect.runPromiseExit(
    runPipelineState(
      [
        brokerStage(makeConfig(sessionId)),
        slowStage(reachedSlowStage),
        launchStage(),
      ],
      {},
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          makeSessionBrokerServiceLayer(harness.deps),
          ContainerLaunchServiceLive.pipe(
            Layer.provide(
              makeDockerServiceFake({
                runInteractive: () =>
                  Effect.sync(() => {
                    launched = true;
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  );
  await slowStageReached;
  harness.revoke();
  const exit = await run;

  expect(launched).toBe(false);
  expect(Exit.isInterrupted(exit)).toBe(true);
  expect(harness.kills[0]).toBe(containerNameForSession(sessionId));
  // セッションの後始末で credential を閉じたら、kill のやり直しも止まる。
  const killsAtExit = harness.kills.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(harness.kills.length).toBe(killsAtExit);
});

test("a host credential revoked while the container runs kills it and waits for docker run to exit", async () => {
  const sessionId = "sess_revoked_running";
  let containerRunning = false;
  let dockerRunExited = false;
  const harness = makeRevocationHarness(() => containerRunning);
  let dockerRunStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    dockerRunStarted = resolve;
  });

  const run = Effect.runPromiseExit(
    runPipelineState(
      [brokerStage(makeConfig(sessionId)), launchStage()],
      {},
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          makeSessionBrokerServiceLayer(harness.deps),
          ContainerLaunchServiceLive.pipe(
            Layer.provide(
              makeDockerServiceFake({
                // docker run は container が kill されるまで戻らない。container は
                // docker run を始めてから少し後に動き出す。
                runInteractive: () =>
                  Effect.async<void, Error>((resume) => {
                    dockerRunStarted();
                    setTimeout(() => {
                      containerRunning = true;
                    }, 20);
                    const poll = setInterval(() => {
                      if (harness.kills.length > 0 && containerRunning) {
                        clearInterval(poll);
                        dockerRunExited = true;
                        resume(
                          Effect.fail(
                            new Error("docker run exited with code 137"),
                          ),
                        );
                      }
                    }, 5);
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  );
  // docker run が container を動かし出す前に失効しても、動き出した後で kill する。
  await runStarted;
  harness.revoke();
  const exit = await run;

  expect(Exit.isFailure(exit)).toBe(true);
  expect(dockerRunExited).toBe(true);
  expect(harness.kills.length).toBeGreaterThan(1);
  expect(
    harness.kills.every((name) => name === containerNameForSession(sessionId)),
  ).toBe(true);
});
