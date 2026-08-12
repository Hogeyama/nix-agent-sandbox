# HostExec argv0 Integrity Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hostexec の LD_PRELOAD 型 argv0（絶対・相対パス）が指すホストファイルを、ブローカー起動時の baseline と実行時 content で照合し、食い違えば `allow` ルールでも承認 prompt に回す。

**Architecture:** ブローカー起動時（コンテナ起動前）に対象ファイルの `{inode, mtime, size, sha256}` を記録する。execute 要求ごとに、実行対象パスの現在の content を再計算し、baseline と比較する。不一致なら allow / 承認キャッシュの速攻経路を飛ばして pending 承認フローへ回す。あわせてコンテナ側 shadow の原因であるフォールバック bind-mount 経路と、存在理由を失うプレフィックス allowlist を削除する。

**Tech Stack:** Bun, TypeScript (strict), Effect (stage 層), Node crypto (SHA-256), Unix socket ブローカー。

## Global Constraints

- ランタイムは Bun。テスト実行は `bun test`、型チェックは `bun run check`。frontend ビルドは `bun run build-ui`。
- 事前に読むスキル: `effect-separation`（D1/D2/pure の分離。stage は orchestration のみ。primitive I/O は D1 ヘルパへ）、`test-policy`（Unit は `*_test.ts` でソース隣接・Docker 不要、Integration は `*_integration_test.ts`）、`security-constraints`（C1: シークレットをコンテナにマウントしない、C2: control socket をコンテナに露出しない — いずれも本変更で維持する）。
- テストは相対パス import。内部モジュールに import map を使わない。
- コミットは `git-commit` スキルのフォーマット。1 論理変更 1 コミット。コミット末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 日本語で書くコメント・メッセージは体言止めを避け、漢語＋スル動詞に寄せる。
- 対象は LD_PRELOAD 型 argv0（絶対・相対）のみ。bare name argv0 は検証対象外（ホスト PATH の非書き込み性に依存、design の Non-Goals）。
- baseline はブローカーのメモリ内にのみ保持する。永続化しない。

---

### Task 1: integrity モジュール（純粋判定 + D1 読み取り）

新しいモジュール `src/hostexec/integrity.ts` を作る。ファイルの integrity スナップショットを読む D1 関数と、baseline と現在値から pass/prompt を決める純粋関数を提供する。

**Files:**
- Create: `src/hostexec/integrity.ts`
- Test: `src/hostexec/integrity_test.ts`

**Interfaces:**
- Consumes: なし（Node `fs`/`crypto` のみ）
- Produces:
  - `interface FileIntegrity { readonly inode: number; readonly mtimeMs: number; readonly size: number; readonly sha256: string; }`
  - `type IntegritySnapshot = FileIntegrity | "absent";`
  - `function readFileIntegrity(filePath: string, prev?: IntegritySnapshot): Promise<IntegritySnapshot>` — D1。ファイルを stat + SHA-256。`prev` が `FileIntegrity` かつ inode+mtimeMs+size が一致すれば再ハッシュせず `prev` を返す（fast-path）。ENOENT なら `"absent"`。
  - `type IntegrityVerdict = "pass" | "prompt";`
  - `function decideIntegrity(baseline: IntegritySnapshot | undefined, current: IntegritySnapshot): IntegrityVerdict` — 純粋。

- [ ] **Step 1: `decideIntegrity` の失敗テストを書く**

`src/hostexec/integrity_test.ts` を作る:

```typescript
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decideIntegrity,
  type FileIntegrity,
  readFileIntegrity,
} from "./integrity.ts";

const fi = (over: Partial<FileIntegrity> = {}): FileIntegrity => ({
  inode: 1,
  mtimeMs: 1000,
  size: 3,
  sha256: "aaa",
  ...over,
});

test("decideIntegrity: untracked baseline (undefined) prompts", () => {
  expect(decideIntegrity(undefined, fi())).toBe("prompt");
});

test("decideIntegrity: absent baseline stays absent -> pass", () => {
  expect(decideIntegrity("absent", "absent")).toBe("pass");
});

test("decideIntegrity: absent baseline, file appeared -> prompt", () => {
  expect(decideIntegrity("absent", fi())).toBe("prompt");
});

test("decideIntegrity: file disappeared -> prompt", () => {
  expect(decideIntegrity(fi(), "absent")).toBe("prompt");
});

test("decideIntegrity: same content hash -> pass (inode/mtime ignored)", () => {
  expect(
    decideIntegrity(fi({ inode: 1, mtimeMs: 1000 }), fi({ inode: 2, mtimeMs: 9999 })),
  ).toBe("pass");
});

test("decideIntegrity: different content hash -> prompt", () => {
  expect(decideIntegrity(fi({ sha256: "aaa" }), fi({ sha256: "bbb" }))).toBe(
    "prompt",
  );
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/hostexec/integrity_test.ts`
Expected: FAIL（`integrity.ts` が存在せず import 解決に失敗）

- [ ] **Step 3: `integrity.ts` の純粋判定を実装する**

`src/hostexec/integrity.ts` を作る:

```typescript
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface FileIntegrity {
  readonly inode: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

export type IntegritySnapshot = FileIntegrity | "absent";

export type IntegrityVerdict = "pass" | "prompt";

/**
 * baseline と現在値から実行可否を決める純粋関数。
 * `baseline === undefined` は「LD_PRELOAD 対象だが起動時に snapshot していない
 * パス」を表し、確認できないので prompt に倒す。content の一致は sha256 で判定し、
 * inode/mtime の違いは（同一 content の atomic 置換など良性を許すため）無視する。
 */
export function decideIntegrity(
  baseline: IntegritySnapshot | undefined,
  current: IntegritySnapshot,
): IntegrityVerdict {
  if (baseline === undefined) return "prompt";
  if (baseline === "absent") {
    return current === "absent" ? "pass" : "prompt";
  }
  if (current === "absent") return "prompt";
  return current.sha256 === baseline.sha256 ? "pass" : "prompt";
}
```

- [ ] **Step 4: 純粋判定テストが通ることを確認する**

Run: `bun test src/hostexec/integrity_test.ts -t decideIntegrity`
Expected: PASS（6 件）

- [ ] **Step 5: `readFileIntegrity` の失敗テストを追記する**

`src/hostexec/integrity_test.ts` に追記:

```typescript
test("readFileIntegrity: reads stat + sha256 of an existing file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-integrity-"));
  try {
    const p = path.join(dir, "f.sh");
    await writeFile(p, "hello");
    const snap = await readFileIntegrity(p);
    expect(snap).not.toBe("absent");
    if (snap === "absent") return;
    expect(snap.size).toBe(5);
    // sha256("hello")
    expect(snap.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileIntegrity: returns 'absent' for a missing file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-integrity-"));
  try {
    const snap = await readFileIntegrity(path.join(dir, "nope"));
    expect(snap).toBe("absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileIntegrity: fast-path returns prev when stat is unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-integrity-"));
  try {
    const p = path.join(dir, "f.sh");
    await writeFile(p, "hello");
    const first = await readFileIntegrity(p);
    if (first === "absent") throw new Error("unexpected absent");
    // prev with the same inode/mtime/size but a bogus sha proves the fast-path
    // skipped rehashing and returned prev verbatim.
    const bogus = { ...first, sha256: "BOGUS" };
    const second = await readFileIntegrity(p, bogus);
    expect(second).toBe(bogus);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: テストが失敗することを確認する**

Run: `bun test src/hostexec/integrity_test.ts -t readFileIntegrity`
Expected: FAIL（`readFileIntegrity is not a function`）

- [ ] **Step 7: `readFileIntegrity` を実装する**

`src/hostexec/integrity.ts` に追記:

```typescript
/**
 * ファイルの integrity スナップショットを読む（D1）。
 * `prev` が与えられ inode+mtimeMs+size が一致する場合、content は変わっていないと
 * みなして再ハッシュを省き `prev` をそのまま返す（fast-path）。ファイルが無ければ
 * "absent" を返す。
 */
export async function readFileIntegrity(
  filePath: string,
  prev?: IntegritySnapshot,
): Promise<IntegritySnapshot> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  if (
    prev &&
    prev !== "absent" &&
    prev.inode === st.ino &&
    prev.mtimeMs === st.mtimeMs &&
    prev.size === st.size
  ) {
    return prev;
  }
  const content = await readFile(filePath);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { inode: st.ino, mtimeMs: st.mtimeMs, size: st.size, sha256 };
}
```

- [ ] **Step 8: 全 integrity テストが通ることを確認する**

Run: `bun test src/hostexec/integrity_test.ts`
Expected: PASS（9 件）

- [ ] **Step 9: 型チェック**

Run: `bun run check`
Expected: エラーなし

- [ ] **Step 10: コミット**

```bash
git add src/hostexec/integrity.ts src/hostexec/integrity_test.ts
git commit -F <message-file>
```

コミットメッセージ例（`git-commit` スキルに従い調整）:
```
feat(hostexec): add file integrity snapshot and verdict helpers

ホスト exec 対象ファイルの content を検証するための基盤を追加する。
readFileIntegrity は stat + SHA-256 を読み、inode/mtime/size 一致時は
再ハッシュを省く。decideIntegrity は baseline と現在値から pass/prompt を
決める純粋関数で、content 一致は sha256 で判定し inode/mtime の違いは
良性として無視する。未 snapshot のパスは確認不能として prompt に倒す。
```

---

### Task 2: ブローカーの integrity ゲート

ブローカーに baseline スナップショットと execute 時の再検証を組み込む。不一致は allow / 承認キャッシュを飛ばして pending へ回す。prompt 無効時は deny する。pending entry に「変化した事実」フラグを載せる。

**Files:**
- Modify: `src/hostexec/types.ts`（`HostExecPendingEntry` に `integrityChanged?` 追加）
- Modify: `src/hostexec/broker.ts`（options / field / snapshot / verdict / executeStreaming 統合 / toPendingEntry）
- Modify: `src/stages/hostexec/broker_service.ts`（config に `integrityTargets` を通す）
- Test: `src/hostexec/broker_integration_test.ts`（既存ハーネスに integrity ケースを追記）

**Interfaces:**
- Consumes: Task 1 の `readFileIntegrity`, `decideIntegrity`, `IntegritySnapshot`, `IntegrityVerdict`。既存 `isRelativeHostExecArgv0`（`./match.ts`）。
- Produces:
  - `HostExecBrokerOptions.integrityTargets?: readonly string[]`（ホスト絶対パス集合）
  - `HostExecBrokerConfig.integrityTargets?: readonly string[]`（broker_service）
  - `HostExecPendingEntry.integrityChanged?: boolean`

- [ ] **Step 1: pending entry 型にフラグを追加する**

`src/hostexec/types.ts` の `HostExecPendingEntry` に追記（`updatedAt` の後）:

```typescript
export interface HostExecPendingEntry {
  version: 1;
  sessionId: string;
  requestId: string;
  approvalKey: string;
  ruleId: string;
  argv0: string;
  args: string[];
  cwd: string;
  state: "pending";
  createdAt: string;
  updatedAt: string;
  /**
   * true のとき、この pending は「対象ファイルがブローカー起動時の baseline から
   * 変化した」ために allow ルールを承認へ格上げした結果である。承認 UI が
   * 「変化した事実」を提示するために使う。
   */
  integrityChanged?: boolean;
}
```

- [ ] **Step 2: 失敗する統合テストを書く（allow ルール + 差し替え -> prompt）**

`src/hostexec/broker_integration_test.ts` の末尾に以下を追記する。既存 import（`mkdtemp`, `writeFile`, `rm`, `tmpdir`, `path`, `connectUnix`, `writeJsonLine`, `HostExecBroker`, `sendHostExecBrokerRequest`, `resolveHostExecRuntimePaths`, `hostExecBrokerSocketPath`, `hostExecExecSocketPath`, `PendingListResponse`）はすべてファイル冒頭に存在するのでそのまま使う。`notify: "off"` は string リテラル（他テストと同じ）。

```typescript
test("HostExecBroker: allow rule prompts when the target file changed since start", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-integ-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const scriptPath = path.join(runtimeDir, "tool.sh");
  await writeFile(scriptPath, "#!/bin/sh\necho original\n");

  const config: HostExecConfig = {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "off",
    },
    secrets: {},
    rules: [
      {
        id: "tool",
        match: { argv0: scriptPath },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "deny",
      },
    ],
  };

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_integ",
    profileName: "test",
    notify: "off",
    workspaceRoot: runtimeDir,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: config,
    integrityTargets: [scriptPath],
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_integ");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_integ");
  await broker.start(execSocketPath, controlSocketPath);
  try {
    // 差し替え: baseline 取得後に同じパスの中身を変える
    await writeFile(scriptPath, "#!/bin/sh\necho SWAPPED\n");

    // execute を送る。allow ルールでも即実行されず承認待ちに入るため、応答は
    // 返らない（このソケットは開いたまま pending となる）。
    const execSocket = await connectUnix(execSocketPath);
    await writeJsonLine(execSocket, {
      version: 1,
      type: "execute",
      sessionId: "sess_integ",
      requestId: "req_1",
      argv0: scriptPath,
      args: [],
      cwd: runtimeDir,
      tty: false,
    });

    // control 側で pending を列挙し、integrityChanged が立つことを確認する。
    // pending 生成は非同期なので短くポーリングする。
    let hit: { requestId: string; integrityChanged?: boolean } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = (await sendHostExecBrokerRequest(controlSocketPath, {
        type: "list_pending",
      })) as PendingListResponse;
      hit = res.items.find((it) => it.requestId === "req_1");
      if (hit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hit).toBeDefined();
    expect(hit?.integrityChanged).toBe(true);

    execSocket.destroy();
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `bun test src/hostexec/broker_integration_test.ts -t "allow rule prompts when the target file changed"`
Expected: FAIL（`integrityTargets` を受け取らず検証もしないため、allow ルールが即実行され pending にならない → `pendingEntry` が undefined）

- [ ] **Step 4: ブローカーに integrityTargets と baseline を実装する**

`src/hostexec/broker.ts` の import に追記:

```typescript
import {
  decideIntegrity,
  type IntegritySnapshot,
  type IntegrityVerdict,
  readFileIntegrity,
} from "./integrity.ts";
```

`HostExecBrokerOptions` に追記:

```typescript
  /**
   * LD_PRELOAD 型 argv0 が指すホスト絶対パス集合。ブローカー起動時に各ファイルの
   * integrity を snapshot し、execute ごとに再検証する。
   */
  integrityTargets?: readonly string[];
```

クラスフィールドに追記（`maskFilter` の隣）:

```typescript
  private readonly integrityTargets: readonly string[];
  private readonly integrityBaseline = new Map<string, IntegritySnapshot>();
```

constructor に追記（`this.maskFilter = options.maskFilter;` の後）:

```typescript
    this.integrityTargets = options.integrityTargets ?? [];
```

`start()` の末尾（`this.execServer = await createUnixServer(...)` の後）に snapshot を追記:

```typescript
    // ブローカー起動時点（コンテナ起動より前）に対象ファイルの baseline を取る。
    // この時点でコンテナプロセスは存在せず、差し替えは不可能。
    for (const target of this.integrityTargets) {
      this.integrityBaseline.set(target, await readFileIntegrity(target));
    }
```

- [ ] **Step 5: `integrityVerdict` メソッドを実装する**

`src/hostexec/broker.ts` の `HostExecBroker` クラス内（`resolveRequest` の近く）に private メソッドを追加:

```typescript
  /**
   * この execute 要求が実行するホストファイルが、起動時 baseline から変化して
   * いないかを判定する。LD_PRELOAD 型 argv0（絶対・相対）のみが対象。bare name は
   * ホスト PATH 依存で対象外（design の Non-Goals）。
   */
  private async integrityVerdict(
    request: ExecuteRequest,
    resolved: ResolvedExecution,
  ): Promise<IntegrityVerdict> {
    const ruleArgv0 = resolved.rule.match.argv0;
    if (!path.isAbsolute(ruleArgv0) && !isRelativeHostExecArgv0(ruleArgv0)) {
      return "pass";
    }
    const hostPath = path.isAbsolute(request.argv0)
      ? request.argv0
      : path.resolve(resolved.cwd, request.argv0);
    const baseline = this.integrityBaseline.get(hostPath);
    const prev =
      baseline && baseline !== "absent" ? baseline : undefined;
    const current = await readFileIntegrity(hostPath, prev);
    return decideIntegrity(baseline, current);
  }
```

- [ ] **Step 6: `executeStreaming` の速攻経路に integrity ゲートを差し込む**

`src/hostexec/broker.ts` の `executeStreaming`。`const approvalKey = await buildApprovalKey(...)` の直後、現行の `if (resolved.rule.approval === "allow" || ...)` ブロックを次のように置き換える:

```typescript
    const approvalKey = await buildApprovalKey(resolved.capability);
    const integrity = await this.integrityVerdict(message, resolved);

    // 対象ファイルが起動時 baseline から変化していれば、allow ルールでも承認
    // キャッシュでも即実行させない。prompt 無効時は承認手段が無いので deny。
    if (integrity === "prompt" && !this.config.prompt.enable) {
      await this.recordAudit(
        message.requestId,
        "deny",
        "integrity-mismatch",
        commandStr,
      );
      await writeJsonLine(socket, {
        type: "error",
        requestId: message.requestId,
        message:
          "hostexec target changed since session start; approval required but prompt is disabled",
      });
      return;
    }

    if (
      integrity === "pass" &&
      (resolved.rule.approval === "allow" ||
        this.approvedKeys.has(approvalKey) ||
        !this.config.prompt.enable)
    ) {
      if (resolved.rule.approval === "prompt" && !this.config.prompt.enable) {
        await this.recordAudit(
          message.requestId,
          "deny",
          "prompt-disabled",
          commandStr,
        );
        await writeJsonLine(socket, {
          type: "error",
          requestId: message.requestId,
          message: "hostexec prompt is disabled",
        });
        return;
      }
      const reason =
        resolved.rule.approval === "allow" ? "rule-allow" : "approved-cached";
      await this.recordAudit(message.requestId, "allow", reason, commandStr);
      await this.runResolved(message, resolved, socket);
      return;
    }
```

以降の pending フロー（`const group = this.groups.get(approvalKey) ?? ...`）はそのまま。ただし entry 生成にフラグを渡すため次ステップで手を入れる。

- [ ] **Step 7: pending entry に integrityChanged を伝播する**

`executeStreaming` の pending フロー内、既存グループへの追加分岐にある `toPendingEntry(message, resolved, approvalKey, group.createdAt)` を次に変更:

```typescript
      const entry = toPendingEntry(
        message,
        resolved,
        approvalKey,
        group.createdAt,
        integrity === "prompt",
      );
```

`createPendingGroup` 呼び出しにフラグを渡す:

```typescript
    const group =
      this.groups.get(approvalKey) ??
      (await this.createPendingGroup(
        approvalKey,
        message,
        resolved,
        integrity === "prompt",
      ));
```

`createPendingGroup` のシグネチャと内部 `toPendingEntry` 呼び出しを変更:

```typescript
  private async createPendingGroup(
    approvalKey: string,
    message: ExecuteRequest,
    resolved: ResolvedExecution,
    integrityChanged: boolean,
  ): Promise<PendingGroup> {
```

その内部の `const entry = toPendingEntry(message, resolved, approvalKey, createdAt);` を:

```typescript
    const entry = toPendingEntry(
      message,
      resolved,
      approvalKey,
      createdAt,
      integrityChanged,
    );
```

モジュール末尾の `toPendingEntry` 関数にパラメータを追加:

```typescript
function toPendingEntry(
  request: ExecuteRequest,
  resolved: ResolvedExecution,
  approvalKey: string,
  createdAt: string,
  integrityChanged: boolean,
): HostExecPendingEntry {
  return {
    version: 1,
    sessionId: request.sessionId,
    requestId: request.requestId,
    approvalKey,
    ruleId: resolved.rule.id,
    argv0: request.argv0,
    args: request.args,
    cwd: resolved.cwd,
    state: "pending",
    createdAt,
    updatedAt: new Date().toISOString(),
    ...(integrityChanged ? { integrityChanged: true } : {}),
  };
}
```

- [ ] **Step 8: broker_service で integrityTargets を通す**

`src/stages/hostexec/broker_service.ts` の `HostExecBrokerConfig` に追記:

```typescript
  readonly integrityTargets?: readonly string[];
```

`new HostExecBroker({ ... })` の引数に追記（`maskFilter: config.maskFilter,` の隣）:

```typescript
              integrityTargets: config.integrityTargets,
```

- [ ] **Step 9: 統合テストが通ることを確認する**

Run: `bun test src/hostexec/broker_integration_test.ts`
Expected: PASS（既存テスト全件 + 新規 integrity テスト）

- [ ] **Step 10: 型チェック**

Run: `bun run check`
Expected: エラーなし（`integrityTargets` を stage 側でまだ渡していないが optional なので型は通る。stage 配線は Task 3）

- [ ] **Step 11: コミット**

```bash
git add src/hostexec/types.ts src/hostexec/broker.ts src/stages/hostexec/broker_service.ts src/hostexec/broker_integration_test.ts
git commit -F <message-file>
```

メッセージ例:
```
feat(hostexec): gate host exec on runtime file integrity

ブローカー起動時（コンテナ起動前）に LD_PRELOAD 型 argv0 の対象ファイルを
snapshot し、execute ごとに再検証する。baseline から変化していれば、allow
ルールでも承認キャッシュでも即実行させず承認 prompt に回す。prompt 無効時は
承認手段が無いので deny する。pending entry に integrityChanged フラグを載せ、
承認 UI が変化した事実を提示できるようにする。承認キャッシュを意図的に
バイパスするのは、差し替え後ファイルの承認を capability 単位でキャッシュすると
一度の不用意な承認で差し替えバイナリを恒久許可してしまうため。
```

---

### Task 3: stage — フォールバック削除・allowlist 撤廃・integrityTargets 配線

フォールバック bind-mount 経路を削除し、intercept ライブラリ不在時はエラーで停止する。プレフィックス allowlist を撤廃する。integrityTargets をブローカーへ配線する。

**Files:**
- Modify: `src/stages/hostexec/stage.ts`
- Test: `src/stages/hostexec/stage_test.ts`

**Interfaces:**
- Consumes: Task 2 の `HostExecBrokerConfig.integrityTargets`。既存 `interceptPaths`（`planHostExec` 内で算出済み）。
- Produces: `HostExecPlan["broker"].integrityTargets: readonly string[]`

- [ ] **Step 1: allowlist 撤廃とフォールバック削除の失敗テストを書く**

`src/stages/hostexec/stage_test.ts` を次のように変更する。

(a) 既存テスト `validateAbsoluteArgv0: rejects sensitive container paths`（`/etc/passwd` 等が throw する前提）を、撤廃後の挙動に置き換える:

```typescript
test("validateAbsoluteArgv0: allows non-system absolute paths (allowlist removed)", () => {
  for (const argv0 of [
    "/etc/passwd",
    "/home/user/.local/share/nas/tool.sh",
    "/home/user/.claude/skills/x/scripts/diffityw",
    "/opt/whatever/tool",
  ]) {
    expect(() => validateAbsoluteArgv0("r", argv0)).not.toThrow();
  }
});
```

（`validateAbsoluteArgv0: accepts allowed prefixes` と `rejects '/', trailing slash, '..', '.'` は残す。前者はリネームしてもよいが挙動は不変。）

(b) 既存 `HostExecStage plan: falls back to bind mount when interceptLibPath is null` を、エラーで停止するテストに置き換える:

```typescript
test("HostExecStage plan: throws when a relative/absolute rule has no intercept lib", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "gradlew",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "container",
    },
  ];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState({
      workspace: { workDir: "/workspace", imageName: "nas-test" },
    }),
  };
  await expect(
    planHostExec(input, { interceptLibPath: null }),
  ).rejects.toThrow(/intercept/i);
});
```

(c) integrityTargets が LD_PRELOAD 経路で埋まることのテストを追記:

```typescript
test("HostExecStage plan: broker.integrityTargets lists resolved LD_PRELOAD argv0 paths", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "abs",
      match: { argv0: "/home/user/.local/share/nas/tool.sh" },
      cwd: { mode: "any", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "deny",
    },
    {
      id: "rel",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "container",
    },
  ];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState({
      workspace: { workDir: "/workspace", imageName: "nas-test" },
    }),
  };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });
  expect(plan).not.toBeNull();
  if (!plan) return;
  expect(plan.broker.integrityTargets).toContain(
    "/home/user/.local/share/nas/tool.sh",
  );
  expect(plan.broker.integrityTargets).toContain("/workspace/gradlew");
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/stages/hostexec/stage_test.ts`
Expected: FAIL（allowlist がまだ throw する / null で fallback して throw しない / `broker.integrityTargets` が未定義）

- [ ] **Step 3: フォールバック分岐を削除しエラー化する**

`src/stages/hostexec/stage.ts` の LD_PRELOAD 分岐（現行 `if (interceptPaths.length > 0 && interceptLibPath) { ... } else if (interceptPaths.length > 0) { ...fallback... }`）を次に置き換える:

```typescript
  if (interceptPaths.length > 0) {
    if (!interceptLibPath) {
      throw new Error(
        "[nas] hostexec: 相対・絶対パス argv0 のルールには intercept ライブラリ " +
          "(hostexec_intercept.so) が必要ですが、見つかりませんでした。" +
          "nix ビルド（または `cd src/hostexec/intercept && zig build`）で生成するか、nas を再インストールしてください。",
      );
    }
    const existingLdPreload = envVars.LD_PRELOAD;
    envVars.LD_PRELOAD = existingLdPreload
      ? `${INTERCEPT_LIB_CONTAINER_PATH}:${existingLdPreload}`
      : INTERCEPT_LIB_CONTAINER_PATH;
    envVars.NAS_HOSTEXEC_INTERCEPT_PATHS = interceptPaths.join("\n");
    dockerArgs.push(
      "-v",
      addMount(mounts, interceptLibPath, INTERCEPT_LIB_CONTAINER_PATH, true),
    );
  }
```

- [ ] **Step 4: allowlist を撤廃する**

`src/stages/hostexec/stage.ts` の allowlist 定数（`ABSOLUTE_ARGV0_ALLOWED_PREFIXES`, `ABSOLUTE_ARGV0_ALLOWED_OPT_PATTERN`, `CONTAINER_HOME_LOCAL_BIN_SUFFIX`）を削除し、`validateAbsoluteArgv0` を次に置き換える:

```typescript
/**
 * 絶対パス argv0 の入力健全性を検証する。フォールバック bind-mount 経路を
 * 廃止したため、コンテナ側 system パスを shadow する経路は存在しない。ホスト側
 * exec の差し替えは integrity 検証（ブローカー）が守るので、ここではファイルパス
 * として異常なもの（`/` 単体・末尾スラッシュ・`.`/`..` セグメント）だけを弾く。
 *
 * Exported for tests.
 */
export function validateAbsoluteArgv0(ruleId: string, argv0: string): void {
  if (argv0 === "/" || argv0.endsWith("/")) {
    throw new Error(
      `hostexec rule ${JSON.stringify(ruleId)}: argv0 ${JSON.stringify(argv0)} is not a file path.`,
    );
  }
  const segments = argv0.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new Error(
      `hostexec rule ${JSON.stringify(ruleId)}: argv0 ${JSON.stringify(argv0)} must not contain '.' or '..' segments.`,
    );
  }
}
```

コメントブロック（現行 50-66 の allowlist 説明）も削除する。`INTERCEPT_LIB_CONTAINER_PATH` の import は残す。

- [ ] **Step 5: broker plan に integrityTargets を追加し配線する**

`HostExecPlan` の `broker` 型（`stage.ts` の `interface HostExecPlan { ... broker: { ... } }`）に追記:

```typescript
    readonly integrityTargets: readonly string[];
```

`planHostExec` の return 内 `broker: { ... }` に追記（`agent: input.profile.agent,` の隣）:

```typescript
      integrityTargets: interceptPaths,
```

`runHostExec` の `brokerService.start({ ... })` 引数に追記（`agent: spec.agent,` の隣）:

```typescript
        integrityTargets: spec.integrityTargets,
```

- [ ] **Step 6: stage テストが通ることを確認する**

Run: `bun test src/stages/hostexec/stage_test.ts`
Expected: PASS（新規・変更テスト含む全件）

- [ ] **Step 7: hostexec 周辺の全テストと型チェック**

Run: `bun test src/hostexec/ src/stages/hostexec/ && bun run check`
Expected: PASS / エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/stages/hostexec/stage.ts src/stages/hostexec/stage_test.ts
git commit -F <message-file>
```

メッセージ例:
```
refactor(hostexec): drop fallback bind-mount and argv0 allowlist

intercept ライブラリ不在時にラッパーをコンテナ側 argv0 パスへ bind-mount する
フォールバック経路を削除し、代わりに明確なエラーで停止する。この経路が唯一の
コンテナ側 shadow（argv0 = /etc/passwd 等で system ファイルを上書きする）原因
だった。これに伴い存在理由を失ったプレフィックス allowlist を撤廃し、ファイル
パスとしての健全性チェックのみ残す。ホスト側 exec の差し替えは integrity 検証が
守る。planHostExec は解決済みの LD_PRELOAD 対象パスを broker.integrityTargets
として渡し、ブローカーの baseline snapshot に供給する。
```

---

### Task 4: 承認 UI / CLI に「変化した事実」を提示する

pending entry の `integrityChanged` を、CLI 承認一覧と Web UI の承認カードに表示する。

**Files:**
- Modify: `src/cli/hostexec.ts`（displayLine にマーカー付加）
- Modify: `src/ui/frontend/src/stores/types.ts`（`HostExecPendingItemLike` に `integrityChanged?`）
- Modify: `src/ui/frontend/src/stores/pendingStore.ts`（`HostExecPendingRow` に `integrityChanged`、normalizer で伝播）
- Modify: `src/ui/frontend/src/components/PendingPane.tsx`（カードにバッジ表示）
- Test: `src/ui/frontend/src/stores/pendingStore_test.ts`（normalizer のフラグ伝播）

**Interfaces:**
- Consumes: Task 2 の `HostExecPendingEntry.integrityChanged`。
- Produces: `HostExecPendingRow.integrityChanged: boolean`

- [ ] **Step 1: normalizer の失敗テストを書く**

`src/ui/frontend/src/stores/pendingStore_test.ts` に追記（既存の `makeHostExec` ヘルパを流用。無ければ既存テストのアイテム生成方法に合わせる）:

```typescript
test("normalizeHostExecPending: carries integrityChanged flag", () => {
  const rows = normalizeHostExecPending([
    makeHostExec({ argv0: "tool.sh", args: [], integrityChanged: true }),
  ]);
  expect(rows[0].integrityChanged).toBe(true);
});

test("normalizeHostExecPending: defaults integrityChanged to false", () => {
  const rows = normalizeHostExecPending([
    makeHostExec({ argv0: "tool.sh", args: [] }),
  ]);
  expect(rows[0].integrityChanged).toBe(false);
});
```

（`makeHostExec` が `integrityChanged` を受け付けるよう、テストヘルパの型にも同フィールドを許可する。`normalizeHostExecPending` が未 import なら import する。）

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/ui/frontend/src/stores/pendingStore_test.ts`
Expected: FAIL（`integrityChanged` が row に無い / 型エラー）

- [ ] **Step 3: frontend の型と normalizer を更新する**

`src/ui/frontend/src/stores/types.ts` の `HostExecPendingItemLike` に追記:

```typescript
  integrityChanged?: boolean | null;
```

`src/ui/frontend/src/stores/pendingStore.ts` の `HostExecPendingRow` に追記（`command` の後）:

```typescript
  integrityChanged: boolean; // true のとき対象ファイルが起動時 baseline から変化
```

同ファイルの `normalizeHostExecPending` の map 内に追記（`command: [...]` の隣）:

```typescript
    integrityChanged: it.integrityChanged === true,
```

- [ ] **Step 4: normalizer テストが通ることを確認する**

Run: `bun test src/ui/frontend/src/stores/pendingStore_test.ts`
Expected: PASS

- [ ] **Step 5: CLI 承認一覧にマーカーを付ける**

`src/cli/hostexec.ts:37` の `displayLine` を、フラグ有無でマーカーを付けるよう変更:

```typescript
            displayLine: `${item.sessionId} ${item.requestId} ${item.ruleId} ${item.cwd} ${argv}${
              item.integrityChanged ? " [CHANGED-SINCE-START]" : ""
            }`,
```

（`item` が `HostExecPendingEntry` 型であることを確認し、`integrityChanged` を参照できるようにする。型が別名なら該当型に `integrityChanged?: boolean` が伝播しているか確認する。）

- [ ] **Step 6: Web UI の承認カードにバッジを表示する**

`src/ui/frontend/src/components/PendingPane.tsx` の hostexec カード、`{row.command}` を含む `<p class="card-req">` の直後に追記:

```tsx
                  <Show when={row.integrityChanged}>
                    <p class="card-warning">
                      ⚠ 実行対象ファイルがセッション開始時から変化しています
                    </p>
                  </Show>
```

（`Show` は既に import 済み。`card-warning` クラスが未定義でも表示は成立する。既存のスタイル規約に合わせクラス名を調整してよい。）

- [ ] **Step 7: frontend ビルドと型チェック**

Run: `bun run build-ui && bun run check`
Expected: 成功 / エラーなし

- [ ] **Step 8: 関連テスト全件**

Run: `bun test src/ui/frontend/src/stores/pendingStore_test.ts src/cli/`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add src/cli/hostexec.ts src/ui/frontend/src/stores/types.ts src/ui/frontend/src/stores/pendingStore.ts src/ui/frontend/src/components/PendingPane.tsx src/ui/frontend/src/stores/pendingStore_test.ts
git commit -F <message-file>
```

メッセージ例:
```
feat(hostexec-ui): surface integrity-changed on approval prompts

対象ファイルがセッション開始時から変化したために承認へ格上げされた pending を、
CLI 承認一覧のマーカーと Web UI 承認カードの警告バッジで提示する。承認者が
「なぜ allow ルールが承認待ちになったか」を判断できるようにする。
```

---

## Self-Review

**1. Spec coverage:**
- フォールバック削除 → Task 3 Step 3。
- allowlist 撤廃（健全性チェックのみ残す） → Task 3 Step 4。
- baseline をブローカー起動時に snapshot → Task 2 Step 4。
- execute 時の再検証（fast-path 付き）と prompt 分岐 → Task 1（fast-path/decide）+ Task 2 Step 5-6。
- approvedKeys キャッシュより integrity を優先 → Task 2 Step 6（`integrity === "pass" &&` で cache 分岐を包む）。
- prompt 無効時は deny、audit reason に integrity-mismatch → Task 2 Step 6。
- prompt UI に「変化した事実」を提示（hash 値は出さない） → Task 2（フラグ）+ Task 4（表示）。
- 対象は LD_PRELOAD 型のみ、bare name 対象外 → Task 2 Step 5（`isAbsolute || isRelative` ガード）。
- TOCTOU fd 固定は採用しない、stat+hash は spawn 直前 → 本プランは fd 固定を実装しない。`integrityVerdict` は execute 処理の冒頭（runResolved 直前の同一呼び出しフロー）で実行し窓を最小化する。追加作業なし。

**2. Placeholder scan:** プレースホルダなし。テスト内の「既存ヘルパ名に合わせる」注記は、対象ファイルに実在するヘルパへの参照であり、実装者が冒頭を読めば確定できる。各コードブロックは実コードを提示済み。

**3. Type consistency:**
- `IntegritySnapshot` / `FileIntegrity` / `IntegrityVerdict`：Task 1 で定義、Task 2 で import・使用。名前一致。
- `integrityTargets`：options（broker.ts）→ config（broker_service.ts）→ plan.broker（stage.ts）→ start 引数。全経路 `readonly string[] | undefined`。
- `integrityChanged`：`HostExecPendingEntry`（backend）→ `HostExecPendingItemLike` → `HostExecPendingRow`（frontend）。名前一致。
- `readFileIntegrity(filePath, prev?)` / `decideIntegrity(baseline, current)`：Task 1 定義と Task 2 呼び出しで引数順・型一致。

## Execution Handoff

（patched-superpowers の Phase 2 に従い subagent-driven-development で実行する。）
