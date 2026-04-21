import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
  createSession,
  ensureSessionRuntimePaths,
  type SessionRecord,
  type SessionRuntimePaths,
  updateSessionTurn,
} from "../../sessions/store.ts";
import {
  makeSessionUiClient,
  makeSessionUiServiceFake,
  SessionUiService,
  SessionUiServiceLive,
} from "./service.ts";

async function withTmpPaths<T>(
  f: (paths: SessionRuntimePaths) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-sessionui-test-"));
  try {
    const paths = await ensureSessionRuntimePaths(path.join(dir, "sessions"));
    return await f(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("SessionUiService (Live): list", () => {
  test("空の runtime では空配列を返す", async () => {
    await withTmpPaths(async (paths) => {
      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionUiService;
          return yield* svc.list(paths);
        }).pipe(Effect.provide(SessionUiServiceLive)),
      );
      expect(items).toEqual([]);
    });
  });

  test("createSession で 2 件書いたあと 2 件取得できる", async () => {
    await withTmpPaths(async (paths) => {
      await createSession(paths, {
        sessionId: "sess_a",
        agent: "claude",
        profile: "default",
        startedAt: "2026-04-11T10:00:00.000Z",
      });
      await createSession(paths, {
        sessionId: "sess_b",
        agent: "copilot",
        profile: "default",
        startedAt: "2026-04-11T11:00:00.000Z",
      });

      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionUiService;
          return yield* svc.list(paths);
        }).pipe(Effect.provide(SessionUiServiceLive)),
      );
      // listSessions は順序を保証しないので sessionId で安定 sort する
      const sorted = [...items].sort((a, b) =>
        a.sessionId.localeCompare(b.sessionId),
      );
      expect(sorted).toHaveLength(2);
      expect(sorted[0].sessionId).toBe("sess_a");
      expect(sorted[0].agent).toBe("claude");
      expect(sorted[1].sessionId).toBe("sess_b");
      expect(sorted[1].agent).toBe("copilot");
    });
  });
});

describe("SessionUiService (Live): acknowledgeTurn", () => {
  test("存在しない sessionId では 'Session not found: <id>' で fail する", async () => {
    // api.ts の `startsWith("Session not found:")` prefix-match 契約を守る
    // ため、store.ts が投げる文字列を service が書き換えず素通ししていること
    // を完全一致で検証する。
    await withTmpPaths(async (paths) => {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionUiService;
            yield* svc.acknowledgeTurn(paths, "sess_missing");
          }).pipe(Effect.provide(SessionUiServiceLive)),
        ),
      ).rejects.toThrow("Session not found: sess_missing");
    });
  });

  test("agent-turn では 'Cannot acknowledge turn in state: agent-turn' で fail する", async () => {
    // api.ts の `startsWith("Cannot acknowledge turn in state:")` prefix-match
    // 契約を守るため、store.ts が投げる文字列を service が書き換えず素通し
    // していることを完全一致で検証する。
    await withTmpPaths(async (paths) => {
      await createSession(paths, {
        sessionId: "sess_running",
        agent: "claude",
        profile: "default",
        startedAt: "2026-04-11T10:00:00.000Z",
      });
      // user-turn -> agent-turn に遷移させる
      await updateSessionTurn(paths, "sess_running", "start");

      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionUiService;
            yield* svc.acknowledgeTurn(paths, "sess_running");
          }).pipe(Effect.provide(SessionUiServiceLive)),
        ),
      ).rejects.toThrow("Cannot acknowledge turn in state: agent-turn");
    });
  });
});

describe("SessionUiService (Live): rename", () => {
  test("引数順 (paths, sessionId, name) regression 防止 — name が実際に更新される", async () => {
    // service の引数順は (paths, sessionId, name)。store.ts の
    // updateSessionName も同順だが、Live 実装で swap してしまうと
    // name に sessionId が入ってしまう類の回帰になる。happy path を
    // 1 本書いて listSessions 経由で書き込まれた値を検証する。
    await withTmpPaths(async (paths) => {
      await createSession(paths, {
        sessionId: "sess_xx",
        agent: "claude",
        profile: "default",
        startedAt: "2026-04-11T10:00:00.000Z",
      });

      const updated = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionUiService;
          return yield* svc.rename(paths, "sess_xx", "new-name");
        }).pipe(Effect.provide(SessionUiServiceLive)),
      );
      expect(updated.sessionId).toBe("sess_xx");
      expect(updated.name).toBe("new-name");

      // 永続化も検証 (list 経由で読めること)
      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionUiService;
          return yield* svc.list(paths);
        }).pipe(Effect.provide(SessionUiServiceLive)),
      );
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess_xx");
      expect(items[0].name).toBe("new-name");
    });
  });

  test("存在しない sessionId では 'Session not found: <id>' で fail する", async () => {
    await withTmpPaths(async (paths) => {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionUiService;
            yield* svc.rename(paths, "sess_missing", "whatever");
          }).pipe(Effect.provide(SessionUiServiceLive)),
        ),
      ).rejects.toThrow("Session not found: sess_missing");
    });
  });
});

describe("SessionUiService (Fake): 注入確認", () => {
  test("Fake に渡した実装で呼び出しが記録される", async () => {
    type Call =
      | { kind: "list"; paths: SessionRuntimePaths }
      | { kind: "ack"; sessionId: string }
      | { kind: "rename"; sessionId: string; name: string };
    const calls: Call[] = [];

    const record = (sessionId: string, name?: string): SessionRecord => ({
      sessionId,
      name,
      agent: "unknown",
      profile: "unknown",
      turn: "user-turn",
      startedAt: "2026-04-11T10:00:00.000Z",
      lastEventAt: "2026-04-11T10:00:00.000Z",
    });

    const fake = makeSessionUiServiceFake({
      list: (paths) =>
        Effect.sync(() => {
          calls.push({ kind: "list", paths });
          return [];
        }),
      acknowledgeTurn: (_paths, sessionId) =>
        Effect.sync(() => {
          calls.push({ kind: "ack", sessionId });
          return record(sessionId);
        }),
      rename: (_paths, sessionId, name) =>
        Effect.sync(() => {
          calls.push({ kind: "rename", sessionId, name });
          return record(sessionId, name);
        }),
    });

    const paths: SessionRuntimePaths = {
      runtimeDir: "/tmp/nas-ses-fake",
      sessionsDir: "/tmp/nas-ses-fake/sessions",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionUiService;
        yield* svc.list(paths);
        yield* svc.acknowledgeTurn(paths, "sess_1");
        yield* svc.rename(paths, "sess_2", "hello");
      }).pipe(Effect.provide(fake)),
    );

    expect(calls).toEqual([
      { kind: "list", paths },
      { kind: "ack", sessionId: "sess_1" },
      { kind: "rename", sessionId: "sess_2", name: "hello" },
    ]);
  });

  test("デフォルト Fake は空配列とダミー record を返す", async () => {
    const fake = makeSessionUiServiceFake();
    const paths: SessionRuntimePaths = {
      runtimeDir: "/tmp/nas-ses-fake-default",
      sessionsDir: "/tmp/nas-ses-fake-default/sessions",
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionUiService;
        const items = yield* svc.list(paths);
        const acked = yield* svc.acknowledgeTurn(paths, "s");
        const renamed = yield* svc.rename(paths, "s", "n");
        return { items, acked, renamed };
      }).pipe(Effect.provide(fake)),
    );
    expect(result.items).toEqual([]);
    expect(result.acked.sessionId).toBe("s");
    expect(result.renamed.sessionId).toBe("s");
    expect(result.renamed.name).toBe("n");
  });
});

describe("makeSessionUiClient (plain async adapter)", () => {
  test("渡した Layer 経由で service を呼べる", async () => {
    const calls: string[] = [];
    const fake = makeSessionUiServiceFake({
      list: () =>
        Effect.sync(() => {
          calls.push("list");
          return [];
        }),
    });
    const client = makeSessionUiClient(fake);
    const paths: SessionRuntimePaths = {
      runtimeDir: "/tmp/nas-ses-client-test",
      sessionsDir: "/tmp/nas-ses-client-test/sessions",
    };

    const items = await client.list(paths);

    expect(items).toEqual([]);
    expect(calls).toEqual(["list"]);
  });
});
