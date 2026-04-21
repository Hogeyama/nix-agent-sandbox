import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { appendAuditLog } from "../../audit/store.ts";
import type { AuditLogEntry, AuditLogFilter } from "../../audit/types.ts";
import {
  AuditQueryService,
  AuditQueryServiceLive,
  makeAuditQueryClient,
  makeAuditQueryServiceFake,
} from "./service.ts";

async function withTmpDir<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-auditquery-test-"));
  try {
    return await f(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: "2026-03-28T12:00:00Z",
    domain: "network",
    sessionId: "sess-1",
    requestId: "req-1",
    decision: "allow",
    reason: "matched allowlist",
    ...overrides,
  };
}

describe("AuditQueryService (Live): query", () => {
  test("空の auditDir では空配列を返す", async () => {
    await withTmpDir(async (dir) => {
      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* AuditQueryService;
          return yield* svc.query(dir, {});
        }).pipe(Effect.provide(AuditQueryServiceLive)),
      );
      expect(items).toEqual([]);
    });
  });

  test("appendAuditLog で書いた entry を取得できる", async () => {
    await withTmpDir(async (dir) => {
      const e1 = makeEntry({
        timestamp: "2026-03-28T09:00:00Z",
        sessionId: "sess-a",
        domain: "network",
      });
      const e2 = makeEntry({
        timestamp: "2026-03-28T10:00:00Z",
        sessionId: "sess-b",
        domain: "hostexec",
      });
      const e3 = makeEntry({
        timestamp: "2026-03-28T11:00:00Z",
        sessionId: "sess-c",
        domain: "network",
      });
      await appendAuditLog(e1, dir);
      await appendAuditLog(e2, dir);
      await appendAuditLog(e3, dir);

      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* AuditQueryService;
          return yield* svc.query(dir, {});
        }).pipe(Effect.provide(AuditQueryServiceLive)),
      );
      expect(items).toHaveLength(3);
      // chronological order (oldest first) を軽く確認
      expect(items[0].sessionId).toBe("sess-a");
      expect(items[1].sessionId).toBe("sess-b");
      expect(items[2].sessionId).toBe("sess-c");
    });
  });

  test("(auditDir, filter) の引数順 regression 防止 — filter が素通しする", async () => {
    // service の引数順は (auditDir, filter) だが、下位 queryAuditLogs は
    // (filter, auditDir?) と逆順。Live 実装で引数を swap し忘れると、
    // filter を auditDir と取り違えて open しにいく/空配列が返るなどの
    // 回帰が起きるため、filter が確実に queryAuditLogs の第 1 引数に
    // 渡っていることを domain filter で検証する。
    await withTmpDir(async (dir) => {
      await appendAuditLog(
        makeEntry({
          timestamp: "2026-03-28T09:00:00Z",
          sessionId: "sess-net",
          domain: "network",
        }),
        dir,
      );
      await appendAuditLog(
        makeEntry({
          timestamp: "2026-03-28T10:00:00Z",
          sessionId: "sess-hex",
          domain: "hostexec",
        }),
        dir,
      );

      const filter: AuditLogFilter = { domain: "network" };
      const items = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* AuditQueryService;
          return yield* svc.query(dir, filter);
        }).pipe(Effect.provide(AuditQueryServiceLive)),
      );
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess-net");
      expect(items[0].domain).toBe("network");
    });
  });
});

describe("AuditQueryService (Fake): 注入確認", () => {
  test("Fake に渡した実装で呼び出しが記録される", async () => {
    type Call = { auditDir: string; filter: AuditLogFilter };
    const calls: Call[] = [];

    const fake = makeAuditQueryServiceFake({
      query: (auditDir, filter) =>
        Effect.sync(() => {
          calls.push({ auditDir, filter });
          return [];
        }),
    });

    const filter: AuditLogFilter = {
      startDate: "2026-03-28",
      domain: "network",
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* AuditQueryService;
        yield* svc.query("/tmp/nas-audit-fake", filter);
      }).pipe(Effect.provide(fake)),
    );

    expect(calls).toEqual([{ auditDir: "/tmp/nas-audit-fake", filter }]);
  });

  test("デフォルト Fake は空配列を返す", async () => {
    const fake = makeAuditQueryServiceFake();
    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* AuditQueryService;
        return yield* svc.query("/tmp/nas-audit-fake-default", {});
      }).pipe(Effect.provide(fake)),
    );
    expect(items).toEqual([]);
  });
});

describe("makeAuditQueryClient (plain async adapter)", () => {
  test("渡した Layer 経由で service を呼べる", async () => {
    const calls: { auditDir: string; filter: AuditLogFilter }[] = [];
    const fake = makeAuditQueryServiceFake({
      query: (auditDir, filter) =>
        Effect.sync(() => {
          calls.push({ auditDir, filter });
          return [];
        }),
    });
    const client = makeAuditQueryClient(fake);

    const filter: AuditLogFilter = { startDate: "2026-04-01" };
    const items = await client.query("/tmp/nas-audit-client-test", filter);

    expect(items).toEqual([]);
    expect(calls).toEqual([{ auditDir: "/tmp/nas-audit-client-test", filter }]);
  });
});
