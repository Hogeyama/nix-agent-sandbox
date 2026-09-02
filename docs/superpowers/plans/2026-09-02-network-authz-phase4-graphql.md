# 段階 4: GraphQL

## このドキュメントの読み方

新しいセッションへの引き継ぎである。前提知識を持たない状態で読めるように書いてある。

設計は
`docs/superpowers/specs/2026-08-06-network-authorization-config-model-design.md`
に確定している。**規則を再設計しないこと。** 仕様どおりに実装し、仕様が曖昧なら実装を
止めて質問する。ただし仕様が明示していない点がいくつかあり、それらは下の
「決まっていること」で既に決着している。**そこも再設計しないこと。**

この段階が入ると、次の形の設定が書けるようになり、実トラフィックで効く。

```pkl
rules {
  ["graphql.read"] {
    match { methods { "POST" }; paths { "/graphql" }; body { format = "json" } }
    onMatch = "allow"
    onIndeterminate = "review"
    expect {
      new BodyExpect {
        graphql {
          operations { "query" }
          rootFields { "repository"; "viewer"; "rateLimit" }
          arguments { ["owner"] = new Listing { "my-org" }; ["login"] = new Listing { "my-org" } }
        }
        onViolation = "review"
      }
    }
  }
}
```

`repository(owner:$o,...)` のように引数が変数で与えられていても、`variables` を引いて
解決した値で判定する。literal equals（`/query` の文字列完全一致）はもう要らない。

## 段階 3 の終わり方

値条件（`equals` / `oneOf`）は端から端まで通っている。

| | |
| --- | --- |
| 選択の分担 | broker はボディを持たない。addon が候補ごとのボディ条件の真偽表（`AuthorizeRequest.bodyTruth`）を送り、broker は表を引く述語を `decide` に注入する（`src/network/protocol.ts:143`、`src/network/broker.ts`） |
| `decide` | 葉の述語 `(rule) => Truth` を引数で受け取る。既定の述語は `evaluateBody` を使う（`src/network/authz/resolve.ts:557-571`） |
| addon 側の意味論 | `_evaluate_body_match_with_diagnostic` / `_body_truth_and_diagnostics`（候補ごとに自分の `maxBodyBytes` で評価する）が `semantics.ts` を写している（`nas_addon.py:2184-2276`） |
| パリティ | `decide_parity_test.ts` が実ボディの直積を両実装に流す。`message_parity_test.ts` が addon の組む電文を broker の検証器に通す |
| 契約 | `AUTHZ_CONTRACT_VERSION = 1` のまま。段階 3 は契約を**バージョンを上げずに再定義**した（リリース前で互換の相手がいないため）。ホストと addon は同一コミットで揃える |

`bun run check` / `bun test src/` は通る。Docker が無い環境では `*_integration_test.ts`
が skip されるので、Docker のあるホストで `bun test tests/` を一度通すこと。

## 仕様の「段階 4」のうち、すでに終わっているもの

**静的解析と型は段階 0 で作り終えている。** 新しく書く関係判定は無い。

| 済んでいるもの | 場所 |
| --- | --- |
| `GraphqlMatch` / `GraphqlDocument` 型 | `authz/types.ts` |
| `BodyExpect`（kind `"body"`、`equals` / `oneOf` / `graphql`） | `authz/config.ts:102-107` |
| graphql 条件の正規化（`at` の既定値 `/query`、重複除去） | `authz/relation.ts` の `normalizeBody` |
| graphql 条件の交差・包含（`graphqlIntersects` / `graphqlSubsumes`） | `authz/relation.ts:328-` |
| 3 値評価（`evaluateGraphql` / `satisfiesDocument`。ただし後述の 3 値化が要る） | `authz/semantics.ts:126-159` |
| 交差の証人（document のテキストを構成して置く） | `authz/witness.ts` の `documentFor` |
| expect 側 graphql の空 Listing 検査 | `authz/validate.ts:462-486` |
| 受け入れ条件の設定（仕様「記述例 要件 1」の写し） | `authz/examples_fixture.ts` の `githubGraphqlExample` |

graphql が今どこで切れているかは次の 7 か所である。

1. `src/config/Schema.pkl` — `BodyMatch` に `graphql` が無く、`BodyExpect` /
   `GraphqlMatch` クラスが存在しない。Pkl でこの語彙を書けない
2. `authz/config.ts` の `BodyMatchConfig` — `format` / `equals` / `oneOf` のみ
3. `authz/resolve.ts` の `ResolvedMatch` — graphql を落としている（`bodyFormat` /
   `equals` / `oneOf` のみ）。解決済みドキュメントにも載らない
4. `nas_addon.py` — `_MATCH_KEYS` に `graphql` が無く、`_EXPECT_KEYS` に `body` が
   無く、GraphQL パーサも無い
5. `protocol.ts:720` の `EXPECT_KINDS` — `"body"` が無いので、body 由来の所見を運ぶ
   電文が検証で落ちる
6. `flake.nix:176` — `nas_addon.py` 単体しかアセットに含めない。vendor ツリーの
   置き場が無い
7. TypeScript 側に GraphQL パーサが無い — `RequestBody.documents` を組む者がいない
   （現状はテストが手書きの facts を渡している）

## 決まっていること

### 契約はバージョン 1 のまま再定義する

段階 3 の前例に従う。`_is_valid_match` は `_has_exact_keys` なので、`graphql` キーを
足した瞬間に旧 addon はドキュメント全体を拒否する（fail-closed の 403）。したがって
**解禁コミットは分割できない**（ホスト側の直列化と addon 側の受理を同時に変える）。
バージョン番号はどちらの側にも比較相手がいないので上げない。動いている旧 proxy
コンテナは `computeAddonHash` のラベル差で再作成される。

### 解析は候補ごと、その候補自身の予算で行う

段階 3 の「各候補の真偽をその候補自身の予算で評価して表に入れる」をそのまま延長する。

- 解析は `parse(source, max_tokens=<そのルールの maxNodes>)` で行う。**新しい予算
  キーは足さない。** `maxNodes` は「解析済みツリーの大きさを制限する天井」であり、
  GraphQL の token 数はその GraphQL 版である。既定 200,000 に対し実際の document は
  1〜10KB なので、効くのは病的な入力に対してだけである。
- `max_tokens` 超過は `GraphQLError` になる（仕様が実測済み）。壊れた document、
  GraphQL でない文字列と同じく「解析できない」＝ match では判定不能、`onIndeterminate`
  が処理する。
- 解析結果は**リクエストごとに** `(document テキスト, max_tokens)` をキーに memoize
  する。ルール間で limits はほぼ同一なので、実質 1 リクエスト 1 回の解析になる。
  リクエストを跨ぐキャッシュは持たない（ボディ由来の文字列をプロセスに残さない）。
- 解析後、AST を 1 度歩いて深さを測り、そのルールの `maxDepth` を超えていたら
  判定不能とする。`RecursionError` は最後の網として捕捉し、同じく判定不能に落とす
  （仕様「段階 4」）。
- `maxBodyBytes` の扱いは段階 3 から変えない（ボディ全体に効く）。
  `maxSelectorExpansions` は GraphQL に関与しない（セレクタ走査ではない）。

### 深さの定義

両言語で同じ数を出すために、AST のノード種別に依存しない定義を固定する。

**深さ = `SelectionSet`・`ListValue`・`ObjectValue` の入れ子の最大段数。**
document 直下を 0 とする。`query { a { b } }` は SelectionSet が 2 段なので深さ 2。
`f(x: {a: [1]})` は ObjectValue + ListValue で深さ 2。この 3 種は graphql-js と
graphql-core の AST に同じ形で存在する。

### facts の形と抽出規則

`GraphqlDocument`（`types.ts:93`）を 1 フィールド拡張する。

```ts
interface GraphqlDocument {
  readonly operations: readonly GraphqlOperation[];
  readonly rootFields: readonly string[];
  readonly argumentValues: Readonly<Record<string, readonly string[]>>;
  /** 値を文字列に解決できなかった出現を 1 つ以上持つ引数名。 */
  readonly unresolvedArguments: readonly string[];
}
```

抽出規則。以下のいずれかに反する document は「解析できない」扱い（facts を作らない）
とし、match では判定不能、expect では違反になる。

- **operations**: すべての operation definition の種別。名前のない省略形 `{ ... }` は
  `query`（仕様）。**operation を 1 つも持たない document（fragment のみ）は「解析
  できない」扱いとする。** サーバは実行できない document であり、検査ゲートが黙って
  通す理由がない。
- **rootFields**: 各 operation 直下の selection set のフィールド名。**inline fragment
  と fragment spread は展開する**（同一 document 内の定義を引く。未定義の fragment
  名・spread の循環は「解析できない」扱い）。展開しないと
  `query { ...f } fragment f on Query { node(id:"...") }` が `rootFields` をすり抜ける。
  root より深い位置の fragment は展開しない（root field 名の抽出に関与しないため）。
- **argumentValues**: document 中の**すべての引数ノード**（フィールド引数・directive
  引数、深さを問わず、fragment definition 内も含む）を名前ごとに集める。仕様の
  「document 中に現れるその名前の引数」の字義どおりであり、出現を広く拾うほど条件は
  厳しくなる（安全側）。値の解決は:
  - 文字列リテラル → その文字列
  - 変数 `$v` → `variables` の `v` が文字列ならその値。無い・文字列でない → 解決不能
  - その他のリテラル（Int / Float / Boolean / Null / Enum / List / Object）→ 解決不能
    （仕様「値が文字列でない」）
- **unresolvedArguments**: 解決不能な出現を 1 つ以上持つ引数名の集合。

### 解決できない引数の真理値

- **match（`match.body.graphql`）**: 条件が名指しする引数名が `unresolvedArguments` に
  あれば**判定不能**。仕様「判定不能」の「条件の対象が存在するが、条件と噛み合わない
  型を持つ」に当たる。偽にすると、壊れた変数でより広いルールへ落とせる fail-open に
  なる。
- **expect（`BodyExpect.graphql`）**: 同じ場合は**違反**。仕様の「解決できない引数
  （`variables` に無い、値が文字列でない）は違反として扱う」の字義どおり。
- どちらの側でも、**条件が名指ししない引数**の解決不能は判定に関与しない
  （`first: 10` のような Int 引数は日常の形であり、`owner` だけを縛る条件を汚さない）。

この 3 値化のため `semantics.ts` の `satisfiesDocument` は boolean ではなく `Truth` を
返す形になる。使用箇所は `evaluateGraphql`（同ファイル）だけである。

### BodyExpect の違反所見の形

`_evaluate_expects`（`nas_addon.py:1624`）に kind `"body"` の分岐を足す。承認の同一性は
既存どおり (ルール ID, expect 内の位置, 違反した値) である。

- `equals` / `oneOf`: Pointer の対象が**無い**・**スカラーでない**・**値が集合に無い**、
  のいずれも違反（受理条件に判定不能は無い。仕様「BodyExpect は match がボディの解析に
  成功した後にだけ評価する」）。所見は kind `schema-mismatch`、`pointer` = その JSON
  Pointer（マスク済み）、`value` = マスク済みスカラー（対象が無い・スカラーでない場合は
  null）、`excerpt` = スカラーでない場合のみ `_violation_excerpt` の出力。
- `graphql`: 勝ったルール自身の予算で facts を取り、違反した側面ごとに所見を作る。
  kind `schema-mismatch`、`at` = graphql の `at`、`pointer` = 同じく `at`、`excerpt` =
  null（document 本文は所見に載せない）。`value` は次の正準形とし、マスクを通す。
  - 許されない operation: `operation:mutation`
  - 許されない root field: `rootField:node`
  - 許されない引数値: `argument:owner=other-org`
  - 名指しした引数が解決不能: `argument:owner=(unresolved)`
  - document が解析できない（`at` の対象が無い・文字列でない・parse 失敗・予算超過）:
    kind `body-unavailable`、`value` = null の所見 1 件
  同一 (位置, value) は `count` に畳む（`unionShape` と同じ）。
- `format != "json"` のルールに `BodyExpect` を置けない検査は、addon 側は既存の
  「`emptyBody` 以外は json を要る」（`nas_addon.py:562-564`）が自動で覆う。

### パーサの置き場

- **Python（実行系の正本）**: graphql-core **v3.2.11** を
  `src/docker/mitmproxy/vendor/graphql/` に vendoring する（sdist の `src/graphql` を
  そのまま。`vendor/LICENSE-graphql-core` を添える）。`nas_addon.py` は module 先頭で
  `sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))`
  してから `import graphql` する（起動時 1 回、実測 195ms）。repo 内でテストを走らせる
  ときも同じ相対位置で解決される。
- **TypeScript（パリティと参照実装の道具）**: npm の `graphql`（**^16.14.2** に固定。
  `parse(source, {maxTokens})` は 16.3 以降）を **devDependency** として足す。使うのは
  新設の `src/network/authz/graphql.ts`（facts 抽出と `RequestBody.documents` の構築）
  だけで、**production のモジュール（resolve / broker / stages）からは import
  しない**。broker はボディを持たず真偽表を引くだけなので、実行時に TS 側の解析は
  存在しない。
- 2 言語 2 実装はこの repo の既定の形である（`semantics.ts` ↔ `nas_addon.py`、
  `mask_patterns.ts` ↔ 同）。パリティ試験が突き合わせる。

### vendor の配り方

- `network_runtime_service.ts` の `copyAddonScript` を拡張する: vendor ツリー全体の
  SHA-256（相対パス昇順に、パスと内容を連結してハッシュ）を計算し、
  `${runtimeDir}/vendor/.hash` と一致しなければ `${runtimeDir}/vendor/graphql/` を
  作り直してから sentinel を書く。既存の `nas_addon.py` の内容比較コピーは残す。
- `computeAddonHash` は `nas_addon.py` と vendor ツリーの両方を含めたハッシュにする。
  含めないと、ライブラリを更新しても proxy コンテナが再作成されない（仕様「段階 4」が
  名指しする手当て）。
- `flake.nix:176` に `cp -r ${self}/src/docker/mitmproxy/vendor $out/docker/mitmproxy/`
  を足す。`resolveAsset` の仕組み（`NAS_ASSET_DIR`）は変えない。

## やること

### 1. vendoring と配布の配線（挙動は変わらない）

- graphql-core 3.2.11 の sdist（PyPI）から `src/graphql` を
  `src/docker/mitmproxy/vendor/graphql/` へ写し、LICENSE を添える。lint/format の対象から
  外す（biome は .py を見ないが、`sgconfig.yml` / エディタ設定に触れる除外があれば足す）。
- `nas_addon.py` に sys.path 挿入と `import graphql` を足し、`parse` が通ることと
  `max_tokens` 超過が `GraphQLError` になることを Python 側 unittest
  （`nas_addon_mask_test.py` と同じく `nas_addon_test.ts` から spawn する形）で固定する。
- `copyAddonScript` / `computeAddonHash` / `flake.nix` を「決まっていること > vendor の
  配り方」のとおりにする。vendor の 1 ファイルを変えるとハッシュが変わることをテストで
  固定する。

この時点で graphql を使う設定はまだ書けないので、選択の帰結は何も変わらない。

### 2. TypeScript 側の facts 抽出と意味論の 3 値化

- `package.json` に `graphql@^16.14.2` を devDependency で足す（bun2nix の再生成を
  忘れない）。
- `src/network/authz/graphql.ts` を新設する。
  - `parseGraphqlFacts(text: string, limits: {maxNodes: number; maxDepth: number}): GraphqlDocument | null`
    — null は「解析できない」扱い（parse 失敗・token 予算超過・深さ超過・operation
    なし・fragment 未定義/循環）。
  - `buildGraphqlDocuments(value: JsonValue, ats: readonly string[], limits): Readonly<Record<string, GraphqlDocument>>`
    — `at` の位置が文字列で、facts が取れたものだけを載せる。載らなかった `at` は
    `semantics.ts` の既存規則（対象が無ければ偽、あるのに読めなければ判定不能）が
    そのまま正しく効く。
- `types.ts` の `GraphqlDocument` に `unresolvedArguments` を足し、`witness.ts` の
  `documentFor` は `unresolvedArguments: []` を置く。
- `semantics.ts` の `satisfiesDocument` を `Truth` 返しにし、条件が名指しする引数が
  `unresolvedArguments` にあれば判定不能とする。
- 仕様から固定した期待値の unit test を置く。最低限、次は安全側の決定を符号化して
  いるので必ず固定する。
  - 省略形 `{ a }` → operations は `["query"]`
  - mutation を含む document は `operations { "query" }` の条件で偽
  - root の fragment spread 越しの `node` が `rootFields` の条件で偽になる
  - `repository(owner:$o)` + `variables.o = "my-org"` が `arguments` の条件で真
  - 名指しした引数が解決不能 → **判定不能**（偽ではない）
  - 名指ししていない引数の解決不能（`first: 10`）→ 判定に関与しない
  - fragment のみ・未定義 fragment・深さ超過 → documents に載らない
  - 引数が 1 つも現れない document は `arguments` の条件で真（仕様の字義）

### 3. Python 側の facts 抽出（契約に触れない）

- `nas_addon.py` に `_parse_graphql_facts` / `_evaluate_graphql`（3 値）と、リクエスト
  ごとの memo を足す。深さの測定・operation なしの扱い・fragment 展開・変数解決は
  「決まっていること」の規則を写す。まだどこからも呼ばれない。
- タスク 2 と**同じ期待値**の unittest を Python 側に置く。パリティ試験は両方が同じ
  ように間違っていれば黙って通るので、仕様から固定した期待値を両言語それぞれに置く
  （段階 3 と同じ判断）。

### 4. 解禁（分割不能）

- `Schema.pkl`: `class GraphqlMatch`（`at: String = "/query"`、`operations` /
  `rootFields` / `arguments`）、`BodyMatch.graphql: GraphqlMatch?`、
  `class BodyExpect extends Expect { kind = "body"; equals; oneOf; graphql }` を仕様の
  形で足す。
- `authz/config.ts`: `BodyMatchConfig` に `graphql?: GraphqlMatch` を足す
  （`types.ts` の `Match` と形が揃い、`compileMatch` → `normalizeBody` → 交差・包含
  判定は既存コードがそのまま拾う）。
- `authz/validate.ts`: expect 側にしかない graphql の検査（空 Listing、`at` の JSON
  Pointer 構文）を match 側にも通す。`format = "opaque"` / `"none"` と `graphql` の
  併記を設定エラーにする（仕様「設定エラー」一覧の 2 行。`equals` / `oneOf` の検査に
  並べる）。
- `authz/resolve.ts`: `ResolvedMatch` に正規化済みの graphql（`at` 既定値適用・重複
  除去済み。null 可）を載せ、既定の葉の述語（`resolve.ts:557-571`）に渡す。
  `contractVersion` は 1 のまま。
- `nas_addon.py`: `_MATCH_KEYS` に `graphql`、`_EXPECT_KEYS` に
  `"body": frozenset(("kind", "onViolation", "equals", "oneOf", "graphql"))` を足し、
  形の検証（`at` / `operations` / `rootFields` / `arguments`）を書く。
  `_evaluate_body_match_with_diagnostic` にタスク 3 の `_evaluate_graphql` を配線し
  （判定不能の診断 code は `graphql-unparseable` など 1 語で足す）、
  `_evaluate_expects` に kind `"body"` の分岐（「決まっていること > BodyExpect の
  違反所見の形」）を足す。
- `protocol.ts`: `EXPECT_KINDS` に `"body"` を足す。
- `examples_fixture.ts` の `githubGraphqlExample` が診断なしで解決でき、その解決済み
  ドキュメントを `_is_valid_authz_document` が受理することをテストで固定する
  （受け入れ条件の設定が端から端まで通る最初の点）。

**このコミットは分割できない。** `_has_exact_keys` の検証なので、ホスト側だけ先に
出すと旧 addon が全ドキュメントを拒否し、全セッションが最初のリクエストで 403 になる。

### 5. 設定エラーと関係判定のテスト

判定アルゴリズムは既存（`relation.ts`）なので、ここは配線されたことをテストで固定する
段階である。

- graphql 条件どうしの交差・包含が候補の順序（特異度）と設定エラーに効くこと。
  `at` が異なる 2 条件は「交差し、どちらも包含しない」→ `overrides` が要ること。
- 交差の証人に document テキストが現れること（`witness.ts` は実装済み。設定エラーの
  提示文まで通ることを見る）。
- 併記エラー・空 Listing・壊れた `at` が**セッション開始時に**止まること
  （`config/validate.ts` 経由。通信時の 403 に頼らない）。
- `load_integration_test.ts` に、`BodyExpect` + `graphql` を書いた Pkl 設定が
  `loadConfig` を通る肯定側のテストを足す（既存の「unknown body format を拒否する」
  テストの隣）。

### 6. パリティの拡張

- `decide_parity_test.ts` の設定に graphql スコープを足し、直積に document ボディを
  流す。最低限: 省略形 / mutation / root fragment spread / 変数解決あり /
  名指しした引数が解決不能（判定不能 → 打ち切りの観測）/ 深さ超過 / `at` の対象が
  無い、の 7 形。TS 側の参照述語は `buildGraphqlDocuments` を**そのルールの limits**で
  呼んで `RequestBody.documents` を組む（`requestBody` がボディをルールの
  `maxBodyBytes` で組み直しているのと同じ位置）。
- `message_parity_test.ts` に、kind `"body"` の所見（`schema-mismatch` と
  `body-unavailable` の両方）を載せた電文が broker の検証器を通る 1 件を足す。

### 7. 実トラフィックの受け入れ（Docker あり）

- 統合テスト（`nas_addon_integration_test.ts` / `broker_integration_test.ts` の形）で、
  `githubGraphqlExample` 相当のスコープに対し:
  - `query` + 許された変数 → 自動許可、注入ヘッダー付き
  - mutation → `onViolation = "review"` の違反として pending に載る
  - 壊れた JSON → `onIndeterminate = "review"`
- UI の pending カードが `expectKind = "body"` の所見を他の所見と同じに描画することを
  目視で 1 度確認する（`src/ui/frontend/src/stores/pendingStore.ts` は kind を文字列と
  して扱っており、コード変更は想定しない）。

## 段階 3 から持ち越した、この段階で効いてくるもの

### broker には触らない

段階 3 で選択の葉は「addon が組む真偽表」になった。graphql は葉の中身が増えるだけ
なので、broker・電文の `bodyTruth`・pending エントリの形は変わらない。ホスト側で
増えるのは設定の語彙と検証だけである。

### 候補ごとの予算の形が解析にそのまま延びる

`_body_truth_and_diagnostics` は候補ごとに `maxBodyBytes` で分類し直す形を既に持つ
（`nas_addon.py:2256-2272`）。graphql の「候補ごとに `max_tokens=maxNodes` で解析」は
この形の延長であり、2 段構え（段階 3 で削った `_decide_under_rule_budget`）を復活させる
理由にはならない。memo が同一 limits の再解析を潰す。

### 「条件を expect に置け」の診断が graphql にも効く

`validate.ts:1000` の「ボディ条件は…無条件 allow ルールに覆われています」は
`bodySubsumes` 経由なので、`BodyMatchConfig` に graphql が載った時点で自動的に graphql
条件にも出る。仕様の記述例が条件を `match` ではなく `expect` に置いたのはこの罠の
ためであり、診断が出ることをタスク 5 で固定する。

### `.nas/Schema.pkl` は各プロジェクトに複製されている

`init` が配った Schema.pkl の複製は新しい語彙を知らない。配布・更新の仕組み自体は
この段階の対象外だが、動作確認するプロジェクトでは複製の更新が要る。

## コミットの割り方（案）

| | 内容 | 既存挙動 |
| --- | --- | --- |
| T1 | vendoring と配布の配線（vendor ツリー、sys.path、copyAddonScript / computeAddonHash / flake.nix） | 変わらない |
| T2 | TS の facts 抽出（`authz/graphql.ts`、`unresolvedArguments`、`satisfiesDocument` の 3 値化）と意味論の固定テスト | 変わらない |
| T3 | Python の facts 抽出と同じ固定テスト（未配線） | 変わらない |
| T4 | 解禁（Schema.pkl・config・validate・resolve・addon 契約・`EXPECT_KINDS`）。受け入れ条件の設定が通る | 変わる |
| T5 | 設定エラー・関係判定・Pkl 読み込みのテスト | テスト中心（診断の追加あり） |
| T6 | パリティの拡張（decide / message） | テストのみ |
| T7 | Docker 統合の受け入れと UI の目視 | テストのみ |

T1〜T3 が先頭なのは順序の要請である。パーサと意味論を固定してから配線すれば、
分割できない T4 が「両側の既製部品を繋いで契約を揃える」だけになる。T2 と T3 の
期待値は同一の表から書くこと。

## 着手前に読むもの

この repo の skill を先に読む。

- `test-policy` — テストの分類・命名・skipIf の規約
- `effect-separation` — 副作用の置き場所。`src/network/authz/` は純関数を保つ
- `security-constraints` — コンテナ境界とシークレットの不変条件

仕様は段階 4 に効く節を読む。

- 「Match の語彙 > ボディ条件」— `GraphqlMatch` の 3 制約が全部「集合の包含」で
  ある理由
- 「GraphQL に対する対象の限定」— **これは削減であって境界ではない**。何を守れて
  何を守れないかをここで掴んでから実装する
- 「判定不能」— 4 項目。対象が存在しないのは偽、噛み合わない型は判定不能
- 「受理条件 (Expect)」—「Listing の意味」「検査が完了しないとき」
- 「交差と包含の判定 > ボディ」— graphql の交差・包含規則と `at` が異なる場合
- 「設定エラー」— 一覧を読むこと
- 「実装の段階 > 段階 4」— vendoring の実測表と手当て 3 点
- 「記述例 > 要件 1」— 受け入れ条件。`equals` が縛るのは変数の値であって読む対象では
  ない、という限界の説明まで含めて

コードは `witness.ts:277-303` の `documentFor` のコメント（引数を証人に置かない判断）と
`decide_parity_test.ts` の冒頭コメント、`_body_truth_and_diagnostics` の docstring を
読む。

## 完了の条件

- `examples_fixture.ts` の `githubGraphqlExample`（仕様の受け入れ条件）が、設定の解決
  から addon の受理・違反検出まで端から端まで通る
- `operations { "query" }` / `rootFields` / `arguments` を書いたルールで、変数で
  与えられた引数（`repository(owner:$o)` + `variables`）が解決されて判定される
- mutation・許されない root field・許されない引数値・root の fragment 越しの
  すり抜けが、いずれも違反として承認 UI に載る
- 名指しした引数が解決できない document は、match では判定不能（打ち切り +
  `onIndeterminate`）、expect では違反になる
- document 本文が承認 UI・監査ログ・broker のメモリのいずれにも生では載らない
  （所見の `value` は正準形の短い文字列で、マスクを通っている）
- graphql 条件を持つ設定エラー（併記・空 Listing・交差の未解決）がセッション開始時に
  止まり、証人に document の例が現れる
- vendor の更新が proxy コンテナの再作成を引き起こす
- `bun run check` / `bun test src/` が通り、Docker のあるホストで `bun test tests/` が
  通る
- 全プロファイルが起動する
