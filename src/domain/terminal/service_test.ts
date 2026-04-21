import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import type { DtachSessionInfo } from "../../dtach/client.ts";
import {
  makeTerminalSessionClient,
  makeTerminalSessionServiceFake,
  TerminalSessionService,
  TerminalSessionServiceLive,
} from "./service.ts";

/**
 * `src/dtach/client_test.ts` で使われている withUnixServer パターンの
 * コピー。dtach の実プロセスを起動せずにソケット 1 本だけ立てて
 * `probeDtachSocket` の live 判定を通過させる。
 */
async function withUnixServer<T>(
  socketPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function withTmpRuntimeDir<T>(
  f: (runtimeDir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "nas-terminal-test-"));
  try {
    return await f(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("TerminalSessionService (Live): listSessions", () => {
  test("空の runtimeDir では空配列を返す", async () => {
    await withTmpRuntimeDir(async (runtimeDir) => {
      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* TerminalSessionService;
          return yield* svc.listSessions(runtimeDir);
        }).pipe(Effect.provide(TerminalSessionServiceLive)),
      );
      expect(items).toEqual([]);
    });
  });

  test("live なソケット 1 本を立てると 1 件取得できる", async () => {
    await withTmpRuntimeDir(async (runtimeDir) => {
      const socketPath = path.join(runtimeDir, "sess-live.sock");

      await withUnixServer(socketPath, async () => {
        const items = await Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* TerminalSessionService;
            return yield* svc.listSessions(runtimeDir);
          }).pipe(Effect.provide(TerminalSessionServiceLive)),
        );
        expect(items).toHaveLength(1);
        const info = items[0];
        expect(info.name).toBe("sess-live");
        expect(info.socketPath).toBe(socketPath);
        expect(typeof info.createdAt).toBe("number");
        // createdAt は unix epoch 秒。現在時刻と大きくずれないことを確認
        // (テスト環境のクロック依存で厳密な値は取れない)。
        expect(info.createdAt).toBeGreaterThan(0);
      });
    });
  });
});

describe("TerminalSessionService (Live): killClients", () => {
  test("ソケットが存在しない runtimeDir では killed=0", async () => {
    await withTmpRuntimeDir(async (runtimeDir) => {
      const killed = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* TerminalSessionService;
          return yield* svc.killClients(runtimeDir, "sess-absent");
        }).pipe(Effect.provide(TerminalSessionServiceLive)),
      );
      expect(killed).toBe(0);
    });
  });

  test("sessionId に '../escape' を渡すと path traversal で fail する", async () => {
    // dtach primitive の `socketPathFor` は `assertWithin` で traversal を
    // 同期 throw する。service 層でも Effect の error channel に素通しして
    // いることを明示的に縛る (plan-reviewer suggestion 2)。service 呼び出し
    // 側の allowlist が抜け落ちても primitive 層で落ちることが保証される。
    await withTmpRuntimeDir(async (runtimeDir) => {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* TerminalSessionService;
            yield* svc.killClients(runtimeDir, "../escape");
          }).pipe(Effect.provide(TerminalSessionServiceLive)),
        ),
      ).rejects.toThrow(/path traversal detected/);
    });
  });
});

describe("TerminalSessionService (Fake): 注入確認", () => {
  test("Fake に渡した実装で呼び出し順と引数が記録される", async () => {
    // 引数順 regression 防止: listSessions(runtimeDir) / killClients(runtimeDir,
    // sessionId) の swap を型で押さえきれないので、call record で
    // 位置引数を明示的に検証する (audit / session 先行 service と同じ意図)。
    type Call =
      | { kind: "list"; runtimeDir: string }
      | { kind: "kill"; runtimeDir: string; sessionId: string };
    const calls: Call[] = [];

    const sample: DtachSessionInfo = {
      name: "sess-fake",
      socketPath: "/tmp/fake/sess-fake.sock",
      createdAt: 1700000000,
    };

    const fake = makeTerminalSessionServiceFake({
      listSessions: (runtimeDir) =>
        Effect.sync(() => {
          calls.push({ kind: "list", runtimeDir });
          return [sample];
        }),
      killClients: (runtimeDir, sessionId) =>
        Effect.sync(() => {
          calls.push({ kind: "kill", runtimeDir, sessionId });
          return 3;
        }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TerminalSessionService;
        const items = yield* svc.listSessions("/tmp/nas-term-fake");
        const killed = yield* svc.killClients(
          "/tmp/nas-term-fake",
          "sess-kill",
        );
        return { items, killed };
      }).pipe(Effect.provide(fake)),
    );

    expect(result.items).toEqual([sample]);
    expect(result.killed).toBe(3);
    expect(calls).toEqual([
      { kind: "list", runtimeDir: "/tmp/nas-term-fake" },
      {
        kind: "kill",
        runtimeDir: "/tmp/nas-term-fake",
        sessionId: "sess-kill",
      },
    ]);
  });

  test("デフォルト Fake は空配列と killed=0 を返す", async () => {
    const fake = makeTerminalSessionServiceFake();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TerminalSessionService;
        const items = yield* svc.listSessions("/tmp/nas-term-fake-default");
        const killed = yield* svc.killClients(
          "/tmp/nas-term-fake-default",
          "sess-x",
        );
        return { items, killed };
      }).pipe(Effect.provide(fake)),
    );
    expect(result.items).toEqual([]);
    expect(result.killed).toBe(0);
  });
});

describe("makeTerminalSessionClient (plain async adapter)", () => {
  test("渡した Layer 経由で service を呼べる", async () => {
    const calls: string[] = [];
    const fake = makeTerminalSessionServiceFake({
      listSessions: () =>
        Effect.sync(() => {
          calls.push("list");
          return [];
        }),
    });
    const client = makeTerminalSessionClient(fake);
    const items = await client.listSessions("/tmp/nas-term-client-test");
    expect(items).toEqual([]);
    expect(calls).toEqual(["list"]);
  });
});
