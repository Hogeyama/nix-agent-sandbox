# 承認一覧のセッション絞り込み Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nas network pending|review` と `nas hostexec pending|review` が `--session <id>` を受け付け、1 セッション分の承認待ちだけを対象にできるようにする。

**Architecture:** 絞り込みは `src/cli/approval_command.ts` の `handleApprovalSubcommand` の内部に閉じる。network と hostexec は `ApprovalAdapter` で差分を吸収する構造になっているため、共通層に置いた振る舞いは両ドメインへ同時に効く。`ApprovalAdapter` のインタフェースは変更しない。`watch` 専用だった `--session` パーサを共有に格上げし、`pending` と `review` が `adapter.listPending()` の結果を `sessionId` の完全一致で絞る。

**Tech Stack:** TypeScript / Bun (`bun:test`) / Biome

## Global Constraints

- 設計の根拠は `docs/superpowers/specs/2026-09-17-approval-session-filter-design.md` にある。実装前に読むこと。
- テストの分類・命名・skipIf の規約は `.claude/skills/test-policy/SKILL.md` に従う。本計画のテストはすべて unit レーン（`src/cli/approval_command_test.ts`、Docker 不要）に収める。
- `src/` のサービス配置と副作用の分離は `.claude/skills/effect-separation/SKILL.md` に従う。本計画は CLI の引数解釈と表示のみを変更し、ステージ・サービスには触れない。純粋なデータ整形にサービスを新設しない。
- セキュリティ不変条件は `.claude/skills/security-constraints/SKILL.md` に従う。本計画は既存の pending ファイル読み取り経路のみを使い、control socket にも exec socket にも触れない。
- フラグ名は `--session` とする。`--session-id` という綴りは採らない。
- コメント・エラーメッセージの日本語／英語の使い分けは、編集対象ファイルの既存の書き方に合わせる（`approval_command.ts` のコメントは日本語、`console.log` の `[nas] ...` は英語）。
- 各タスクの最後のコミットは 1 タスク 1 コミットとする。

---

### Task 1: `--session` パーサを watch 専用から共有へ格上げする

`watchSessionFilter` は `pending` と `review` からも呼ぶことになるため、名前と説明が `watch` 固有のままだと実態とずれる。このタスクは挙動を変えない改名のみを行う。

**Files:**
- Modify: `src/cli/approval_command.ts:52-67`（関数コメントと関数名）, `src/cli/approval_command.ts:102`（呼び出し箇所）
- Test: `src/cli/approval_command_test.ts:14`（import）, `src/cli/approval_command_test.ts:301-312`（テスト本体）

**Interfaces:**
- Consumes: なし（先行タスクなし）
- Produces: `export function sessionFilterArg(nasArgs: string[]): string | undefined` — `--session` の値を返す。`--session` が無ければ `undefined`。値が無い、または次の要素が `-` で始まる場合は `Error("--session requires a session id")` を投げる。

- [ ] **Step 1: テストを先に改名して失敗させる**

`src/cli/approval_command_test.ts` の import 文（14 行目付近）の `watchSessionFilter,` を `sessionFilterArg,` に変える。

```typescript
import {
  type ApprovalAdapter,
  handleApprovalSubcommand,
  type PendingItem,
  sessionFilterArg,
} from "./approval_command.ts";
```

続けて 301-312 行のテストを次の内容へ置き換える。テスト名も `watch:` 接頭辞を外し、共有関数であることを示す。

```typescript
test("sessionFilterArg: --session without a usable value fails instead of widening", () => {
  expect(sessionFilterArg(["watch"])).toBeUndefined();
  expect(sessionFilterArg(["watch", "--session", "sess_a"])).toEqual("sess_a");
  expect(() => sessionFilterArg(["watch", "--session"])).toThrow(
    "--session requires a session id",
  );
  expect(() =>
    sessionFilterArg(["watch", "--session", "--format", "json"]),
  ).toThrow("--session requires a session id");
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
bun test src/cli/approval_command_test.ts
```

Expected: FAIL。`sessionFilterArg` が `./approval_command.ts` から export されていないため、import 解決の時点でエラーになる。

- [ ] **Step 3: 実装を改名する**

`src/cli/approval_command.ts` の 52-67 行を次へ置き換える。関数名を変え、コメントの根拠を `watch` 固有の記述から `pending` / `review` にも通じる記述へ書き直す。

```typescript
/**
 * `--session` の値を取り出す。欠けていれば失敗させる。
 *
 * 値を黙って無視すると、絞ったつもりの全セッションが対象になる。値の無い
 * `--session` も、`--session --format json` のように次のフラグを拾った場合も
 * 同じ結果になる。pending / review では利用者が気づかないまま無関係な
 * セッションの承認を操作しうる。watch では一致するセッションが無いまま
 * 無音で待ち続けることになり、「承認待ちに気づけない」状態そのものになる。
 */
export function sessionFilterArg(nasArgs: string[]): string | undefined {
  const index = nasArgs.indexOf("--session");
  if (index === -1) return undefined;
  const value = nasArgs[index + 1];
  if (value === undefined || value.startsWith("-"))
    throw new Error("--session requires a session id");
  return value;
}
```

102 行の呼び出し箇所を書き換える。

```typescript
    const sessionFilter = sessionFilterArg(nasArgs);
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
bun test src/cli/approval_command_test.ts
```

Expected: PASS（全ケース）。

リポジトリ内に他の参照が残っていないことも確認する。

```bash
grep -rn "watchSessionFilter" --include=*.ts src/ tests/
```

Expected: 出力なし。

- [ ] **Step 5: コミット**

```bash
git add src/cli/approval_command.ts src/cli/approval_command_test.ts
git commit -F - <<'EOF'
refactor(cli): rename watchSessionFilter to sessionFilterArg

pending と review にも --session を効かせるため、パーサを watch 専用の名前から
共有の名前へ変える。関数コメントの根拠も watch の無音待機だけを挙げていたので、
一度読んで終わるコマンドにも通じる書き方へ直した。挙動は変えていない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `pending` をセッションで絞れるようにする

**Files:**
- Modify: `src/cli/approval_command.ts:85-99`（`pending` 分岐）, および同ファイルに file-private ヘルパを 2 つ追加
- Test: `src/cli/approval_command_test.ts`（`pending` のテスト群の末尾、`// approve` の区切りコメントの直前）

**Interfaces:**
- Consumes: Task 1 の `sessionFilterArg(nasArgs: string[]): string | undefined`
- Produces: 同ファイル内で Task 3 が使う file-private ヘルパ 2 つ。export しない。
  - `function filterBySession(items: PendingItem[], sessionFilter: string | undefined): PendingItem[]`
  - `function emptyPendingMessage(domain: string, sessionFilter: string | undefined): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/cli/approval_command_test.ts` の `// approve` 区切りコメント（`// ---` で囲まれた `approve` の見出し）の直前に、次の 3 ケースを追加する。

```typescript
test("pending: --session limits the listing to one session", async () => {
  const { adapter } = makeAdapter([
    { sessionId: "s1", requestId: "r1", displayLine: "one" },
    { sessionId: "s2", requestId: "r2", displayLine: "two" },
  ]);
  const handled = await handleApprovalSubcommand(adapter, "pending", [
    "pending",
    "--session",
    "s2",
  ]);
  restoreLog();

  expect(handled).toEqual(true);
  expect(stdoutLines).toEqual(["two"]);
});

test("pending: --session applies to --format json as well", async () => {
  const { adapter } = makeAdapter([
    {
      sessionId: "s1",
      requestId: "r1",
      displayLine: "ignored",
      structured: { sessionId: "s1", requestId: "r1" },
    },
    {
      sessionId: "s2",
      requestId: "r2",
      displayLine: "ignored",
      structured: { sessionId: "s2", requestId: "r2" },
    },
  ]);
  await handleApprovalSubcommand(adapter, "pending", [
    "pending",
    "--format",
    "json",
    "--session",
    "s2",
  ]);
  restoreLog();

  expect(stdoutLines.length).toEqual(1);
  expect(JSON.parse(stdoutLines[0])).toEqual([
    { sessionId: "s2", requestId: "r2" },
  ]);
});

test("pending: --session with no match names the session in the empty message", async () => {
  const { adapter } = makeAdapter([
    { sessionId: "s1", requestId: "r1", displayLine: "one" },
  ]);
  await handleApprovalSubcommand(adapter, "pending", [
    "pending",
    "--session",
    "sess_typo",
  ]);
  restoreLog();

  expect(stdoutLines).toEqual([
    "[nas] No pending test-domain approvals for session sess_typo.",
  ]);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
bun test src/cli/approval_command_test.ts
```

Expected: 追加した 3 ケースが FAIL。絞り込みが無いため 1 件目は `["one", "two"]` を、3 件目は `"[nas] No pending test-domain approvals."` ではなく `"one"` を出力する。既存ケースは PASS のまま。

- [ ] **Step 3: 実装する**

`src/cli/approval_command.ts` の `sessionFilterArg` の直後（`ApprovalSubcommandDeps` の宣言の前）に、file-private ヘルパ 2 つを追加する。

```typescript
/** セッション id の完全一致で絞る。フィルタ未指定なら素通しする。 */
function filterBySession(
  items: PendingItem[],
  sessionFilter: string | undefined,
): PendingItem[] {
  if (sessionFilter === undefined) return items;
  return items.filter((item) => item.sessionId === sessionFilter);
}

/**
 * 該当なしのときの文言を組み立てる。
 *
 * フィルタ指定時は id をそのまま出す。綴りを誤った id をただの 0 件として
 * 表示すると、承認待ちが無いのか id が違うのかを利用者が区別できない。
 */
function emptyPendingMessage(
  domain: string,
  sessionFilter: string | undefined,
): string {
  return sessionFilter === undefined
    ? `[nas] No pending ${domain} approvals.`
    : `[nas] No pending ${domain} approvals for session ${sessionFilter}.`;
}
```

続けて `pending` 分岐（85-99 行）を次へ置き換える。

```typescript
  if (sub === "pending" || sub === undefined) {
    const sessionFilter = sessionFilterArg(nasArgs);
    const items = filterBySession(await adapter.listPending(), sessionFilter);
    if (hasFormatJson(nasArgs)) {
      console.log(JSON.stringify(items.map(structuredOf)));
      return true;
    }
    if (items.length === 0) {
      console.log(emptyPendingMessage(adapter.domain, sessionFilter));
      return true;
    }
    for (const item of items) {
      console.log(item.displayLine);
    }
    return true;
  }
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
bun test src/cli/approval_command_test.ts
```

Expected: PASS（追加 3 ケースと既存ケースの両方）。

- [ ] **Step 5: コミット**

```bash
git add src/cli/approval_command.ts src/cli/approval_command_test.ts
git commit -F - <<'EOF'
feat(cli): filter `pending` by session id

nas セッションを複数開いていると承認キューに別プロジェクトの要求が混ざり、
目的のセッションの状況を見るのに全体を読み分けることになる。watch が既に
受け付けている --session を pending にも効かせた。

絞り込みは network / hostexec 共通の handleApprovalSubcommand に置いた。
ApprovalAdapter.listPending(sessionId) としてドメイン側で絞る案も採れるが、
実装が 2 つに分かれ、両者が同じ意味で絞ることを型では保証できなくなる。
どちらも承認キューのディレクトリ全体を走査するため性能差も出ない。

該当なしの文言にセッション id を含める。id をタイプミスしたときに 0 件とだけ
表示されると、承認待ちが無いのか綴りが違うのかを区別できないためである。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: `review` をセッションで絞れるようにする

**Files:**
- Modify: `src/cli/approval_command.ts`（`review` 分岐。Task 2 適用後は 185 行付近から始まる `if (sub === "review")` ブロック）
- Test: `src/cli/approval_command_test.ts`（`review` の区切りコメント配下、既存の空リストのテストの直後）

**Interfaces:**
- Consumes: Task 1 の `sessionFilterArg`、Task 2 の `filterBySession` と `emptyPendingMessage`
- Produces: なし

- [ ] **Step 1: 失敗するテストを書く**

`src/cli/approval_command_test.ts` の既存テスト `"review: prints empty message and returns true when no pending items"` の直後に追加する。

```typescript
test("review: --session with no match skips fzf and names the session", async () => {
  const { adapter, calls } = makeAdapter([
    { sessionId: "s1", requestId: "r1", displayLine: "one" },
  ]);
  const handled = await handleApprovalSubcommand(adapter, "review", [
    "review",
    "--session",
    "s2",
  ]);
  restoreLog();

  expect(handled).toEqual(true);
  expect(calls).toEqual([]);
  expect(stdoutLines).toEqual([
    "[nas] No pending test-domain approvals for session s2.",
  ]);
});
```

このテストは fzf を起動しないことも同時に示す。絞り込みが効いていなければ `runFzfReview` へ進み、TTY の無い環境では fzf が起動できずに失敗するか、起動できても入力待ちで止まる。

- [ ] **Step 2: テストが失敗することを確認する**

```bash
bun test --test-name-pattern 'review' src/cli/approval_command_test.ts
```

Expected: 追加ケースが FAIL。絞り込みが無いため `s1` の 1 件を持ったまま `runFzfReview` へ進む。

- [ ] **Step 3: 実装する**

`src/cli/approval_command.ts` の `review` 分岐の冒頭 4 行を置き換える。置き換え前:

```typescript
  if (sub === "review") {
    const items = await adapter.listPending();
    if (items.length === 0) {
      console.log(`[nas] No pending ${adapter.domain} approvals.`);
      return true;
    }
```

置き換え後:

```typescript
  if (sub === "review") {
    const sessionFilter = sessionFilterArg(nasArgs);
    const items = filterBySession(await adapter.listPending(), sessionFilter);
    if (items.length === 0) {
      console.log(emptyPendingMessage(adapter.domain, sessionFilter));
      return true;
    }
```

分岐の残り（`reviewItems` の組み立て以降）は変更しない。

- [ ] **Step 4: テストが通ることを確認する**

```bash
bun test src/cli/approval_command_test.ts
```

Expected: PASS（全ケース）。

- [ ] **Step 5: コミット**

```bash
git add src/cli/approval_command.ts src/cli/approval_command_test.ts
git commit -F - <<'EOF'
feat(cli): filter `review` by session id

review は承認待ちを fzf へ流し込むため、複数セッションを開いていると承認したい
1 件を選ぶのに無関係な行を読み分けることになる。pending と同じ --session で
絞れるようにした。

絞り込んだ結果が 0 件なら fzf を起動せず、既存の空リスト時と同じ経路で戻る。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: help の記述を更新する

**Files:**
- Modify: `src/cli/usage.ts`（Network options / HostExec options の `--session ID` 行、Examples）

**Interfaces:**
- Consumes: Task 2 と Task 3 の挙動
- Produces: なし

- [ ] **Step 1: `--session ID` の説明を更新する**

`src/cli/usage.ts` には次の行が Network options と HostExec options の 2 箇所に同一の文字列で存在する。

```
  --session ID    watch の対象セッションを 1 つに限定する
```

両方を次へ置き換える。同一文字列が 2 箇所あるため、Edit ツールを使う場合は `replace_all: true` を指定する。

```
  --session ID    pending/review/watch の対象セッションを 1 つに限定する
```

- [ ] **Step 2: Examples に 2 行追加する**

Examples の次の行のすぐ後ろに `pending` の例を足す。

```
  nas network pending                    # Show pending approvals
```

追加する行:

```
  nas network pending --session sess_a1b2 # Show one session's pending approvals
```

さらに次の行のすぐ後ろに `review` の例を足す。

```
  nas hostexec watch --session sess_a1b2 # Stream one session only
```

追加する行:

```
  nas hostexec review --session sess_a1b2 # Review one session's approvals
```

- [ ] **Step 3: help の出力を目視で確認する**

```bash
bun run main.ts --help | grep -n -- "--session\|review --session\|pending --session"
```

Expected: `--session ID    pending/review/watch の対象セッションを 1 つに限定する` が 2 行、Examples に追加した 2 行、既存の `nas hostexec watch --session sess_a1b2` の行が出力される。

- [ ] **Step 4: コミット**

```bash
git add src/cli/usage.ts
git commit -F - <<'EOF'
docs(cli): record --session on pending and review in help

--session は watch 専用ではなくなったため、help の説明が実際に受け付ける
サブコマンドとずれていた。network と hostexec の両方の記述を直し、
Examples に pending と review の用例を足した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: 全体の検証

`.claude/skills/post-change-checks/SKILL.md` の順序（fmt → lint → check → test:unit）に従う。

**Files:** なし（検証のみ）

**Interfaces:**
- Consumes: Task 1〜4 の成果
- Produces: なし

- [ ] **Step 1: フォーマット**

```bash
bun run fmt
```

Expected: 正常終了。整形差分が出た場合は Step 5 でコミットする。

- [ ] **Step 2: lint**

```bash
bun run lint
```

Expected: 指摘なし。

- [ ] **Step 3: 型チェック**

```bash
bun run check
```

Expected: エラーなし。

- [ ] **Step 4: unit テスト一式**

```bash
bun run test:unit
```

Expected: 全 PASS。`bun test` / `bun test src/` は使わない。integration テストのモジュールが import 時に `docker info` を叩き、NAS 内では承認フローに到達せず固まるためである（`.claude/skills/post-change-checks/SKILL.md`）。integration / e2e は NAS 内では実行できないので、実行しなかったことを報告する。

- [ ] **Step 5: 整形差分があればコミット**

Step 1 で差分が出た場合のみ実行する。

```bash
git add -u
git commit -F - <<'EOF'
style: apply formatter output

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

差分が無ければこのステップは飛ばす。
