import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import {
  type AgentLaunchSpec,
  makeSessionLaunchClient,
  makeSessionLaunchServiceFake,
  SessionLaunchService,
  SessionLaunchServiceLive,
  type ShellLaunchContainer,
} from "./service.ts";

/**
 * `src/dtach/client_test.ts` / terminal service test で使われている
 * withUnixServer パターンのコピー。dtach の実プロセスを起動せずに
 * ソケット 1 本だけ立てて `probeDtachSocket` の live 判定を通過させる。
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
  const dir = await fs.mkdtemp(path.join(tmpdir(), "nas-launch-test-"));
  try {
    return await f(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Live: error-path 系
//
// dtach primitive の happy path (実プロセス起動) は client_test.ts / integration
// test の責務。domain service 層では戦略 B として、error path が Error channel
// に素通しされることと失敗時 cleanup が走ることに絞って検証する。
// ---------------------------------------------------------------------------

describe("SessionLaunchService (Live): launchAgentSession", () => {
  test("存在しない cwd では Error channel で失敗し、socket 残骸も残らない", async () => {
    // `dtachNewSession` に bad cwd を渡すと child 起動で non-zero exit する。
    // domain service はそれを Effect の error channel 経由で返し、失敗時の
    // safeRemove(socketPath) で runtimeDir にソケットを残さない挙動を
    // 保存する。
    await withTmpRuntimeDir(async (runtimeDir) => {
      const spec: AgentLaunchSpec = {
        sessionId: "sess-badcwd",
        nasBin: "/usr/bin/true",
        nasArgs: [],
        extraArgs: ["default"],
        cwd: "/definitely/does/not/exist/for/nas/test",
      };
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionLaunchService;
            return yield* svc.launchAgentSession(runtimeDir, spec);
          }).pipe(Effect.provide(SessionLaunchServiceLive)),
        ),
      ).rejects.toThrow();

      // cleanup が走った結果、socket は残っていない。
      // (`dtachNewSession` 側の mkdir -p で runtimeDir 自体は作られるが、
      //  sess-badcwd.sock は残らない)
      const entries = await fs.readdir(runtimeDir);
      expect(entries.filter((e) => e.endsWith(".sock"))).toEqual([]);
    });
  });
});

describe("SessionLaunchService (Live): startShellSession", () => {
  test("traversal 攻撃的な parentSessionId は path traversal で fail する", async () => {
    // `dtach -n` は子シェルを background fork するため、docker exec の
    // non-zero exit は dtach 側に伝わらず dtachNewSession は成功してしまう。
    // service 層の error channel 素通し検証は、`socketPathFor` が同期 throw
    // する path traversal ケースで縛る。これで Effect.tryPromise の catch
    // が Error として Error channel に流す経路を保存する。
    //
    // parentSessionId に `/../../escape` のような path 区切り入り文字列が
    // 渡ると、内部で組み立てる `shell-/../../escape.1` が
    // `path.join(runtimeDir, "shell-/../../escape.1.sock")` で runtimeDir の
    // 外 (`../escape.1.sock`) を指すため、`assertWithin` が
    // "path traversal detected" を同期 throw する。
    await withTmpRuntimeDir(async (runtimeDir) => {
      const target: ShellLaunchContainer = {
        containerName: "nas-agent-whatever",
        parentSessionId: "/../../escape",
      };
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionLaunchService;
            return yield* svc.startShellSession(runtimeDir, target);
          }).pipe(Effect.provide(SessionLaunchServiceLive)),
        ),
      ).rejects.toThrow(/path traversal detected/);

      // runtimeDir 内にも残骸は無い。
      const entries = await fs.readdir(runtimeDir);
      expect(entries.filter((e) => e.endsWith(".sock"))).toEqual([]);
    });
  });
});

describe("SessionLaunchService (Live): removeShellSocketsForParent", () => {
  test("parentA のみ削除し parentB は残す", async () => {
    await withTmpRuntimeDir(async (runtimeDir) => {
      const sockA = path.join(runtimeDir, "shell-parentA.1.sock");
      const sockB = path.join(runtimeDir, "shell-parentB.1.sock");

      await withUnixServer(sockA, async () => {
        await withUnixServer(sockB, async () => {
          const removed = await Effect.runPromise(
            Effect.gen(function* () {
              const svc = yield* SessionLaunchService;
              return yield* svc.removeShellSocketsForParent(
                runtimeDir,
                "parentA",
              );
            }).pipe(Effect.provide(SessionLaunchServiceLive)),
          );
          expect(removed).toBe(1);

          // sockA は消え、sockB は残る。
          await expect(fs.stat(sockA)).rejects.toThrow();
          const statB = await fs.stat(sockB);
          expect(statB.isSocket()).toBe(true);
        });
      });
    });
  });

  test("malformed shell session id と traversal 的な name は silently skip する", async () => {
    // `parseShellSessionId` が null を返す name (prefix 不一致 / seq 異常) は
    // 削除対象外にするという既存 `removeShellSocketsForParent` の挙動を
    // service 経由でも維持する。
    await withTmpRuntimeDir(async (runtimeDir) => {
      const sockValid = path.join(runtimeDir, "shell-parentA.1.sock");
      const sockBare = path.join(runtimeDir, "bare-session.sock"); // prefix 違い
      const sockNoSeq = path.join(runtimeDir, "shell-parentA.sock"); // seq 欠落

      await withUnixServer(sockValid, async () => {
        await withUnixServer(sockBare, async () => {
          await withUnixServer(sockNoSeq, async () => {
            const removed = await Effect.runPromise(
              Effect.gen(function* () {
                const svc = yield* SessionLaunchService;
                return yield* svc.removeShellSocketsForParent(
                  runtimeDir,
                  "parentA",
                );
              }).pipe(Effect.provide(SessionLaunchServiceLive)),
            );
            expect(removed).toBe(1);

            // 有効な shell-parentA.1 のみ消え、他は残る。
            await expect(fs.stat(sockValid)).rejects.toThrow();
            expect((await fs.stat(sockBare)).isSocket()).toBe(true);
            expect((await fs.stat(sockNoSeq)).isSocket()).toBe(true);
          });
        });
      });
    });
  });
});

describe("SessionLaunchService (Live): removeOrphanShellSockets", () => {
  test("runningParentIds に無い parent の shell socket のみ削除", async () => {
    // docker 非依存契約: service は Set<string> を受け取るだけで、docker
    // primitive は叩かない。呼び出し側 wrapper (`cleanContainers`) が docker
    // inspect で runningParentIds を構築する責務を持つ。
    await withTmpRuntimeDir(async (runtimeDir) => {
      const sockA = path.join(runtimeDir, "shell-parentA.1.sock");
      const sockB = path.join(runtimeDir, "shell-parentB.2.sock");

      await withUnixServer(sockA, async () => {
        await withUnixServer(sockB, async () => {
          const runningParentIds = new Set(["parentA"]);
          const removed = await Effect.runPromise(
            Effect.gen(function* () {
              const svc = yield* SessionLaunchService;
              return yield* svc.removeOrphanShellSockets(
                runtimeDir,
                runningParentIds,
              );
            }).pipe(Effect.provide(SessionLaunchServiceLive)),
          );
          expect(removed).toBe(1);

          // parentA は running なので残る、parentB は削除。
          expect((await fs.stat(sockA)).isSocket()).toBe(true);
          await expect(fs.stat(sockB)).rejects.toThrow();
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Fake: 注入と default
// ---------------------------------------------------------------------------

describe("SessionLaunchService (Fake): 注入確認", () => {
  test("Fake に渡した実装で呼び出し順と引数が記録される", async () => {
    // 引数順 regression 防止: `(runtimeDir, ...)` を他順に swap しても
    // trivial test は通り得るため、call record で位置引数を明示的に
    // 検証する (先行 audit / session / terminal service と同じ意図)。
    type Call =
      | { kind: "launchAgent"; runtimeDir: string; spec: AgentLaunchSpec }
      | {
          kind: "startShell";
          runtimeDir: string;
          target: ShellLaunchContainer;
        }
      | { kind: "removeForParent"; runtimeDir: string; parentSessionId: string }
      | {
          kind: "removeOrphans";
          runtimeDir: string;
          runningParentIds: ReadonlySet<string>;
        };
    const calls: Call[] = [];

    const fake = makeSessionLaunchServiceFake({
      launchAgentSession: (runtimeDir, spec) =>
        Effect.sync(() => {
          calls.push({ kind: "launchAgent", runtimeDir, spec });
          return { sessionId: spec.sessionId };
        }),
      startShellSession: (runtimeDir, target) =>
        Effect.sync(() => {
          calls.push({ kind: "startShell", runtimeDir, target });
          return { dtachSessionId: `shell-${target.parentSessionId}.42` };
        }),
      removeShellSocketsForParent: (runtimeDir, parentSessionId) =>
        Effect.sync(() => {
          calls.push({ kind: "removeForParent", runtimeDir, parentSessionId });
          return 7;
        }),
      removeOrphanShellSockets: (runtimeDir, runningParentIds) =>
        Effect.sync(() => {
          calls.push({ kind: "removeOrphans", runtimeDir, runningParentIds });
          return 3;
        }),
    });

    const spec: AgentLaunchSpec = {
      sessionId: "sess-abc",
      nasBin: "/usr/local/bin/nas",
      nasArgs: [],
      extraArgs: ["--worktree", "main", "default"],
      cwd: "/home/user/proj",
    };
    const target: ShellLaunchContainer = {
      containerName: "nas-agent-proj",
      parentSessionId: "sess-parent",
    };
    const runningParents: ReadonlySet<string> = new Set(["parentA"]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionLaunchService;
        const launched = yield* svc.launchAgentSession("/tmp/nas-launch", spec);
        const shell = yield* svc.startShellSession("/tmp/nas-launch", target);
        const rmForParent = yield* svc.removeShellSocketsForParent(
          "/tmp/nas-launch",
          "parent-x",
        );
        const rmOrphans = yield* svc.removeOrphanShellSockets(
          "/tmp/nas-launch",
          runningParents,
        );
        return { launched, shell, rmForParent, rmOrphans };
      }).pipe(Effect.provide(fake)),
    );

    expect(result.launched).toEqual({ sessionId: "sess-abc" });
    expect(result.shell).toEqual({ dtachSessionId: "shell-sess-parent.42" });
    expect(result.rmForParent).toBe(7);
    expect(result.rmOrphans).toBe(3);
    expect(calls).toEqual([
      { kind: "launchAgent", runtimeDir: "/tmp/nas-launch", spec },
      { kind: "startShell", runtimeDir: "/tmp/nas-launch", target },
      {
        kind: "removeForParent",
        runtimeDir: "/tmp/nas-launch",
        parentSessionId: "parent-x",
      },
      {
        kind: "removeOrphans",
        runtimeDir: "/tmp/nas-launch",
        runningParentIds: runningParents,
      },
    ]);
  });

  test("デフォルト Fake は no-op / 空値を返す", async () => {
    const fake = makeSessionLaunchServiceFake();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionLaunchService;
        const launched = yield* svc.launchAgentSession("/tmp/nas-default", {
          sessionId: "sess-default",
          nasBin: "/usr/local/bin/nas",
          nasArgs: [],
          extraArgs: [],
        });
        const shell = yield* svc.startShellSession("/tmp/nas-default", {
          containerName: "nas-agent-default",
          parentSessionId: "parent-default",
        });
        const rmForParent = yield* svc.removeShellSocketsForParent(
          "/tmp/nas-default",
          "parent-default",
        );
        const rmOrphans = yield* svc.removeOrphanShellSockets(
          "/tmp/nas-default",
          new Set(),
        );
        return { launched, shell, rmForParent, rmOrphans };
      }).pipe(Effect.provide(fake)),
    );
    expect(result.launched).toEqual({ sessionId: "sess-default" });
    expect(result.shell).toEqual({ dtachSessionId: "shell-parent-default.1" });
    expect(result.rmForParent).toBe(0);
    expect(result.rmOrphans).toBe(0);
  });
});

describe("makeSessionLaunchClient (plain async adapter)", () => {
  test("渡した Layer 経由で service を呼べる", async () => {
    const calls: string[] = [];
    const fake = makeSessionLaunchServiceFake({
      removeOrphanShellSockets: () =>
        Effect.sync(() => {
          calls.push("removeOrphans");
          return 5;
        }),
    });
    const client = makeSessionLaunchClient(fake);
    const removed = await client.removeOrphanShellSockets(
      "/tmp/nas-launch-client-test",
      new Set(["parentA"]),
    );
    expect(removed).toBe(5);
    expect(calls).toEqual(["removeOrphans"]);
  });
});
