/**
 * ContainerQueryService unit tests.
 *
 * Docker primitive は mock 不能なため Live test なし。fake DockerService +
 * fake SessionUiService を `Layer.mergeAll` で provide する fake-only 戦略
 * (selection B) を取る。compose ロジック (filter / join / running 判定) を
 * D2 として網羅する。
 */

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { NAS_SESSION_ID_LABEL } from "../../docker/nas_resources.ts";
import {
  type DockerContainerDetails,
  DockerServiceLive,
  makeDockerServiceFake,
} from "../../services/docker.ts";
import type {
  SessionRecord,
  SessionRuntimePaths,
} from "../../sessions/store.ts";
import { makeSessionUiServiceFake, SessionUiServiceLive } from "../session.ts";
import {
  ContainerQueryService,
  ContainerQueryServiceLive,
  makeContainerQueryClient,
  makeContainerQueryServiceFake,
} from "./service.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDetails(
  overrides: Partial<DockerContainerDetails> & { name: string },
): DockerContainerDetails {
  return {
    name: overrides.name,
    running: overrides.running ?? false,
    labels: overrides.labels ?? {},
    networks: overrides.networks ?? [],
    startedAt: overrides.startedAt ?? "1970-01-01T00:00:00.000Z",
  };
}

function makeRecord(
  sessionId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId,
    agent: "claude",
    profile: "default",
    turn: "user-turn",
    startedAt: "2026-04-10T00:00:00.000Z",
    lastEventAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

const PATHS: SessionRuntimePaths = {
  runtimeDir: "/tmp/nas-test",
  sessionsDir: "/tmp/nas-test/sessions",
};

// nas-managed label set (nas.managed=true + nas.kind=agent をかぶせる)
function nasAgentLabels(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "nas.managed": "true",
    "nas.kind": "agent",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Live (fake-only — uses fake DockerService + fake SessionUiService)
// ---------------------------------------------------------------------------

describe("ContainerQueryServiceLive: listManaged", () => {
  test("docker.listContainerNames が空 → 空配列を返し inspect は呼ばれない", async () => {
    let inspectCalls = 0;
    const dockerFake = makeDockerServiceFake({
      listContainerNames: () => Effect.succeed([]),
      inspect: (name) => {
        inspectCalls += 1;
        return Effect.succeed(makeDetails({ name }));
      },
    });
    const sessionUiFake = makeSessionUiServiceFake();
    const layer = ContainerQueryServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, sessionUiFake)),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) => svc.listManaged()).pipe(
        Effect.provide(layer),
      ),
    );

    expect(result).toEqual([]);
    expect(inspectCalls).toBe(0);
  });

  test("managed/unmanaged 混在 → managed のみ抽出", async () => {
    const dockerFake = makeDockerServiceFake({
      listContainerNames: () => Effect.succeed(["nas-managed", "other"]),
      inspect: (name) => {
        if (name === "nas-managed") {
          return Effect.succeed(
            makeDetails({
              name: "nas-managed",
              running: true,
              labels: nasAgentLabels({ [NAS_SESSION_ID_LABEL]: "sess-1" }),
              startedAt: "2026-04-10T00:00:00.000Z",
            }),
          );
        }
        return Effect.succeed(
          makeDetails({
            name: "other",
            running: true,
            labels: { "some.label": "x" },
          }),
        );
      },
    });
    const layer = ContainerQueryServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, makeSessionUiServiceFake())),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) => svc.listManaged()).pipe(
        Effect.provide(layer),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nas-managed");
    expect(result[0].running).toBe(true);
    expect(result[0].labels[NAS_SESSION_ID_LABEL]).toBe("sess-1");
    expect(result[0].startedAt).toBe("2026-04-10T00:00:00.000Z");
  });

  test("inspect 失敗は skip し、続く inspect を継続する (legacy try/catch-continue 保存)", async () => {
    const dockerFake = makeDockerServiceFake({
      listContainerNames: () => Effect.succeed(["nas-a", "nas-b"]),
      inspect: (name) => {
        if (name === "nas-a") return Effect.fail(new Error("disappeared"));
        return Effect.succeed(
          makeDetails({
            name: "nas-b",
            running: false,
            labels: nasAgentLabels(),
          }),
        );
      },
    });
    const layer = ContainerQueryServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, makeSessionUiServiceFake())),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) => svc.listManaged()).pipe(
        Effect.provide(layer),
      ),
    );

    // overall succeeds; nas-a was skipped, nas-b returned
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nas-b");
  });
});

describe("ContainerQueryServiceLive: listManagedWithSessions", () => {
  test("session record のあるコンテナに field overlay、ない方は素通し", async () => {
    const dockerFake = makeDockerServiceFake({
      listContainerNames: () =>
        Effect.succeed(["nas-with-sess", "nas-no-sess"]),
      inspect: (name) => {
        if (name === "nas-with-sess") {
          return Effect.succeed(
            makeDetails({
              name: "nas-with-sess",
              running: true,
              labels: nasAgentLabels({ [NAS_SESSION_ID_LABEL]: "sess1" }),
            }),
          );
        }
        return Effect.succeed(
          makeDetails({
            name: "nas-no-sess",
            running: true,
            labels: nasAgentLabels(),
          }),
        );
      },
    });
    const sessionUiFake = makeSessionUiServiceFake({
      list: () =>
        Effect.succeed([
          makeRecord("sess1", {
            name: "my-name",
            agent: "copilot",
            profile: "strict",
            worktree: "/work/repo",
            turn: "agent-turn",
            startedAt: "2026-04-10T00:00:00.000Z",
            lastEventAt: "2026-04-10T01:00:00.000Z",
            lastEventKind: "attention",
            lastEventMessage: "msg",
          }),
        ]),
    });
    const layer = ContainerQueryServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, sessionUiFake)),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) =>
        svc.listManagedWithSessions(PATHS),
      ).pipe(Effect.provide(layer)),
    );

    expect(result).toHaveLength(2);

    const overlaid = result.find((c) => c.name === "nas-with-sess");
    expect(overlaid).toBeDefined();
    expect(overlaid?.sessionId).toBe("sess1");
    expect(overlaid?.sessionName).toBe("my-name");
    expect(overlaid?.sessionAgent).toBe("copilot");
    expect(overlaid?.sessionProfile).toBe("strict");
    expect(overlaid?.worktree).toBe("/work/repo");
    expect(overlaid?.turn).toBe("agent-turn");
    expect(overlaid?.sessionStartedAt).toBe("2026-04-10T00:00:00.000Z");
    expect(overlaid?.lastEventAt).toBe("2026-04-10T01:00:00.000Z");
    expect(overlaid?.lastEventKind).toBe("attention");
    expect(overlaid?.lastEventMessage).toBe("msg");

    const untouched = result.find((c) => c.name === "nas-no-sess");
    expect(untouched).toBeDefined();
    expect(untouched?.sessionId).toBeUndefined();
    expect(untouched?.turn).toBeUndefined();
    expect(untouched?.sessionAgent).toBeUndefined();
  });

  test("session_id label あるが record なし → 素通し (overlay されない)", async () => {
    const dockerFake = makeDockerServiceFake({
      listContainerNames: () => Effect.succeed(["nas-ghost"]),
      inspect: (name) =>
        Effect.succeed(
          makeDetails({
            name,
            running: true,
            labels: nasAgentLabels({ [NAS_SESSION_ID_LABEL]: "ghost" }),
          }),
        ),
    });
    const sessionUiFake = makeSessionUiServiceFake({
      list: () => Effect.succeed([]),
    });
    const layer = ContainerQueryServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, sessionUiFake)),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) =>
        svc.listManagedWithSessions(PATHS),
      ).pipe(Effect.provide(layer)),
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nas-ghost");
    expect(result[0].sessionId).toBeUndefined();
    expect(result[0].sessionName).toBeUndefined();
    expect(result[0].turn).toBeUndefined();
    // label is preserved
    expect(result[0].labels[NAS_SESSION_ID_LABEL]).toBe("ghost");
  });
});

describe("ContainerQueryServiceLive: collectRunningParentIds", () => {
  test("running + label のみ Set に詰める (4 ケース組合せ)", async () => {
    // - nas-running-sid : running + nas.session_id=sess-A → 含まれる
    // - nas-stopped-sid : !running + nas.session_id=sess-B → 除外
    // - nas-running-nosid: running + label なし → 除外
    // - nas-fail        : inspect 失敗 → skip
    const dockerFake = makeDockerServiceFake({
      listContainerNames: () =>
        Effect.succeed([
          "nas-running-sid",
          "nas-stopped-sid",
          "nas-running-nosid",
          "nas-fail",
        ]),
      inspect: (name) => {
        switch (name) {
          case "nas-running-sid":
            return Effect.succeed(
              makeDetails({
                name,
                running: true,
                labels: nasAgentLabels({ [NAS_SESSION_ID_LABEL]: "sess-A" }),
              }),
            );
          case "nas-stopped-sid":
            return Effect.succeed(
              makeDetails({
                name,
                running: false,
                labels: nasAgentLabels({ [NAS_SESSION_ID_LABEL]: "sess-B" }),
              }),
            );
          case "nas-running-nosid":
            return Effect.succeed(
              makeDetails({
                name,
                running: true,
                labels: nasAgentLabels(),
              }),
            );
          case "nas-fail":
            return Effect.fail(new Error("disappeared"));
          default:
            return Effect.fail(new Error(`unexpected name ${name}`));
        }
      },
    });
    const layer = ContainerQueryServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, makeSessionUiServiceFake())),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) =>
        svc.collectRunningParentIds(),
      ).pipe(Effect.provide(layer)),
    );

    expect(result.size).toBe(1);
    expect(result.has("sess-A")).toBe(true);
    expect(result.has("sess-B")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type-level regression
// ---------------------------------------------------------------------------

// The live layer composed with default deps must close to R=never.
// This compile-time `satisfies` guards against any future change that
// silently re-introduces an unsatisfied requirement on the default
// adapter (i.e. R-leakage). If this assertion fails to compile, the
// `makeContainerQueryClient` default would also fail to provide, so we
// pin it down at the type level to surface the regression early.
const _defaultLayerClosesToNever = ContainerQueryServiceLive.pipe(
  Layer.provide(Layer.mergeAll(DockerServiceLive, SessionUiServiceLive)),
) satisfies Layer.Layer<ContainerQueryService>;
// Keep the symbol from being considered unused by tsc.
void _defaultLayerClosesToNever;

// ---------------------------------------------------------------------------
// Fake factory + plain-async client
// ---------------------------------------------------------------------------

describe("makeContainerQueryServiceFake", () => {
  test("デフォルトは全 method 空 / empty Set を返す", async () => {
    const fake = makeContainerQueryServiceFake();

    const a = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) => svc.listManaged()).pipe(
        Effect.provide(fake),
      ),
    );
    expect(a).toEqual([]);

    const b = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) =>
        svc.listManagedWithSessions(PATHS),
      ).pipe(Effect.provide(fake)),
    );
    expect(b).toEqual([]);

    const c = await Effect.runPromise(
      Effect.flatMap(ContainerQueryService, (svc) =>
        svc.collectRunningParentIds(),
      ).pipe(Effect.provide(fake)),
    );
    expect(c.size).toBe(0);
  });

  test("override で挙動を差し替えられる (plain-async client 経由)", async () => {
    const calls: string[] = [];
    const fake = makeContainerQueryServiceFake({
      collectRunningParentIds: () =>
        Effect.sync(() => {
          calls.push("collectRunningParentIds");
          return new Set<string>(["sess-x"]) as ReadonlySet<string>;
        }),
    });
    const client = makeContainerQueryClient(fake);

    const result = await client.collectRunningParentIds();
    expect(result.has("sess-x")).toBe(true);
    expect(calls).toEqual(["collectRunningParentIds"]);
  });
});
