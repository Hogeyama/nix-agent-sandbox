import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { HostExecPromptScope } from "../../config/types.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";
import {
  resolveHostExecRuntimePaths,
  writeHostExecPendingEntry,
  writeHostExecSessionRegistry,
} from "../../hostexec/registry.ts";
import type { HostExecPendingEntry } from "../../hostexec/types.ts";
import {
  HostExecApprovalService,
  HostExecApprovalServiceLive,
  makeHostExecApprovalClient,
  makeHostExecApprovalServiceFake,
} from "./service.ts";

async function withTmpPaths<T>(
  f: (paths: HostExecRuntimePaths) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-hexapproval-test-"));
  try {
    const paths = await resolveHostExecRuntimePaths(dir);
    return await f(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("HostExecApprovalService (Live): listPending", () => {
  test("空の runtime では空配列を返す", async () => {
    await withTmpPaths(async (paths) => {
      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* HostExecApprovalService;
          return yield* svc.listPending(paths);
        }).pipe(Effect.provide(HostExecApprovalServiceLive)),
      );
      expect(items).toEqual([]);
    });
  });

  test("session がある場合は pending エントリを返す", async () => {
    await withTmpPaths(async (paths) => {
      // gcHostExecRuntime は broker socket が存在しないと session を stale と
      // 判定して pending も掃除する。テストでは lstat が通るダミーを置く。
      await mkdir(paths.brokersDir, { recursive: true });
      const brokerSocket = `${paths.brokersDir}/sess_ab.sock`;
      await writeFile(brokerSocket, "");
      await writeHostExecSessionRegistry(paths, {
        version: 1,
        sessionId: "sess_ab",
        brokerSocket,
        profileName: "test",
        createdAt: new Date().toISOString(),
        pid: process.pid,
      });
      const now = new Date().toISOString();
      const entry: HostExecPendingEntry = {
        version: 1,
        sessionId: "sess_ab",
        requestId: "req_1",
        approvalKey: "key_1",
        ruleId: "rule_1",
        argv0: "/usr/bin/git",
        args: ["status"],
        cwd: "/workspace",
        state: "pending",
        createdAt: now,
        updatedAt: now,
      };
      await writeHostExecPendingEntry(paths, entry);

      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* HostExecApprovalService;
          return yield* svc.listPending(paths);
        }).pipe(Effect.provide(HostExecApprovalServiceLive)),
      );
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess_ab");
      expect(items[0].requestId).toBe("req_1");
    });
  });
});

describe("HostExecApprovalService (Live): approve/deny", () => {
  test("session が存在しない場合 approve は SessionNotFound で fail する", async () => {
    await withTmpPaths(async (paths) => {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* HostExecApprovalService;
            yield* svc.approve(paths, "sess_missing", "req_x");
          }).pipe(Effect.provide(HostExecApprovalServiceLive)),
        ),
      ).rejects.toThrow("Session not found: sess_missing");
    });
  });

  test("session が存在しない場合 deny は SessionNotFound で fail する", async () => {
    await withTmpPaths(async (paths) => {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* HostExecApprovalService;
            yield* svc.deny(paths, "sess_missing", "req_x");
          }).pipe(Effect.provide(HostExecApprovalServiceLive)),
        ),
      ).rejects.toThrow("Session not found: sess_missing");
    });
  });
});

describe("HostExecApprovalService (Fake): 注入確認", () => {
  test("Fake に渡した実装で呼び出しが記録される", async () => {
    type Call =
      | { kind: "list"; paths: HostExecRuntimePaths }
      | {
          kind: "approve";
          sessionId: string;
          requestId: string;
          scope?: HostExecPromptScope;
        }
      | {
          kind: "deny";
          sessionId: string;
          requestId: string;
        };
    const calls: Call[] = [];

    const fake = makeHostExecApprovalServiceFake({
      listPending: (paths) =>
        Effect.sync(() => {
          calls.push({ kind: "list", paths });
          return [];
        }),
      approve: (_paths, sessionId, requestId, scope) =>
        Effect.sync(() => {
          calls.push({ kind: "approve", sessionId, requestId, scope });
        }),
      deny: (_paths, sessionId, requestId) =>
        Effect.sync(() => {
          calls.push({ kind: "deny", sessionId, requestId });
        }),
    });

    const paths = await resolveHostExecRuntimePaths("/tmp/nas-hex-fake-path");
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* HostExecApprovalService;
        yield* svc.listPending(paths);
        yield* svc.approve(paths, "sess_1", "req_a", "capability");
        yield* svc.deny(paths, "sess_2", "req_b");
      }).pipe(Effect.provide(fake)),
    );

    expect(calls).toEqual([
      { kind: "list", paths },
      {
        kind: "approve",
        sessionId: "sess_1",
        requestId: "req_a",
        scope: "capability",
      },
      {
        kind: "deny",
        sessionId: "sess_2",
        requestId: "req_b",
      },
    ]);
  });

  test("デフォルト Fake は空配列と void を返す", async () => {
    const fake = makeHostExecApprovalServiceFake();
    const paths = await resolveHostExecRuntimePaths(
      "/tmp/nas-hex-fake-default",
    );
    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* HostExecApprovalService;
        const items = yield* svc.listPending(paths);
        yield* svc.approve(paths, "s", "r");
        yield* svc.deny(paths, "s", "r");
        return items;
      }).pipe(Effect.provide(fake)),
    );
    expect(items).toEqual([]);
  });
});

describe("makeHostExecApprovalClient (plain async adapter)", () => {
  test("渡した Layer 経由で service を呼べる", async () => {
    const calls: string[] = [];
    const fake = makeHostExecApprovalServiceFake({
      listPending: () =>
        Effect.sync(() => {
          calls.push("list");
          return [];
        }),
      approve: (_paths, sessionId) =>
        Effect.sync(() => {
          calls.push(`approve:${sessionId}`);
        }),
    });
    const client = makeHostExecApprovalClient(fake);
    const paths = await resolveHostExecRuntimePaths("/tmp/nas-hex-client-test");

    const items = await client.listPending(paths);
    await client.approve(paths, "sess_z", "req_z");

    expect(items).toEqual([]);
    expect(calls).toEqual(["list", "approve:sess_z"]);
  });
});
