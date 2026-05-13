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

describe("TerminalSessionService (Fake): 注入確認", () => {
  test("Fake に渡した実装で呼び出し順と引数が記録される", async () => {
    const calls: { runtimeDir: string }[] = [];

    const sample: DtachSessionInfo = {
      name: "sess-fake",
      socketPath: "/tmp/fake/sess-fake.sock",
      createdAt: 1700000000,
    };

    const fake = makeTerminalSessionServiceFake({
      listSessions: (runtimeDir) =>
        Effect.sync(() => {
          calls.push({ runtimeDir });
          return [sample];
        }),
    });

    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TerminalSessionService;
        return yield* svc.listSessions("/tmp/nas-term-fake");
      }).pipe(Effect.provide(fake)),
    );

    expect(items).toEqual([sample]);
    expect(calls).toEqual([{ runtimeDir: "/tmp/nas-term-fake" }]);
  });

  test("デフォルト Fake は空配列を返す", async () => {
    const fake = makeTerminalSessionServiceFake();
    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TerminalSessionService;
        return yield* svc.listSessions("/tmp/nas-term-fake-default");
      }).pipe(Effect.provide(fake)),
    );
    expect(items).toEqual([]);
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
