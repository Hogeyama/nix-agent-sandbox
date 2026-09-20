# GraphQL Field Path Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 許可した末端フィールドの経路と、その経路の必須引数をすべて満たす GraphQL 読み取りだけを自動許可できるようにする。

**Architecture:** 既存 GraphQL AST から、全 operation の使用位置を保った field の出現を抽出する。TypeScript の参照評価と Python addon の実評価に同じ経路条件を追加し、既存の expect/review に接続する。broker に GraphQL 本文を送らず、新しい違反は一回限りの承認にする。

**Tech Stack:** Bun / TypeScript、既存 graphql-js、Python / vendored graphql-core、Pkl、mitmproxy。新依存なし。

状態: レビュー用。**この計画の作成段階では実装しない。** 読者は既存 GraphQL 実装を
初めて触る実装者。各タスクの入力・成果・検証を決め、旧形式を残さず一括で置き換える。

## Global Constraints

- 仕様の正本: [GraphQL の取得経路を限定する](../specs/2026-09-20-graphql-field-path-policy-design.md)。以下の A1〜A19 は同書の受け入れ条件 ID。
- 事前に `AGENTS.md`、`skills/security-constraints/SKILL.md`、`skills/test-policy/SKILL.md`、`skills/git-commit/SKILL.md` を読む。`security.md` の C と既存ネットワーク認可 spec も背景として読むが、ユーザーの編集中のファイルを変更しない。
- 新しい設定用 limits は追加しない。GraphQL 本文・AST・生の引数値を broker に渡さない。
- `fieldPaths` は末端の完全一致。`*` / `**` は導入しない。alias を捨て、fragment は全階層・全使用位置で展開する。
- `fieldPaths` は必須・非空。旧 `rootFields` / 全域 `arguments` は受理せず、`fieldArguments` に引数条件を統一する。
- `fieldArguments` は指定 field の各出現に引数の存在を要求する。GraphQL 違反の承認は、そのリクエストにだけ有効とする。
- 後方互換は不要。旧設定の読込み・補完・自動変換、旧 facts・診断の互換分岐を実装しない。
- Task 1〜5 は一つの実装コミットにまとめる。ホスト・addon・リポジトリ内設定・fixture を同時に揃える。契約 version は1のまま再定義し、旧新混在は拒否する。
- 形式的な RED は不要。実際の反例・境界ケースを先に固定し、判定結果で検証する。存在しない関数のコンパイルエラーを成果に数えない。
- 最終確認の `bun run test` は1回。途中は個別 unit test または `bun run test:unit` を使う。Docker 実行テストは integration_test.ts に置き、能力判定と cleanup を維持する。
- REST/Web/Git の許可範囲は今回変更しない。稼働中 `.nas/config.pkl` の更新は機能が完成した後だけ行う。

## 現状と変更する境界

| 場所 | 現状 | 今回の責務 |
| --- | --- | --- |
| `src/network/authz/graphql.ts` | root 名と全域の引数を AST から抽出 | 使用位置・operation 文脈を保つ selection facts |
| `src/network/authz/types.ts` | GraphqlMatch / GraphqlDocument | 設定語彙・出現 facts の型 |
| 新規 `src/network/authz/graphql_selection.ts` | なし | パーサを import しない純粋な経路検証・評価 |
| `relation.ts`, `semantics.ts`, `witness.ts` | 旧4項目の意味論 | 経路の包含・交差・評価・証人 |
| `validate.ts`, `resolve.ts`, `Schema.pkl` | 設定から解決済み JSON へ | 新語彙を欠落させず検証・直列化 |
| `src/docker/mitmproxy/nas_addon.py` | 実パーサ、評価、違反レコード | 新 facts と真理値、一次承認用の違反 |
| `src/network/protocol.ts`, UI の診断表示 | 判定不能理由を運ぶ | 経路を含む未解決引数の診断 |
| `.nas/config.pkl` | Hogeyama の入口を制限 | 共通 GraphQL ルールを経路制限へ移行 |

`graphql.ts` はテスト用の参照パーサであり production 側の resolve/broker から import
してはならない。新しい `graphql_selection.ts` は型と通常の collection 操作だけを使う。
Python の追加関数は既存 addon 内に置き、アセットの配布構造を増やさない。

## Task 1: 使用位置を保った selection facts

**Files:**
- Modify: `src/network/authz/types.ts`, `src/network/authz/graphql.ts`
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Test: `src/network/authz/graphql_test.ts`, `src/docker/mitmproxy/nas_addon_graphql_test.py`

**Interfaces:**
- Consumes: `parseGraphqlFacts(text, limits, variables?)`、既存の変数解決、fragment 検証。
- Produces: spec の `GraphqlFieldOccurrence` と `GraphqlDocument { operations, fields }`。
- Python `_parse_graphql_facts` も `operations` / `fields` を返す。旧 rootFields、文書全域 argumentValues/unresolvedArguments は廃止する。

- [ ] **1. 期待する facts を固定する。** 以下を TS と Python それぞれの手書き期待値で検証し、単なる相互一致だけを検証にしない。

```ts
const facts = parseGraphqlFacts(
  'query($o:String="my-org") { r:repository(owner:$o) { ...F } } fragment F on Repository { issues { nodes { body } } }',
  { maxNodes: 10_000, maxDepth: 16 },
)!;
expect(facts.fields).toEqual([
  { path: "/repository", leaf: false,
    argumentValues: { owner: "my-org" }, unresolvedArguments: [] },
  { path: "/repository/issues", leaf: false,
    argumentValues: {}, unresolvedArguments: [] },
  { path: "/repository/issues/nodes", leaf: false,
    argumentValues: {}, unresolvedArguments: [] },
  { path: "/repository/issues/nodes/body", leaf: true,
    argumentValues: {}, unresolvedArguments: [] },
]);
```

- [ ] **2. AST の反復走査へ置き換える。** `graphql.ts` の private 関数 `collectSelectionFacts` は文書・fragment Map・variables・limits を受け、`readonly GraphqlFieldOccurrence[] | null` を返す。Python の `_collect_graphql_selection` は同じ入力と結果を持つ。DFS の順序は operation 定義順、各 selection の記述順。各スタック項目に現在の field 経路と operation の既定値を保持する。root 名の集約、全域の引数収集、旧 facts 専用の fragment reacher は削除し、新走査へ一本化する。構文検証・変数値の解決は再利用する。

```text
各 operation の selection を、path=""・その operation の defaults で開始する。
selection を1つ取り出すたびに展開予算を1消費する。
Field:
  path = parentPath + "/" + field.name（alias は使用しない）
  field 深さを検査する。重複引数名があれば文書全体を null。
  各引数にも1課金し、既存の値解決で文字列と unresolved を分ける。
  leaf = selectionSet がないこと。出現を1件追加する。
  子を同じ operation defaults と新しい path で走査する。
InlineFragment: path を変えず、全 selection を走査する。
FragmentSpread: path を変えず、定義の selection をその使用位置で走査する。
到達する directive は skip/include 以外なら文書全体を null。
予算超過または不完全な解析では途中の fields を返さない。
```

fragment 名だけの visited Set は使わない。循環拒否は既存検査を利用し、展開量は別途
課金する。fields を作り終えるまで配列の一部を成功結果として公開しない。

- [ ] **3. メモ化を分離する。** Python `_GraphqlParsed` に必要な AST/未解決の構造を保持しても、解決済みの fields を query テキストだけで共有しない。各 `_parse_graphql_facts` 呼出しの variables と、その候補の maxDepth/maxNodes で決める。
- [ ] **4. A5〜A10、A17 の抽出ケースを追加する。** 同じ fragment の異なる親、同じ親の alias 2件、2 operation の異なる defaults、未使用 fragment、深い spread 鎖、幅の倍増、末端の `__typename`、未知 directive、重複引数を含める。parse 自体が成功しても展開予算を超えれば文書全体が null になることを検証する。旧 facts に対する期待値・手書き fixture も新形式に書き換える。
- [ ] **5. 抽出テストを検証して Task 2 へ進む。** 中間状態は単独コミットせず、全呼出し側を移行してから一括コミットする。

```bash
bun test src/network/authz/graphql_test.ts --test-name-pattern 'parseGraphqlFacts|buildGraphqlDocuments'
PYTHONPATH=src/docker/mitmproxy/testdata/mitmproxy_stub:src/docker/mitmproxy python3 -m unittest nas_addon_graphql_test.ParseGraphqlFactsTest nas_addon_graphql_test.GraphqlDocumentsTest
```

期待: 移行した抽出テストと新しい facts の期待値が成功。評価器を使う旧テストは Task 3
までに移行し、最終確認では全件を通す。Python の直接実行には vendor が必要なので、
実施前に `src/docker/mitmproxy/vendor/graphql/` を確認し、未準備なら `bun run vendor` を行う。

## Task 2: 経路条件の参照評価と静的解析

**Files:**
- Create: `src/network/authz/graphql_selection.ts`, `src/network/authz/graphql_selection_test.ts`
- Modify: `src/network/authz/types.ts`, `src/network/authz/relation.ts`, `src/network/authz/semantics.ts`, `src/network/authz/validate.ts`, `src/network/authz/witness.ts`
- Test: `src/network/authz/semantics_test.ts`, `src/network/authz/relation_test.ts`, `src/network/authz/validate_test.ts`, `src/network/authz/witness_test.ts`

**Interfaces:**
- Consumes: Task 1 の facts。
- Produces: GraphqlMatch の `fieldPaths` / `fieldArguments`、NormalizedGraphql の同名プロパティ。
- `NormalizedGraphql.fieldPaths: readonly string[]`。
- `NormalizedGraphql.fieldArguments: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>`。
- 新 helper の公開関数は以下。`Truth` は既存 semantics.ts の型を type import する。

```ts
export function isGraphqlFieldPath(value: string): boolean;
export function selectionSatisfies(
  condition: Pick<NormalizedGraphql, "fieldPaths" | "fieldArguments">,
  document: GraphqlDocument | null | undefined,
): Truth;
```

- [ ] **1. 設定型・正規化・検証を置き換える。** rootFields/全域 arguments とその検証分岐を削除し、旧キーを含む入力も未知キーとして拒否する。fieldPaths は必須。パスの文法は次の正規表現に一致すること。Pkl 用の語彙公開と resolve の wire 変更は Task 3 にまとめる。

```ts
const FIELD_PATH = /^(?:\/[A-Za-z_][0-9A-Za-z_]*)+$/;
```

`fieldPaths` の欠落/null/空、旧キー指定、`/repository/**`、`/repository/`、
`/repository//body`、`/repository~1issues`、存在し得ない fieldArguments のキー、空の
内側 Mapping、空の許可値、引数名の不正を検証する。match/expect 両方で同じ検査を使う。

- [ ] **2. helper と semantics の AND に接続する。** 判定の中核は以下。prefix Set の作成はルールごとに行ってよい。

```ts
export function selectionSatisfies(
  condition: Pick<NormalizedGraphql, "fieldPaths" | "fieldArguments">,
  document: GraphqlDocument | null | undefined,
): Truth {
  if (document == null || !Array.isArray(document.fields) ||
    !document.fields.some((f) => f.leaf)) {
    return "indeterminate";
  }
  const leaves = new Set(condition.fieldPaths);
  const prefixes = new Set<string>();
  for (const leaf of leaves) {
    for (let end = leaf.indexOf("/", 1); end !== -1;
      end = leaf.indexOf("/", end + 1)) {
      prefixes.add(leaf.slice(0, end));
    }
  }
  let refused = false;
  let unknown = false;
  for (const field of document.fields) {
    if (!(field.leaf ? leaves : prefixes).has(field.path)) refused = true;
    for (const [name, allowed] of condition.fieldArguments.get(field.path) ?? []) {
      if (field.unresolvedArguments.includes(name)) {
        unknown = true;
      } else if (!Object.hasOwn(field.argumentValues, name) ||
        !allowed.includes(field.argumentValues[name]!)) {
        refused = true;
      }
    }
  }
  return unknown ? "indeterminate" : refused ? "false" : "true";
}
```

`satisfiesDocument` に統合するときも indeterminate を false より優先する。経路だけ合う
facts を作って、未解決の owner を見落とす短絡評価をしない。lookup 用の Record は
`Object.create(null)` または own-property 判定で扱い、`constructor` 等の GraphQL 名を
JavaScript の prototype と混同しない。

- [ ] **3. 包含と交差を置き換える。** `graphqlSubsumes` は spec の3つの十分条件を全部満たした場合だけ true。`graphqlIntersects` は operations または許可末端集合が共通要素を持たない場合に false を返す。引数の矛盾だけから文書全体の非交差を推測しない。rootFields/全域 arguments 用の関係判定は削除する。
- [ ] **4. 証人を組み立てる。** 共通末端を設定順に試し、各 prefix に必須引数を挿入する。値は両ルールの fieldArguments の積集合から取る。取れない候補は次へ進み、全候補が失敗なら null。文字列リテラルは `JSON.stringify` を使う。新 facts と文書を同じ field 鎖から作り、production witness に graphql-js を import しない。
- [ ] **5. A1〜A4、A9〜A12、A15〜A17 の実評価・静的判定を固定する。** 包含テストには「A が B に含まれると判断したら、生成した A の受理例を B も受理する」、証人テストには「表示用 query を参照 parser で再解析しても両条件が true」を加える。

```ts
const match = compileMatch({ paths: ["/graphql"], body: {
  format: "json", graphql: {
    operations: ["query"], fieldPaths: ["/repository/issues/nodes/body"],
    fieldArguments: { "/repository": { owner: ["my-org"] } },
  },
}});
if (!match.ok) throw new Error(match.error);
for (const [query, truth] of [
  ['{ repository(owner:"my-org") { issues { nodes { body } } } }', "true"],
  ['{ repository { issues { nodes { body } } } }', "false"],
  ['{ repository(owner:"other") { issues { nodes { body } } } }', "false"],
  ['{ repository(owner:$missing) { issues { nodes { body } } } }', "indeterminate"],
  ['{ repository(owner:"my-org") { parent { issues { nodes { body } } } } }', "false"],
] as const) {
  const value = { query };
  const documents = buildGraphqlDocuments(value, ["/query"], {
    maxNodes: 10_000, maxDepth: 16,
  });
  expect(evaluateMatch(match.value, {
    method: "POST", path: "/graphql", body: { kind: "json", value, documents },
  })).toBe(truth);
}
```

- [ ] **6. 検証して Task 3 へ進む。** 設定型だけが新キーを受け入れ、resolve/addon が制約を落とす途中状態を単独コミット・リリースしない。

```bash
bun test src/network/authz/graphql_selection_test.ts src/network/authz/semantics_test.ts src/network/authz/relation_test.ts src/network/authz/validate_test.ts src/network/authz/witness_test.ts
```

## Task 3: Pkl・解決済み設定・addon・診断を同時に解禁する

**Files:**
- Modify: `src/config/Schema.pkl`, `src/network/authz/resolve.ts`, `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/network/protocol.ts`, `src/ui/frontend/src/stores/types.ts`, `src/ui/frontend/src/components/pendingCardView.ts`
- Test: `src/config/pkl_integration_test.ts`, `src/network/authz/resolve_test.ts`, `src/docker/mitmproxy/nas_addon_graphql_test.py`, `src/docker/mitmproxy/nas_addon_mask_test.py`, `src/docker/mitmproxy/message_parity_test.ts`, `src/network/protocol_test.ts`, `src/ui/frontend/src/components/pendingCardView_test.ts`
- Update fixtures: `src/network/fixtures/authz/` の GraphQL 条件を持つ JSON、手書き ResolvedGraphql を持つ既存テスト。

**Interfaces:**
- Consumes: Task 1 の selection facts と Task 2 の意味論。
- Produces: wire の GraphQL 条件は at/operations/fieldPaths/fieldArguments の4キーだけ。新診断は host と UI の BodyDiagnostic union に同時追加し、旧全域引数診断は削除する。

```ts
// ResolvedGraphql の rootFields / arguments を削除し、次に置き換える。
readonly fieldPaths: readonly string[];
readonly fieldArguments: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

// BodyDiagnostic の追加 variant
{ code: "graphql-unresolved-field-argument";
  pointer: string; fieldPath: string; argument: string }
```

- [ ] **1. Pkl と resolve を接続する。** GraphqlMatch の rootFields/arguments を以下に置き換える。`toResolvedGraphql` と `matchFromResolved` の往復で欠落させない。fieldPaths は省略できず、fieldArguments だけが省略時に {} になる。

```pkl
fieldPaths: Listing<String>
fieldArguments: Mapping<String, Mapping<String, Listing<String>>> = new {}
```

- [ ] **2. addon の検証器と評価器を一緒に変更する。** `_GRAPHQL_CONDITION_KEYS` を4キーの新形式へ置き換え、設定文法・キー間関係を TS と同じに検証する。`_graphql_selection_satisfies(condition, document)` を追加し、Task 2 のアルゴリズムを同じ3値で実装して `_graphql_satisfies` の operations 条件と AND する。旧 root/global-argument の評価と違反生成を削除する。旧新の exact-key 不一致は設定全体を拒否する。
- [ ] **3. expect 違反を生成する。** 既存の body expect 内の `record` を使い、許可外の末端ごとに UUID、`fieldPath:<path>` の label を渡す。prefix で不許可と分かっても、残りの末端を予算内で検査する。引数の missing/unresolved/not-allowed は対象出現を検査した後、path/name/reason ごとに表示上まとめてよい。既存の mask・文字数上限・findings-truncated を経由させる。

```python
# record は既存の body expect 検査内の closure。
record(at, str(uuid.uuid4()), label=f"fieldPath:{field_path}")
record(at, str(uuid.uuid4()),
       label=f"fieldArgument:{field_path}@{name}=({reason})")
```

- [ ] **4. 未解決の経路引数診断へ置き換える。** match が indeterminate のとき、必須引数に起因する場合は新 variant を使う。有効な文書 facts が無い場合は既存の `graphql-unparseable` 診断を返す。設定順・出現順の最初の理由を採用する。protocol と UI の `graphql-unresolved-argument` を廃止して新 variant に置き換え、旧診断は未知 variant として拒否する。body/transport に関する他の診断は維持する。

```ts
case "graphql-unresolved-field-argument":
  return `GraphQL argument ${diagnostic.fieldPath}@${diagnostic.argument} (document at ${diagnostic.pointer}) had a value that did not resolve to a string.`;
```

- [ ] **5. 往復・拒否・マスクを検証する。** spec の Pkl 例を実評価し、全新キーが解決済み JSON に残ることを確認。キー欠落、旧 addon 相当のキー集合、未知キー、null/空、悪い経路を拒否する。新 label に埋め込んだダミー秘密文字列がマスクされ、query 本文・引数実値が protocol に出ないことを検証する。A14/A15/A17/A18 を含める。
- [ ] **6. 以下を検証して Task 4 へ進む。** fixtures の更新だけで真理値の期待を緩めない。リポジトリ内設定を含む一括コミットは Task 5 で行う。

```bash
bun test src/config/pkl_integration_test.ts src/network/authz/resolve_test.ts src/docker/mitmproxy/nas_addon_test.ts src/docker/mitmproxy/message_parity_test.ts src/network/protocol_test.ts src/ui/frontend/src/components/pendingCardView_test.ts
bun run check
```

## Task 4: 反例と承認の使い回しを端から端まで検証する

**Files:**
- Modify tests: `src/docker/mitmproxy/graphql_acceptance_test.ts`, `src/docker/mitmproxy/decide_parity_test.ts`, `src/network/broker_integration_test.ts`, `src/docker/mitmproxy/nas_addon_integration_test.ts`
- Modify fixtures: `src/network/authz/examples_fixture.ts`

**Interfaces:**
- Consumes: `resolveAuthzConfig` → `withoutInjectLiterals` → `graphql_acceptance.py`、実 broker の review/approve、既存の HTTP upstream fixture。
- Produces: A1〜A19 のうち実通信・承認の証拠。新しい production API は作らない。

- [ ] **1. spec の反例を省略せず fixture 化する。** organization の許可経路に `/organization/membersWithRole/nodes/login` を入れ、メンバー経路全体を単に禁止したから成功したテストにしない。反例に対して Issue 本文と README の禁止末端が両方検出されることを要求する。
- [ ] **2. 次の期待表を既存 runAddon helper に渡す。** 各行で action と inspection/findings の双方を検証する。TS/Python パリティでも同じ document/variables/limits を使う。

| 入力 | match に置いた場合 | expect に置いた場合 |
| --- | --- | --- |
| 許可 Issue/README のみ | true、ルール選択 | 違反なし |
| organization → member → star の反例 | false | review、fieldPath 違反 |
| owner 欠落または許可外 | false | review、fieldArgument 違反 |
| owner が null/未解決変数 | indeterminate | review、fieldArgument 違反 |
| unknown directive/展開上限超過 | indeterminate | review、document 違反 |
| 禁止 field の alias/fragment/skip/include | 元の禁止 query と同じ | 元の禁止 query と同じ |
| 安全・不安全 operation の同居 | 全 operation の AND | 全 operation の違反を検査 |
| fieldPaths を省略した旧設定、旧キーを含む設定 | 設定を拒否 | 設定を拒否 |

- [ ] **3. 承認を使い回せないことを実 broker で検証する。** GraphQL fieldPath 違反だけを持つ要求 R1 を送り、allowedScopes が `["once"]` であることを確認して once 承認する。同一 fieldPath だが repo/引数/子選択の異なる R2 を送り、別 pending になることを確認する。同一 R1 を再送しても再承認が必要であることを確認する。fieldArgument 違反と別の BodyExpect.equals/oneOf の値単位違反が混在する場合は、既存どおり `["once", "violation"]` を出す。violation を選んでも記憶されるのは他の値条件の部分だけで、GraphQL の UUID 違反がある次の要求は再度 review になることを確認する。
- [ ] **4. 実 upstream への送信を数える。** ローカル fixture と mitmproxy/broker を使い、未承認の反例は upstream 0件、deny 後も0件、once 承認後だけ1件になることを検証する。GitHub への実アクセスや実トークンは使わない。response の GraphQL 意味をこの fixture で証明したと説明せず、承認前に要求が漏れない証拠とする。
- [ ] **5. A13/A14/A18 の回帰も合わせて検証して Task 5 へ進む。** protocol 経路を含むテストは既存 integration ファイルに置き、固有名リソースを finally で削除する。

```bash
bun test src/docker/mitmproxy/graphql_acceptance_test.ts src/docker/mitmproxy/decide_parity_test.ts
bun test src/network/broker_integration_test.ts src/docker/mitmproxy/nas_addon_integration_test.ts
```

## Task 5: 設定例・共通プロファイルを移行し、最終確認する

**Files:**
- Modify: `.nas/config.pkl`
- Modify: `docs/superpowers/specs/2026-08-06-network-authorization-config-model-design.md`（本仕様への追補リンクと新語彙の位置付け）
- Modify: `docs/superpowers/plans/2026-09-02-network-authz-phase4-graphql.md`（置換先への履歴リンク）
- Test: `src/config/repo_pkl_test.ts`, `src/docker/mitmproxy/graphql_acceptance_test.ts`
- Read only: `security.md`（ユーザー変更を取り込まない）

**Interfaces:**
- Consumes: 新機能を受理する Pkl Schema と addon、spec の初期許可末端表。
- Produces: claude/codex/copilot/graphql-demo に共通する Hogeyama の経路制限と、その設定からの受け入れ結果。

- [ ] **1. 設定の下書きを作る。** spec の導入表の末端だけを完全経路に展開し、各 root の owner/login を既存 `githubOwners` に結び付ける。旧 rootFields を削除し、global arguments を fieldArguments に置き換える。onMatch/onIndeterminate/onViolation と REST/Web/Git のルールを変更しない。

```pkl
fieldArguments {
  ["/repository"] { ["owner"] = githubOwners }
  ["/organization"] { ["login"] = githubOwners }
  ["/user"] { ["login"] = githubOwners }
  ["/repositoryOwner"] { ["login"] = githubOwners }
}
```

- [ ] **2. 下書きを実 Schema で評価する。** 4プロファイルの解決済みルールを addon に渡し、自 owner の Issue/README、他 owner、user → star、member → star、mutation、未許可 metadata field を検証する。REST `/users/Hogeyama/starred` の既存 allow と第三者 `/repos/other/repo/readme` の review は維持されることを分けて確認する。シークレットの値を解決する必要はない。

```bash
pkl eval --format json .nas/config.graphql-paths-draft.pkl -o /tmp/nas-graphql-paths-config.json
```

- [ ] **3. `.nas/config.pkl` が RO なら、検証済み下書きを `hostexec mv .nas/config.graphql-paths-draft.pkl .nas/config.pkl` で反映する。** 実装着手時のユーザー指示・環境の承認に従う。通常書き込み可能なら同じ検証済み内容で更新する。実行中プロセスの設定が自動更新されたとは主張しない。
- [ ] **4. 全利用箇所の移行漏れを確認し、既存 spec の追補を記載する。** `rg -n 'rootFields|unresolvedArguments|graphql-unresolved-argument' src tests .nas` で旧形式の参照を確認する。field ごとの unresolvedArguments と、旧設定の拒否テストは残るが、旧形式の正常系 fixture・評価・wire 出力は残さない。利用例がある Pkl/JSON も経路を明示する形へ移行する。既存 spec では旧 GraphQL 語彙が本書で置換されたことを明記する。過去の phase4 実装計画は履歴として残し、現在の実装手順と誤認しないよう本書へのリンクを付ける。
- [ ] **5. 最終確認を行う。** 標準チェックと全体テストを1回実行し、skip の理由を報告する。失敗をテスト期待値の緩和で解消しない。Docker 内ビルドの外部接続など環境制約があれば `nas-sandbox` を参照し、必要性のない hostexec 全体テストを追加しない。

```bash
bun run fmt
bun run lint
bun run check
bun run test
```

- [ ] **6. spec の A1〜A19 とテスト箇所を突き合わせ、Task 1〜5 の実装・設定・文書・テストを一つのコミットにする。** 完了報告は自動許可できる範囲、承認へ落ちる範囲、検証結果を示す。GraphQL の制限を GitHub 全通信の安全保証と呼ばない。

## 実装前レビューで確認する判断

新語彙は必須の `fieldPaths` と任意の `fieldArguments`、旧形式は拒否、経路は型条件を区別せず、未知の
directive は自動許可しない。初期設定の許可末端は spec の導入表に限定する。
これらを変える場合は spec と plan の両方を更新し、実装者が別々の意味を採用しないようにする。

この計画の作成完了後はユーザーのレビューに渡す。実装開始の指示が来るまで Task 1 以降を
実行しない。
