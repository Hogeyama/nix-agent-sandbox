import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
  writePendingEntry,
  writeSessionRegistry,
} from "../../lib/runtime_registry.ts";
import type { ApprovalScope, PendingEntry } from "../../network/protocol.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { resolveNetworkRuntimePaths } from "../../network/registry.ts";
import {
  makeNetworkApprovalClient,
  makeNetworkApprovalServiceFake,
  NetworkApprovalService,
  NetworkApprovalServiceLive,
} from "./service.ts";

async function withTmpPaths<T>(
  f: (paths: NetworkRuntimePaths) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-netapproval-test-"));
  try {
    const paths = await resolveNetworkRuntimePaths(dir);
    return await f(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("NetworkApprovalService (Live): listPending", () => {
  test("空の runtime では空配列を返す", async () => {
    await withTmpPaths(async (paths) => {
      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* NetworkApprovalService;
          return yield* svc.listPending(paths);
        }).pipe(Effect.provide(NetworkApprovalServiceLive)),
      );
      expect(items).toEqual([]);
    });
  });

  test("session がある場合は pending エントリを返す", async () => {
    await withTmpPaths(async (paths) => {
      // gcNetworkRuntime は broker socket が存在しないと session を stale と
      // 判定して pending も掃除する。テストでは lstat が通るダミーを置く。
      await mkdir(paths.brokersDir, { recursive: true });
      const brokerSocket = `${paths.brokersDir}/sess_ab.sock`;
      await writeFile(brokerSocket, "");
      await writeSessionRegistry(paths, {
        version: 1,
        sessionId: "sess_ab",
        tokenHash: "h",
        brokerSocket,
        profileName: "test",
        allowlist: [],
        createdAt: new Date().toISOString(),
        pid: process.pid,
        promptEnabled: false,
      });
      const now = new Date().toISOString();
      const entry: PendingEntry = {
        version: 1,
        sessionId: "sess_ab",
        requestId: "req_1",
        target: { host: "example.com", port: 443 },
        method: "CONNECT",
        requestKind: "connect",
        state: "pending",
        createdAt: now,
        updatedAt: now,
      };
      await writePendingEntry(paths, entry);

      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* NetworkApprovalService;
          return yield* svc.listPending(paths);
        }).pipe(Effect.provide(NetworkApprovalServiceLive)),
      );
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess_ab");
      expect(items[0].requestId).toBe("req_1");
    });
  });
});

describe("NetworkApprovalService (Live): approve/deny", () => {
  test("session が存在しない場合 approve は SessionNotFound で fail する", async () => {
    await withTmpPaths(async (paths) => {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* NetworkApprovalService;
            yield* svc.approve(paths, "sess_missing", "req_x");
          }).pipe(Effect.provide(NetworkApprovalServiceLive)),
        ),
      ).rejects.toThrow("Session not found: sess_missing");
    });
  });

  test("session が存在しない場合 deny は SessionNotFound で fail する", async () => {
    await withTmpPaths(async (paths) => {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* NetworkApprovalService;
            yield* svc.deny(paths, "sess_missing", "req_x");
          }).pipe(Effect.provide(NetworkApprovalServiceLive)),
        ),
      ).rejects.toThrow("Session not found: sess_missing");
    });
  });
});

describe("NetworkApprovalService (Fake): 注入確認", () => {
  test("Fake に渡した実装で呼び出しが記録される", async () => {
    type Call =
      | { kind: "list"; paths: NetworkRuntimePaths }
      | {
          kind: "approve";
          sessionId: string;
          requestId: string;
          scope?: ApprovalScope;
        }
      | {
          kind: "deny";
          sessionId: string;
          requestId: string;
          scope?: ApprovalScope;
        };
    const calls: Call[] = [];

    const fake = makeNetworkApprovalServiceFake({
      listPending: (paths) =>
        Effect.sync(() => {
          calls.push({ kind: "list", paths });
          return [];
        }),
      approve: (_paths, sessionId, requestId, scope) =>
        Effect.sync(() => {
          calls.push({ kind: "approve", sessionId, requestId, scope });
        }),
      deny: (_paths, sessionId, requestId, scope) =>
        Effect.sync(() => {
          calls.push({ kind: "deny", sessionId, requestId, scope });
        }),
    });

    const paths = await resolveNetworkRuntimePaths("/tmp/nas-fake-path");
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* NetworkApprovalService;
        yield* svc.listPending(paths);
        yield* svc.approve(paths, "sess_1", "req_a", "host-port");
        yield* svc.deny(paths, "sess_2", "req_b");
      }).pipe(Effect.provide(fake)),
    );

    expect(calls).toEqual([
      { kind: "list", paths },
      {
        kind: "approve",
        sessionId: "sess_1",
        requestId: "req_a",
        scope: "host-port",
      },
      {
        kind: "deny",
        sessionId: "sess_2",
        requestId: "req_b",
        scope: undefined,
      },
    ]);
  });

  test("デフォルト Fake は空配列と void を返す", async () => {
    const fake = makeNetworkApprovalServiceFake();
    const paths = await resolveNetworkRuntimePaths("/tmp/nas-fake-default");
    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* NetworkApprovalService;
        const items = yield* svc.listPending(paths);
        yield* svc.approve(paths, "s", "r");
        yield* svc.deny(paths, "s", "r");
        return items;
      }).pipe(Effect.provide(fake)),
    );
    expect(items).toEqual([]);
  });
});

describe("makeNetworkApprovalClient (plain async adapter)", () => {
  test("渡した Layer 経由で service を呼べる", async () => {
    const calls: string[] = [];
    const fake = makeNetworkApprovalServiceFake({
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
    const client = makeNetworkApprovalClient(fake);
    const paths = await resolveNetworkRuntimePaths("/tmp/nas-client-test");

    const items = await client.listPending(paths);
    await client.approve(paths, "sess_z", "req_z");

    expect(items).toEqual([]);
    expect(calls).toEqual(["list", "approve:sess_z"]);
  });
});
