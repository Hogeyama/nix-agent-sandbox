# 承認保留の購読コマンド 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nas network watch` / `nas hostexec watch` を追加し、承認保留の発生と消滅を JSON Lines で購読できるようにする。

**Architecture:** 差分計算を純粋関数として `src/cli/approval_watch.ts` に置き、監視ループは `listPending` / sleep / 書き出し先を引数で受け取る。既存の `handleApprovalSubcommand` に `watch` ケースを 1 つ足すことで network と hostexec の両方へ同時に効かせる。

**Tech Stack:** Bun / TypeScript / bun:test

## Global Constraints

- 設計は `docs/superpowers/specs/2026-09-16-approval-watch-design.md` に従う。
- 実装者とレビュアーは以下を読むこと: `.claude/skills/effect-separation/SKILL.md`、`.claude/skills/security-constraints/SKILL.md`、`.claude/skills/test-policy/SKILL.md`。
- ランタイムは Bun。`bun:test` を使う。Deno API は存在しない。
- unit テストのファイル名は `*_test.ts`。`*integration_test.ts` にすると unit レーンから外れる。
- ポーリング間隔は 1 秒固定。設定フラグを作らない。
- stdout は JSON Lines 専用。警告と診断は stderr へ出す。
- モジュールレベルの `let` と副作用は禁止。
- テストは `bun run test:unit` で通ること。

---

### Task 1: 差分計算の純粋関数

**Files:**
- Create: `src/cli/approval_watch.ts`
- Test: `src/cli/approval_watch_test.ts`

**Interfaces:**
- Consumes: `PendingItem` (`src/cli/approval_command.ts` の既存 export)
- Produces: `WatchEvent`、`PendingSnapshotEntry`、`pendingKey()`、`structuredOf()`、`diffPending()`

- [ ] **Step 1: 失敗するテストを書く**

`src/cli/approval_watch_test.ts`:

```typescript
import { expect, test } from "bun:test";
import type { PendingItem } from "./approval_command.ts";
import { diffPending, type PendingSnapshotEntry } from "./approval_watch.ts";

function item(
  sessionId: string,
  requestId: string,
  structured?: Record<string, unknown>,
): PendingItem {
  return { sessionId, requestId, displayLine: "", structured };
}

function emptyState(): Map<string, PendingSnapshotEntry> {
  return new Map();
}

test("diffPending emits added for every entry of the first snapshot", () => {
  const { events, nextState } = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1", { sessionId: "sess_a", requestId: "req_1", ruleId: "gcloud" }),
    item("sess_a", "req_2", { sessionId: "sess_a", requestId: "req_2", ruleId: "gpg-git-sign" }),
  ]);

  expect(events).toEqual([
    {
      event: "added",
      domain: "hostexec",
      entry: { sessionId: "sess_a", requestId: "req_1", ruleId: "gcloud" },
    },
    {
      event: "added",
      domain: "hostexec",
      entry: { sessionId: "sess_a", requestId: "req_2", ruleId: "gpg-git-sign" },
    },
  ]);
  expect(nextState.size).toBe(2);
});

test("diffPending emits nothing when the snapshot is unchanged", () => {
  const first = diffPending("network", emptyState(), [item("sess_a", "req_1")]);
  const second = diffPending("network", first.nextState, [item("sess_a", "req_1")]);

  expect(second.events).toEqual([]);
});

test("diffPending emits removed for entries that disappeared", () => {
  const first = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
    item("sess_b", "req_2"),
  ]);
  const second = diffPending("hostexec", first.nextState, [item("sess_b", "req_2")]);

  expect(second.events).toEqual([
    { event: "removed", domain: "hostexec", sessionId: "sess_a", requestId: "req_1" },
  ]);
  expect(second.nextState.size).toBe(1);
});

test("diffPending emits removed before added within one tick", () => {
  const first = diffPending("hostexec", emptyState(), [item("sess_a", "req_1")]);
  const second = diffPending("hostexec", first.nextState, [item("sess_a", "req_2")]);

  expect(second.events.map((e) => e.event)).toEqual(["removed", "added"]);
});

test("diffPending falls back to the id pair when an item carries no structured payload", () => {
  const { events } = diffPending("network", emptyState(), [item("sess_a", "req_1")]);

  expect(events).toEqual([
    {
      event: "added",
      domain: "network",
      entry: { sessionId: "sess_a", requestId: "req_1" },
    },
  ]);
});

test("diffPending distinguishes the same requestId across sessions", () => {
  const { nextState } = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
    item("sess_b", "req_1"),
  ]);

  expect(nextState.size).toBe(2);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/cli/approval_watch_test.ts`
Expected: FAIL（`Cannot find module './approval_watch.ts'`）

- [ ] **Step 3: 最小実装を書く**

`src/cli/approval_watch.ts`:

```typescript
/**
 * 承認保留の購読 — pending スナップショットの差分計算と監視ループ。
 *
 * 差分計算は純粋関数に保ち、ループ側は listPending / sleep / 書き出し先を
 * 引数で受け取る。実時間とファイルシステムなしで両方を検証できる。
 */

import type { PendingItem } from "./approval_command.ts";

/** 購読が流す 1 行。 */
export type WatchEvent =
  | {
      readonly event: "added";
      readonly domain: string;
      readonly entry: Record<string, unknown>;
    }
  | {
      readonly event: "removed";
      readonly domain: string;
      readonly sessionId: string;
      readonly requestId: string;
    };

/** 前回スナップショットに残す最小限。removed の組み立てに使う。 */
export interface PendingSnapshotEntry {
  readonly sessionId: string;
  readonly requestId: string;
}

/** requestId はセッションをまたぐと衝突しうるので、両方で識別する。 */
export function pendingKey(sessionId: string, requestId: string): string {
  return `${sessionId}/${requestId}`;
}

/**
 * `pending --format json` と同じ構造を返す。両コマンドで形が違うと
 * クライアントがパーサを 2 つ持つことになる。
 */
export function structuredOf(item: PendingItem): Record<string, unknown> {
  return (
    item.structured ?? {
      sessionId: item.sessionId,
      requestId: item.requestId,
    }
  );
}

export function diffPending(
  domain: string,
  prev: ReadonlyMap<string, PendingSnapshotEntry>,
  next: readonly PendingItem[],
): {
  events: WatchEvent[];
  nextState: Map<string, PendingSnapshotEntry>;
} {
  const nextState = new Map<string, PendingSnapshotEntry>();
  for (const item of next) {
    nextState.set(pendingKey(item.sessionId, item.requestId), {
      sessionId: item.sessionId,
      requestId: item.requestId,
    });
  }

  const events: WatchEvent[] = [];

  // 消滅を先に流す。クライアントが古いプロンプトを畳んでから新着を受け取る。
  for (const [key, entry] of prev) {
    if (nextState.has(key)) continue;
    events.push({
      event: "removed",
      domain,
      sessionId: entry.sessionId,
      requestId: entry.requestId,
    });
  }

  // next は listPendingEntries が createdAt 昇順で返すため、その順で流れる。
  for (const item of next) {
    if (prev.has(pendingKey(item.sessionId, item.requestId))) continue;
    events.push({ event: "added", domain, entry: structuredOf(item) });
  }

  return { events, nextState };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/cli/approval_watch_test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: コミット**

```bash
git add src/cli/approval_watch.ts src/cli/approval_watch_test.ts
git commit -F <message-file>
```

コミットメッセージの題は `feat(cli): add pending approval snapshot diffing`。

---

### Task 2: 監視ループ

**Files:**
- Modify: `src/cli/approval_watch.ts`
- Test: `src/cli/approval_watch_test.ts`

**Interfaces:**
- Consumes: Task 1 の `diffPending()`、`WatchEvent`、`PendingSnapshotEntry`
- Produces: `WATCH_INTERVAL_MS`、`WatchDeps`、`runApprovalWatch(domain, sessionFilter, deps)`、`sleepAbortable(ms, signal)`

- [ ] **Step 1: 失敗するテストを書く**

`src/cli/approval_watch_test.ts` へ追記:

```typescript
import { runApprovalWatch, type WatchDeps } from "./approval_watch.ts";

interface Harness {
  readonly lines: string[];
  readonly warnings: string[];
  readonly deps: WatchDeps;
  readonly controller: AbortController;
}

/** ティックごとの listPending 結果を順に返し、尽きたら停止する。 */
function harness(ticks: Array<PendingItem[] | Error>): Harness {
  const controller = new AbortController();
  const lines: string[] = [];
  const warnings: string[] = [];
  let index = 0;
  const deps: WatchDeps = {
    listPending: async () => {
      const tick = ticks[index];
      index += 1;
      if (index >= ticks.length) controller.abort();
      if (tick instanceof Error) throw tick;
      return tick;
    },
    write: (line) => {
      lines.push(line);
    },
    warn: (message) => {
      warnings.push(message);
    },
    sleep: async () => {},
    signal: controller.signal,
  };
  return { lines, warnings, deps, controller };
}

test("runApprovalWatch writes one JSON line per event", async () => {
  const h = harness([
    [item("sess_a", "req_1", { sessionId: "sess_a", requestId: "req_1" })],
    [],
  ]);

  await runApprovalWatch("hostexec", undefined, h.deps);

  expect(h.lines).toEqual([
    '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a","requestId":"req_1"}}\n',
    '{"event":"removed","domain":"hostexec","sessionId":"sess_a","requestId":"req_1"}\n',
  ]);
});

test("runApprovalWatch keeps polling after a failed tick", async () => {
  const h = harness([
    new Error("runtime dir vanished"),
    [item("sess_a", "req_1", { sessionId: "sess_a", requestId: "req_1" })],
  ]);

  await runApprovalWatch("network", undefined, h.deps);

  expect(h.warnings).toEqual(["[nas] network watch: runtime dir vanished"]);
  expect(h.lines).toHaveLength(1);
});

test("runApprovalWatch applies the session filter", async () => {
  const h = harness([
    [
      item("sess_a", "req_1", { sessionId: "sess_a", requestId: "req_1" }),
      item("sess_b", "req_2", { sessionId: "sess_b", requestId: "req_2" }),
    ],
  ]);

  await runApprovalWatch("hostexec", "sess_b", h.deps);

  expect(h.lines).toEqual([
    '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_b","requestId":"req_2"}}\n',
  ]);
});

test("runApprovalWatch returns without polling when already aborted", async () => {
  const h = harness([[item("sess_a", "req_1")]]);
  h.controller.abort();

  await runApprovalWatch("hostexec", undefined, h.deps);

  expect(h.lines).toEqual([]);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/cli/approval_watch_test.ts`
Expected: FAIL（`runApprovalWatch is not a function`）

- [ ] **Step 3: 最小実装を書く**

`src/cli/approval_watch.ts` へ追記:

```typescript
/** 人間が承認を待つ用途では十分速く、空ディレクトリの readdir は無視できる。 */
export const WATCH_INTERVAL_MS = 1000;

export interface WatchDeps {
  readonly listPending: () => Promise<PendingItem[]>;
  readonly write: (line: string) => void;
  readonly warn: (message: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
}

/** 中断されたら待たずに返る。終了要求から実際の停止までを間隔分待たせない。 */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 停止要求まで pending を監視し続ける。
 *
 * 1 回のポーリング失敗で購読を切らない。ここで終了すると、一時的な
 * ファイルシステムエラーでエージェントが承認タイムアウトまで停止する。
 */
export async function runApprovalWatch(
  domain: string,
  sessionFilter: string | undefined,
  deps: WatchDeps,
): Promise<void> {
  let state = new Map<string, PendingSnapshotEntry>();

  while (!deps.signal.aborted) {
    try {
      const items = await deps.listPending();
      const scoped = sessionFilter
        ? items.filter((item) => item.sessionId === sessionFilter)
        : items;
      const { events, nextState } = diffPending(domain, state, scoped);
      state = nextState;
      for (const event of events) {
        deps.write(`${JSON.stringify(event)}\n`);
      }
    } catch (err) {
      deps.warn(`[nas] ${domain} watch: ${(err as Error).message}`);
    }

    if (deps.signal.aborted) break;
    await deps.sleep(WATCH_INTERVAL_MS);
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/cli/approval_watch_test.ts`
Expected: PASS（10 tests）

- [ ] **Step 5: コミット**

```bash
git add src/cli/approval_watch.ts src/cli/approval_watch_test.ts
git commit -F <message-file>
```

コミットメッセージの題は `feat(cli): add the pending approval watch loop`。

---

### Task 3: CLI への配線

**Files:**
- Modify: `src/cli/approval_command.ts`
- Modify: `src/cli/hostexec.ts`
- Test: `src/cli/approval_command_test.ts`

**Interfaces:**
- Consumes: Task 2 の `runApprovalWatch()`、`sleepAbortable()`、`WATCH_INTERVAL_MS`
- Produces: `handleApprovalSubcommand(adapter, sub, nasArgs, deps?)` が `watch` を処理する。`deps` は `{ signal?: AbortSignal; write?: (line: string) => void }`

`deps` は呼び出し側が中断と出力先を持ち込むための引数で、テスト専用の抜け穴ではない。production の `network.ts` / `hostexec.ts` は渡さず、内部で SIGINT / SIGTERM / EPIPE を購読する。テストがプロセス全体のシグナルを発火させずに済むのは副産物である。

- [ ] **Step 1: 失敗するテストを書く**

`src/cli/approval_command_test.ts` へ追記。既存ファイルのアダプタ生成ヘルパに合わせること。

```typescript
test("handleApprovalSubcommand streams watch events until the caller aborts", async () => {
  const controller = new AbortController();
  const written: string[] = [];
  let calls = 0;

  const adapter: ApprovalAdapter = {
    domain: "hostexec",
    scopeOptions: ["once", "capability"],
    listPending: async () => {
      calls += 1;
      if (calls >= 2) controller.abort();
      return calls === 1
        ? [
            {
              sessionId: "sess_a",
              requestId: "req_1",
              displayLine: "",
              structured: { sessionId: "sess_a", requestId: "req_1" },
            },
          ]
        : [];
    },
    sendDecision: async () => {},
  };

  const handled = await handleApprovalSubcommand(adapter, "watch", ["watch"], {
    signal: controller.signal,
    write: (line) => {
      written.push(line);
    },
  });

  expect(handled).toBe(true);
  expect(written).toEqual([
    '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a","requestId":"req_1"}}\n',
    '{"event":"removed","domain":"hostexec","sessionId":"sess_a","requestId":"req_1"}\n',
  ]);
});

test("handleApprovalSubcommand passes --session through to watch", async () => {
  const controller = new AbortController();
  const written: string[] = [];

  const adapter: ApprovalAdapter = {
    domain: "network",
    scopeOptions: [],
    listPending: async () => {
      controller.abort();
      return [
        { sessionId: "sess_a", requestId: "req_1", displayLine: "" },
        { sessionId: "sess_b", requestId: "req_2", displayLine: "" },
      ];
    },
    sendDecision: async () => {},
  };

  await handleApprovalSubcommand(adapter, "watch", ["watch", "--session", "sess_b"], {
    signal: controller.signal,
    write: (line) => {
      written.push(line);
    },
  });

  expect(written).toEqual([
    '{"event":"added","domain":"network","entry":{"sessionId":"sess_b","requestId":"req_2"}}\n',
  ]);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/cli/approval_command_test.ts`
Expected: FAIL（`handled` が `false` で返る）

- [ ] **Step 3: watch ケースを実装する**

`src/cli/approval_command.ts` の import に追加:

```typescript
import {
  runApprovalWatch,
  sleepAbortable,
  structuredOf,
} from "./approval_watch.ts";
```

`pending` ブランチの JSON 出力を `structuredOf` へ差し替える（`item.structured ?? {...}` の重複を消す）:

```typescript
    if (hasFormatJson(nasArgs)) {
      console.log(JSON.stringify(items.map(structuredOf)));
      return true;
    }
```

シグネチャへ任意の `deps` を足す:

```typescript
/** 呼び出し側が中断と出力先を持ち込むための引数。watch だけが参照する。 */
export interface ApprovalSubcommandDeps {
  readonly signal?: AbortSignal;
  readonly write?: (line: string) => void;
}

export async function handleApprovalSubcommand(
  adapter: ApprovalAdapter,
  sub: string | undefined,
  nasArgs: string[],
  deps: ApprovalSubcommandDeps = {},
): Promise<boolean> {
```

`pending` ブランチの直後に watch ケースを追加する:

```typescript
  if (sub === "watch") {
    const sessionFilter = getFlagValue(nasArgs, "--session") ?? undefined;
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // クライアントが読み口を閉じたら止まる。EPIPE を警告として流し続けない。
    process.stdout.once("error", stop);
    if (deps.signal) {
      if (deps.signal.aborted) stop();
      else deps.signal.addEventListener("abort", stop, { once: true });
    }

    const write =
      deps.write ??
      ((line: string) => {
        try {
          process.stdout.write(line);
        } catch {
          stop();
        }
      });

    try {
      await runApprovalWatch(adapter.domain, sessionFilter, {
        listPending: () => adapter.listPending(),
        write,
        warn: (message) => {
          console.error(message);
        },
        sleep: (ms) => sleepAbortable(ms, controller.signal),
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.off("error", stop);
      deps.signal?.removeEventListener("abort", stop);
    }
    return true;
  }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/cli/approval_command_test.ts`
Expected: PASS

- [ ] **Step 5: hostexec の構造化ペイロードに createdAt を足す**

`src/cli/hostexec.ts` の `structured` に 1 行追加する。network 側は既に `createdAt` を持っており、揃っていない。

```typescript
            structured: {
              sessionId: item.sessionId,
              requestId: item.requestId,
              ruleId: item.ruleId,
              cwd: item.cwd,
              argv0: item.argv0,
              args: item.args,
              createdAt: item.createdAt,
            },
```

- [ ] **Step 6: hostexec のサブコマンド判定を共通ヘルパへ寄せる**

`src/cli/hostexec.ts:15` の `nasArgs.find((arg) => !arg.startsWith("-"))` は、フラグの値をサブコマンド名と取り違える。`--session` を足すと `nas hostexec --session sess_a watch` が `sess_a` をサブコマンドとして扱う。network が既に使っている `findFirstNonFlagArg` へ寄せる。

import に追加:

```typescript
import { findFirstNonFlagArg, getFlagValue, removeFirstOccurrence } from "./helpers.ts";
```

判定を差し替える:

```typescript
  const sub = findFirstNonFlagArg(nasArgs);
```

- [ ] **Step 7: 判定の差し替えを検証する**

`src/cli/hostexec.ts` に対応するテストが無ければ `src/cli/helpers_test.ts` の既存テストで `findFirstNonFlagArg` の挙動を確認する。以下を `src/cli/approval_command_test.ts` へ追記して、フラグ値がサブコマンドとして拾われないことを固定する。

```typescript
test("findFirstNonFlagArg skips --session and its value", () => {
  expect(findFirstNonFlagArg(["--session", "sess_a", "watch"])).toBe("watch");
  expect(findFirstNonFlagArg(["watch", "--session", "sess_a"])).toBe("watch");
});
```

Run: `bun test src/cli/approval_command_test.ts`
Expected: PASS

- [ ] **Step 8: 実ファイル経由の経路を 1 本だけ固定する**

spec が「runtime dir が存在しない状態での起動を正常系として扱う」と定めている。これは `listHostExecPendingEntries` の ENOENT 耐性に依存しており、依存先が変わったら壊れる。`src/cli/approval_watch_test.ts` へ追記する。

```typescript
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveHostExecRuntimePaths } from "../hostexec/registry.ts";
import { listHostExecPendingEntries } from "../hostexec/registry.ts";

test("runApprovalWatch over a real runtime dir tolerates a missing pending tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-watch-"));
  try {
    const paths = await resolveHostExecRuntimePaths(path.join(root, "absent"));
    const controller = new AbortController();
    const lines: string[] = [];
    const warnings: string[] = [];
    let ticks = 0;

    await runApprovalWatch("hostexec", undefined, {
      listPending: async () => {
        ticks += 1;
        if (ticks >= 2) controller.abort();
        const items = await listHostExecPendingEntries(paths);
        return items.map((entry) => ({
          sessionId: entry.sessionId,
          requestId: entry.requestId,
          displayLine: "",
        }));
      },
      write: (line) => {
        lines.push(line);
      },
      warn: (message) => {
        warnings.push(message);
      },
      sleep: async () => {},
      signal: controller.signal,
    });

    expect(lines).toEqual([]);
    expect(warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("runApprovalWatch over a real runtime dir reports a written pending entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-watch-"));
  try {
    const paths = await resolveHostExecRuntimePaths(root);
    await mkdir(path.join(paths.pendingDir, "sess_a1"), { recursive: true });
    await writeFile(
      path.join(paths.pendingDir, "sess_a1", "req_1.json"),
      JSON.stringify({
        sessionId: "sess_a1",
        requestId: "req_1",
        createdAt: "2026-09-16T04:12:03.114Z",
        ruleId: "gcloud",
        cwd: root,
        argv0: "gcloud",
        args: [],
      }),
    );

    const controller = new AbortController();
    const lines: string[] = [];

    await runApprovalWatch("hostexec", undefined, {
      listPending: async () => {
        controller.abort();
        const items = await listHostExecPendingEntries(paths);
        return items.map((entry) => ({
          sessionId: entry.sessionId,
          requestId: entry.requestId,
          displayLine: "",
        }));
      },
      write: (line) => {
        lines.push(line);
      },
      warn: () => {},
      sleep: async () => {},
      signal: controller.signal,
    });

    expect(lines).toEqual([
      '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a1","requestId":"req_1"}}\n',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
```

`resolveHostExecRuntimePaths` の実際の署名と `HostExecRuntimePaths` のフィールド名（`pendingDir` など）は実装時に `src/hostexec/registry.ts` と `src/lib/runtime_registry.ts` で確認し、違っていれば合わせる。gc が temp dir の外へ触れないことも確認する。

Run: `bun test src/cli/approval_watch_test.ts`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add src/cli/approval_command.ts src/cli/hostexec.ts src/cli/approval_command_test.ts src/cli/approval_watch_test.ts
git commit -F <message-file>
```

コミットメッセージの題は `feat(cli): expose pending approvals as a watch subcommand`。

---

### Task 4: ACP モードの NAS_SESSION_ID 検証

**Files:**
- Modify: `src/cli/acp.ts`
- Test: `src/cli/acp_test.ts`

**Interfaces:**
- Consumes: `isReapableSessionId()`（`src/cli/acp_reaper.ts` の既存 export）
- Produces: なし（`validateAcpInvocation` の挙動追加）

- [ ] **Step 1: 失敗するテストを書く**

`src/cli/acp_test.ts` へ追記。既存テストのプロファイル生成ヘルパに合わせること。

```typescript
test("validateAcpInvocation rejects a NAS_SESSION_ID the reaper cannot clean up", () => {
  expect(() =>
    validateAcpInvocation(acpProfile(), [], { NAS_SESSION_ID: "emacs-proj" }, false),
  ).toThrow(/NAS_SESSION_ID/);
});

test("validateAcpInvocation accepts a generated-shape NAS_SESSION_ID", () => {
  expect(() =>
    validateAcpInvocation(acpProfile(), [], { NAS_SESSION_ID: "sess_a1b2c3" }, false),
  ).not.toThrow();
});

test("validateAcpInvocation ignores an unset or empty NAS_SESSION_ID", () => {
  expect(() => validateAcpInvocation(acpProfile(), [], {}, false)).not.toThrow();
  expect(() =>
    validateAcpInvocation(acpProfile(), [], { NAS_SESSION_ID: "" }, false),
  ).not.toThrow();
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/cli/acp_test.ts`
Expected: FAIL（1 本目が throw しない）

- [ ] **Step 3: 検証を実装する**

`src/cli/acp.ts` の import に追加:

```typescript
import { isReapableSessionId } from "./acp_reaper.ts";
```

`stdinIsTTY` の判定の後、`extraArgs` の判定の前に挿入する:

```typescript
  const sessionId = env.NAS_SESSION_ID;
  if (sessionId && !isReapableSessionId(sessionId))
    throw new Error(
      `NAS_SESSION_ID must look like sess_<hex>; got "${sessionId}". ` +
        "The ACP session reaper only removes Docker resources named by a generated session id, " +
        "so any other value leaks the sidecar, network and volumes when the client kills nas.",
    );
```

空文字を弾かないのは、`src/cli.ts:314` が空文字を未指定と同じに扱って id を生成するため。

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/cli/acp_test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/cli/acp.ts src/cli/acp_test.ts
git commit -F <message-file>
```

コミットメッセージの題は `fix(claude): reject a NAS_SESSION_ID the ACP reaper would skip`。

---

### Task 5: usage とドキュメント

**Files:**
- Modify: `src/cli/usage.ts`
- Modify: `docs-site/src/content/docs/configuration/acp.md`

**Interfaces:**
- Consumes: Task 3 の CLI 挙動、Task 4 の検証
- Produces: なし

- [ ] **Step 1: usage を更新する**

`src/cli/usage.ts:14-15` のコマンド行に `watch` を入れる:

```
  nas network [pending|approve|deny|review|watch|gc|bind|unbind|forward|unforward]
  nas hostexec [pending|approve|deny|review|watch|test] [options]
```

`:75` と `:102` の付近にあるサブコマンド説明へ追記する。network 側:

```
  watch           承認要求の発生と消滅を JSON Lines で流し続ける
```

hostexec 側にも同じ行を足す。オプション説明に追記:

```
  --session ID          watch の対象セッションを 1 つに限定する
```

`:126` 付近の例に追記:

```
  nas hostexec watch                     # Stream pending approvals as JSON Lines
  nas hostexec watch --session sess_a1b2 # Stream one session only
```

- [ ] **Step 2: usage の変更を確認する**

Run: `bun run src/../main.ts --help 2>&1 | head -40`
Expected: `watch` を含む行が表示される

- [ ] **Step 3: acp.md に承認購読の節を追加する**

`docs-site/src/content/docs/configuration/acp.md` の「クライアントと MCP の境界」の前に節を追加する。内容は次を満たすこと。

- ACP セッション中の Claude 自身のツール許可は adapter が ACP のプロトコルで流すため、クライアントの承認画面に出る。
- nas 自身の承認（hostexec のホスト実行、network の未許可ドメイン）はプロトコルに乗らない。デスクトップ通知、Web UI、CLI のいずれかで処理する。
- 通知も Web UI も使わない場合は `nas hostexec watch` と `nas network watch` で購読する。出力は JSON Lines で、`added` と `removed` の 2 種類。
- 承認と拒否は `nas hostexec approve <session> <request> [--scope once|capability]` と `nas network approve <session> <request> [--scope once|rule|host-port|host|violation]`、拒否は `deny`。
- どちらもホスト側で、nas を起動したのと同じユーザーとして実行する。コンテナ内からは使えない。
- 処理しないまま `timeoutSeconds`（既定 300 秒）が過ぎると deny になり、エージェントはそれまで停止する。
- クライアントが起動時に `NAS_SESSION_ID` を指定すれば、そのセッションの承認だけを `--session` で拾える。値は `sess_` に続く十六進で、ACP モードではこの形式以外を起動時に拒否する。reaper が生成形式の id でしか Docker リソースを回収しないため。

出力例を 1 つ載せる:

```json
{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a1b2c3","requestId":"req_7","ruleId":"gcloud","cwd":"/home/u/proj","argv0":"gcloud","args":["auth","print-access-token"],"createdAt":"2026-09-16T04:12:03.114Z"}}
{"event":"removed","domain":"hostexec","sessionId":"sess_a1b2c3","requestId":"req_7"}
```

「非対応の設定」の表にも `NAS_SESSION_ID` の形式制約を 1 行足す。

- [ ] **Step 4: 最終確認**

Run: `bun run check && bun run test:unit`
Expected: 型エラーなし、unit が全て PASS

- [ ] **Step 5: コミット**

```bash
git add src/cli/usage.ts docs-site/src/content/docs/configuration/acp.md
git commit -F <message-file>
```

コミットメッセージの題は `docs(acp): document how to subscribe to pending approvals`。
