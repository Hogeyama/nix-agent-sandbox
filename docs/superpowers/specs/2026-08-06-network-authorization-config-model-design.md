# ネットワーク認可 config 体系の再構成

## 位置づけ

`2026-07-23-configurable-request-policies-design.md` が導入した
`NetworkConfig.reviewRules` / `ReviewRule.requestPolicy` を置き換える。前設計の
成果のうち、セレクタによる構造検査、fail-closed の既定、resolved ドキュメントを
host 側で 1 度だけ解決する構成は引き継ぐ。

前設計と衝突する箇所は本設計を優先する。

- `network.reviewRules` と `network.credentials` を廃止し、`network.scopes` に統合する。
- ルールの選択を位置順（first-match）ではなく**特異度**で決める。
- `requestPolicy` という単一のタグ付き union を、`match` / `expect` / `limits` の
  3 つの軸に分解する。
- base64 フィールドの復号マスク（`EncodedField`）を廃止し、秘密のマスク層に一本化する。
- ボディの内容を**認可の判定材料**として使えるようにする。前設計はボディ検査を
  認可の後段に固定していた。
- preset を Pkl の関数の戻り値ではなく、名前付きのスコープ宣言として提供する。

互換のための別名は用意しない。既存の `config.pkl` は書き換えを要する。

## 満たす要件

1. 単一パスの中身で分岐する。 `POST /graphql` に対し、読み取り専用の操作で
   あり、かつ `variables.o` が `my-org` であるときだけ自動許可し、外れたら
   人間の確認に回す。
2. パスのセグメントを変数として取り出す。 `/repos/{org}/{repo}/issues` の
   `org` を条件にする。
3. 認証情報の注入条件をアクセス条件と揃える。 1 と 2 と同じ条件で
   `Authorization` を注入する。
4. 構造検査の対象から部分木を除外する。
5. 未知の構造に出会ったときの帰結を、拒否・確認・記録して通過の中から選ぶ。
6. エンドポイントの集合を 1 つの単位として宣言する。
7. スコープの閉じ方をルール列から分離する。
8. ルール ID の名前空間を構造として持つ。
9. 秘密の適用範囲をスコープまたはルールで絞る。
10. リソース予算を検査の意味から切り離す。

preset の内部定義に差分を当てる（タグ集合に名前を付けて amend する）ことは要件に含め
ない。名前付きレジストリを設けて遅延束縛する仕組みを要するわりに、未知タグを通したい
という本来の動機は `onViolation = "review"` と値単位の承認が満たすためである（「preset」
に後述）。

## 用語

- **ターゲット**: リクエストの宛先ホストとポートの組を指す。
- **スコープ**: ターゲットの集合と、その集合に対する既定の閉じ方、予算、秘密の
  扱い、ルール群をまとめた単位を指す。ID の名前空間を兼ねる。
- **ルール**: 1 つの `match` と、その帰結をまとめた単位を指す。
- **候補**: あるリクエストに対して `match` の構文部分（メソッドとパス）が一致した
  ルールを指す。
- **判定不能**: `match` のボディ条件を真偽どちらにも確定できない状態を指す。

## 全体構造

```pkl
network {
  // スコープ。キーが名前空間になる (要件 7, 8)
  scopes: Mapping<String, Scope>

  // どのスコープにも属さないターゲットの帰結
  fallback: "review"|"deny" = "deny"

  defaults {
    limits: Limits
    secrets: Mapping<String, SecretDisposition>
    audit: AuditMode
  }

  pendingTimeoutSeconds: Int = 300
  pendingNotify: "auto"|"desktop"|"off" = "auto"
}
```

`scopes` を Mapping にする理由が 2 つある。キーがそのままルール ID の名前空間に
なるので、preset に prefix 引数を渡す必要がなくなる（要件 8）。選択が位置ではなく
特異度で決まるので、「preset より前に置け」という手順が構造的に消える（要件 7）。

Mapping の宣言順は、特異度で決着しない候補どうしのタイブレークとしてのみ意味を
持つ（「評価順」に後述）。Pkl の Mapping は既存キーを amend しても元の位置を保ち、
新しいキーだけを末尾に足すので、preset を amend しても順序は崩れない。

## 秘密の名前付きレジストリ

要件 9 の前提として、秘密に名前を与える。現状は `mask.values` が
`MaskValueConfig { source }` の列で名前を持たず、`hostexec.secrets` だけが
`Mapping<String, SecretConfig>` で名前を持っている。この非対称を解消し、
プロファイル直下の 1 つのレジストリに統合する。

```pkl
secrets: Mapping<String, SecretConfig>

class SecretConfig {
  /// 取得元。`env:VAR` / `file:/path` / `dotenv:/path#KEY` /
  /// `keyring:service/account` / `lines:/path` / `cmd:<command>`。
  from: String
  required: Boolean = true
}
```

`lines:` のように 1 つの名前が複数の値へ展開される取得元を許す。マスクと拒否は
値の集合に対して働くが、注入は単一の値を要するので、複数値の秘密を注入に使う
設定はエラーにする。

`mask` は適用先の選択だけを持つ形に縮む。

```pkl
mask {
  maskfs: Boolean = true
  filter: Boolean = true
  proxy: Boolean = true
  /// maskfs と filter が対象にする秘密の名前。既定は全件。
  apply: Listing<String>?
}
```

ネットワーク側の秘密の扱いは `mask` ではなくスコープとルールが決める（要件 9）。

## スコープ

```pkl
class Scope {
  /// ターゲットのパターン。"api.github.com" / "*.gcr.io" / "example.com:8443"。
  targets: Listing<String>

  /// このスコープのどのルールも引き受けなかったリクエストの帰結。
  fallback: "allow"|"review"|"deny" = "deny"

  /// 継承元を上書きする予算 (要件 10)
  limits: Limits?

  /// 秘密ごとの扱い (要件 9)
  secrets: Mapping<String, SecretDisposition>?

  /// このスコープで許可されたリクエストに注入するヘッダー
  inject: Listing<Inject> = new {}

  audit: AuditMode?

  rules: Mapping<String, Rule>
}
```

### スコープの選択

リクエストのターゲットから 1 つのスコープを選ぶ。選択はターゲットパターンの
特異度で決める。

1. ポート付きの完全一致が最も特異である。
2. ポートなしの完全一致がその次に来る。
3. サフィックスワイルドカードは、一致するラベル数が多いほど特異である。
4. どれにも該当しないリクエストは `network.fallback` に落ちる。

2 つのスコープのターゲット集合が交差し、かつどちらも他方を包含しないときは設定
エラーにする。包含関係があるときは特異な側が勝つ。この規則により、リクエストが
属するスコープは常に 1 つに定まる。

同一ホストを 2 つのスコープに分割することはできない。ホストの中の書き分けは
スコープ内のルールで表現する。

### 閉じ方の分離 (要件 7)

前設計では preset の末尾に `default-deny` ルールが付き、ユーザーの catch-all
`review` と同じ 1 本の列に混ざっていた。本設計では、スコープの `fallback` が
その役割を持つ。`fallback` は構造上つねに最後に評価されるので、ルールの追加位置を
気にする必要がない。preset の `default-deny` ルールは廃止し、
`fallback = "deny"` に置き換える。

## ルール

```pkl
class Rule {
  match: Match

  /// match が真になったときの帰結。
  onMatch: "allow"|"review"|"deny"

  /// match のボディ条件が判定不能だったときの帰結。
  onIndeterminate: "review"|"deny" = "deny"

  /// 受理条件 (要件 4, 5)
  expect: Listing<Expect> = new {}

  limits: Limits?
  secrets: Mapping<String, SecretDisposition>?
  inject: Listing<Inject> = new {}
  audit: AuditMode?

  /// 特異度で比較できない重なりを明示的に解決する。
  overrides: Listing<String> = new {}
}
```

ルールの ID は Mapping のキーであり、実 ID は `<スコープ名>.<キー>` になる（要件 8）。
キーは `[a-z][a-z0-9._-]{0,63}` に従う。ID は省略できない。前設計は ID を任意に
していたため、ID の有無を「shadowing をハードエラーにするか」の目印として流用して
いた。本設計は特異度による選択で shadowing そのものを排除するので、その二重の
意味づけを廃止する。ID の必須化は承認キャッシュの同一性にも効く（後述）。

## 判定の二相

判定を 2 つの相に分ける。この分離が要件 1 と 5 を同じ語彙で満たす。

- **`match`**: そのルールがリクエストを引き受けるかどうかを決める。偽なら、その
  ルールは何も主張せず、選択は次の候補へ進む。
- **`expect`**: 引き受けが決まった後に、リクエストが満たすべき条件を述べる。違反の
  帰結はルールが宣言する。

要件 5 は `expect` に属する。Anthropic の未知タグは受理条件の違反であり、
`onViolation` が拒否・確認・記録して通過を選ぶ。

要件 1 も `expect` に置く。条件を `match` に置くと、条件を外れたリクエストはその
ルールに引き受けられず、同一スコープ内のより広い `allow` ルールに拾われる。書き手は
条件を制限のつもりで書くのに、条件を外れると締まるのではなく緩む方に倒れる。

```pkl
// 危険な書き方: 条件を match に置く
["gql.read"] {
  match { paths { "/graphql" }; body { graphql { operations { "query" } } } }
  onMatch = "allow"
}
["api.all"] {
  match { methods { "POST" }; paths { "/**" } }
  onMatch = "allow"
}
```

mutation は `gql.read` の `match` を偽にする。`gql.read` は何も主張しないので
`api.all` が拾って通す。評価順を変えても結果は変わらない。辞退したルールは順序に
関わらず主張しないためである。

したがって使い分けを次のとおり定める。

- 必ず満たしてほしい条件は `expect` に書く。そのルールが引き受けたうえで、違反の
  帰結を自分で決める。
- どのルールが担当かを分ける条件だけを `match` に書く。外れたら次の候補に渡る。

ボディ条件の語彙は `match` と `expect` の両方に置く（`BodyMatch` と `BodyExpect`）。
同じ条件をどちらに書くかで意味が変わる、というのがこの体系の要点である。

`expect` の違反で選択をやり直すことは許さない。`onViolation` に「次の候補へ」を
置かない。受理条件はそのルールが引き受けたうえでの結果であり、選択を巻き戻すと
特異度の解析が意味を失う。条件不成立時に別のルールへ渡したいなら、条件を
`expect` ではなく `match` に置く。

## Match の語彙

```pkl
class Match {
  /// 省略時は全メソッドに一致する。
  methods: Listing<String>?

  /// パスパターンの集合。1 つでも一致すれば構文部分が一致したと見なす (要件 6)。
  paths: Listing<String>

  /// パスパターンの capture に対する制約 (要件 2)
  captures: Mapping<String, Listing<String>> = new {}

  body: BodyMatch?
}
```

### パスパターン

パターンは `/` 区切りのセグメント列とする。セグメントの種類を 4 つに限る。

- リテラル: バイト列として完全に一致する。
- `*`: 任意の 1 セグメントに一致する。
- `{name}`: 任意の 1 セグメントに一致し、その値を `name` に束縛する。
- `**`: 0 個以上のセグメントに一致する。**末尾のセグメントにのみ置ける。**

正規表現を導入しない。パスの正規化を行わない。パーセント復号、連続スラッシュの
畳み込み、末尾スラッシュの除去のいずれも実施せず、生のパスを比較する。クエリ
文字列は選択に一切参加せず、送出前のマスクの対象としてのみ扱う。

`**` を末尾に限る理由は、パターンの言語の包含関係を明快に保つためである。特異度の
順序が言語の包含で定義されるので、包含が読んで分かる形に語彙を制限する。

`captures` の制約は文字列集合による列挙のみとする。制約のない capture は任意の
1 セグメントに一致する。

### ボディ条件

```pkl
class BodyMatch {
  /// ボディの解釈方法。
  format: "none"|"json"|"opaque"

  /// JSON Pointer と値の完全一致。値は文字列・数値・真偽値のいずれか。
  equals: Mapping<String, Any> = new {}

  /// JSON Pointer と値の集合。
  oneOf: Mapping<String, Listing<Any>> = new {}

  /// GraphQL document の条件 (要件 1)
  graphql: GraphqlMatch?
}

class GraphqlMatch {
  /// document を運ぶフィールド。
  at: String = "/query"

  /// 許す operation の種別。document 中の全ての top-level operation が
  /// この集合に含まれるときだけ真になる。
  operations: Listing<"query"|"mutation"|"subscription">

  /// 許す root field 名。document 中の全ての operation の直下のフィールドが
  /// この集合に含まれるときだけ真になる。省略時は制約しない。
  rootFields: Listing<String>?

  /// 引数名ごとに許す文字列リテラルの集合。document 中に現れるその名前の引数の
  /// 値が、すべてこの集合に含まれるときだけ真になる。変数で与えられた引数は、
  /// 対応する variables の値で評価する。省略時は制約しない。
  arguments: Mapping<String, Listing<String>> = new {}
}
```

`format = "none"` は「ボディが存在し、その長さが 0 である」ことを条件にする。前設計
の `BodylessRequestPolicy` に対応する条件を、選択の側に置いた形になる。

`format = "opaque"` はボディを解析せず、`equals` / `oneOf` / `graphql` を併記できない。

GraphQL の判定は document を解析して行う。名前のない省略形 `{ ... }` は `query`
として扱う。文字列の走査による近似は行わない。コメント、文字列リテラル、ブロック
文字列、複数の定義、fragment の混在を正しく区別する必要があるためである。

`rootFields` と `arguments` はいずれも集合の包含であり、`operations` と同じ形をしている。
任意の述語ではないので、特異度の比較も重なりの検出も従来どおり成立する。

`arguments` の評価では、引数が変数で与えられている場合に `variables` を引いて解決する。
解決できない引数（`variables` に無い、値が文字列でない）は違反として扱う。document 中に
その名前の引数が 1 つも現れない場合は制約が空になるので真である。`arguments` は
「この名前の引数が現れるなら、その値はこの集合に含まれる」を意味し、「この引数が現れる」
ことは要求しない。

capture の値をボディ条件の右辺に置くことはできない。`/variables/o` が `{org}` と
等しいことを要求する書き方を許さない。この形を入れると条件が関係式になり、特異度の
比較が単純な含意判定で済まなくなる。

### GraphQL に対する対象の限定

GraphQL API では「そのリクエストが何を読むか」がパスにもホストにも現れない。`/graphql`
1 本に対して、読む対象は document の中にある。この節は、そこにどこまで制約を掛けられるか
と、掛けられない範囲を定める。

想定する脅威は、エージェントが信用できない公開コンテンツを読み込んで、その中の指示に
従ってしまうことである。エージェントは攻撃者ではなく被害者であり、制御の目的は汚染に
至る前にその読み取りを止めることにある。したがって制御が働くべき瞬間のエージェントは
まだ善良であり、条件を故意に迂回しない。**fail-closed で人間の確認に回ること自体が防御に
なる**。

GitHub GraphQL API を例に、対象がどこに現れるかを整理する。

| 構文 | 対象が静的に見えるか |
| --- | --- |
| `organization(login: "X")` / `user(login: "X")` | 見える（引数のリテラル） |
| `repository(owner: "X", name: "Y")` | 見える |
| `search(query: "org:X is:pr")` | 検索文字列の内部。引数の値としては見えない |
| `node(id: "MDEwOlJlcG9z...")` | 不透明な global ID。原理的に見えない |
| `resource(url: "https://...")` | URL としては見えるが `login` / `owner` ではない |

`rootFields` が `search` / `node` / `nodes` / `resource` を締め出す。`arguments` が
`login` / `owner` を縛る。この 2 つで、**読む対象が静的に見えて、かつ許可された組織を
指すクエリ**だけが自動許可になる。

**`rootFields` の検査は operation の直下に限らなければならない。** GitHub の公開スキーマ
（`octokit/graphql-schema`）を解析すると、`node` という名前のフィールドは 145 の型に、
`nodes` は 149 の型に現れる。ただしその大半は Relay の `Edge.node` と
`Connection.nodes` であり、`repositories(first: 10) { nodes { name } }` のような
ごく普通のページネーションである。危険なのは root の `Query.node(id:)` — 不透明な
global ID で任意のオブジェクトを引くもの — だけであり、これは root にしかない。文書全体で
「`node` という名前のフィールド」を禁じると現実のクエリがほぼ全部落ちる。root に限れば
両者を正しく区別できる。なお `search` は Query にしか存在しない（1 型のみ）。

Query の root field は 31 個ある。`rootFields` の allowlist は、読む対象が
`login` / `owner` 引数として現れるものだけに絞る。

```pkl
new BodyExpect {
  graphql {
    operations { "query" }
    rootFields { "organization"; "repository"; "viewer"; "rateLimit" }
    arguments { ["login"] = List("my-org"); ["owner"] = List("my-org") }
  }
  onViolation = "review"
}
```

**これは削減であって境界ではない。** 許可された組織を入口にしても、GraphQL はグラフなので
そこから出られる。`repository { forks { nodes { ... } } }` や cross-reference を辿れば、
他の組織の公開コンテンツに到達する。「入口が my-org」は「読む範囲が my-org」を意味しない。
この穴は設定では閉じられない。上で見たとおり `nodes` による走査は正当なクエリの基本形
なので、禁じることもできない。

資格情報の側で閉じることもできない。GitHub の fine-grained token は public repository への
read を暗黙に持つので、組織を限定したトークンでも他の組織の公開リポジトリは読める。
トークンのスコープが効くのは書き込みと非公開データであり、公開コンテンツの読み取りには
働かない。

本来の制御点はリクエストではなくレスポンスである。防ぎたいのは信用できない内容が文脈に
入ることであり、それはレスポンスの性質だからである。本設計は全面的にリクエスト側なので、
レスポンス側の制御は対象外とする。

### 判定不能

`match` のボディ条件は真・偽・判定不能の 3 値を返す。判定不能になる場合を網羅的に
挙げる。

- ボディを取得できない。
- 宣言した `format` で解析できない（JSON が壊れている、メンバが重複している、
  GraphQL document を解析できない）。
- 条件の評価に必要なバイト数が予算を超える。
- 条件の対象が存在するが、条件と噛み合わない型を持つ（`graphql.at` が文字列でない、
  `equals` の対象がオブジェクトである等）。

`format = "json"` はルートの型を問わない。ルートがオブジェクトであることを要求
したい場合は、受理条件の `JsonRoot` を使う。

対象が存在しない場合と、値が単に異なる場合は偽であり、判定不能ではない。

判定不能を偽と混ぜない理由は、混ぜると「壊れたボディを送れば条件を回避できる」と
いう抜け道が生まれるためである。

## 選択規則

### 特異度の順序

2 つの `match` について、受理するリクエストの集合を比べる。A の集合が B の集合の
真部分集合であるとき、A が B より特異であると定める。フィールドごとの判定を以下に
定める。

- **メソッド**: 集合の包含で比べる。省略は全メソッドの集合として扱う。
- **パス**: パターンの言語の包含で比べる。`**` は末尾にのみ現れるので、包含は
  セグメント列の前方一致と各位置の種類の比較で決まる。リテラルは `{name}` および
  `*` より狭く、`{name}` と `*` は同じ広さを持つ。`captures` の制約は言語を狭める。
- **ボディ**: 条件の論理的な含意で比べる。条件を持たない側が広い。`equals` は要素が
  1 つの `oneOf` として比べる。`graphql` の `operations` / `rootFields` と
  `arguments` の各エントリは、いずれも集合の包含で比べる。`format`
  の広さは次の関係で決まる。

```
ボディ条件なし  ⊃  "opaque"  ⊃  "json"
                          ⊃  "none"

"json" ∩ "none" = ∅
```

`"opaque"` はボディが存在することを条件にし、その内容を解析しない。JSON のボディも
0 バイトのボディも受理するので、`"json"` と `"none"` の両方を包含する。`"json"` は
0 バイトのボディを解析できず（真にならず判定不能になる）、`"none"` は長さ 0 を要求
するので、この 2 つの受理集合は交わらない。ボディ条件を持たない `match` は、ボディの
ないリクエストも受理するので `"opaque"` より広い。

全フィールドで A が B 以下であり、少なくとも 1 つで真に狭いなら A が特異である。

### 曖昧性の扱い

2 つのルールの受理集合が交差し、かつどちらも他方を包含しないときは設定エラーに
する。交差が空なら共存して構わない。

エラーを回避する手段を 2 つ用意する。一方のルールを狭めるか、交差を担当する
第 3 のルールを足すか、あるいは `overrides` で優先関係を明示する。

```pkl
["repos.pulls"] {
  match { methods { "GET" }; paths { "/repos/*/*/pulls" } }
  onMatch = "allow"
  overrides { "repos.read" }   // 双方が一致したときはこちらが勝つ
}
```

`overrides` は、指定した相手に対してだけ「より特異である」と宣言する。評価順の
決定に使うので、両者が一致するリクエストでは `overrides` を書いた側が先に評価
される。位置ではなくルール ID で優先を述べるので、宣言がルールの傍に残り、ファイル
内の並びを変えても意味が変わらない。

`overrides` は特異度の体系に対する抜け道である。すべての重なりを `overrides` で
解決すると、選択は実質的に手書きの優先順位に退化する。まず `match` を狭めることで
解けないかを検討し、解けないときにだけ使う。1 つのスコープの `overrides` の総数が
そのスコープのルール数を超える設定は警告する。

前設計の shadowing 検査（保護されたルールを覆う設定をエラーにする仕組み）は
廃止する。特異度で選択する体系では、広いルールが狭いルールを覆う事象が起こらない。

### 交差と包含の判定

選択規則も曖昧性の検出も、2 つの受理集合の関係に依存する。判定の手続きを定める。

#### 軸の独立性

`match` の 3 つの軸（メソッド、パス、ボディ）は互いに独立である。ボディ条件の右辺に
capture を置けないので（「ボディ条件」を参照）、パスの選び方がボディ条件の意味を変える
ことはない。したがって受理集合は 3 つの集合の直積であり、交差と包含は軸ごとに判定して
合成できる。

- A と B が交差する ⟺ 3 つの軸すべてで交差する
- A ⊆ B ⟺ 3 つの軸すべてで A ⊆ B

capture をボディ条件に持ち込めないという制限は、この分解を成立させるためにある。

#### 保守側

軸ごとの判定は、**証明できたときにだけ**「交差しない」「包含する」と結論する。証明
できなければ「交差する」「包含しない」に倒す。どちらの倒し方も設定エラーの側に落ちる
ので、判定の不完全さが認可の緩みに変わることはない。誤検出された設定は `overrides`
で解決できる。

#### メソッド

集合の交差と包含で判定する。省略は全メソッドの集合として扱う。

#### パス

パターンを `/` で切ったセグメント列として扱う。`**` を除く各セグメントは、セグメント
文字列の集合を表す。

| セグメント | 表す集合 |
| --- | --- |
| リテラル `x` | `{x}` |
| `*` | 全セグメント |
| `{n}`（`captures` に制約なし） | 全セグメント |
| `{n}`（`captures` に制約 S） | S |

capture 名は 1 つのパターン内で重複しないので、位置どうしに相関はない。よってセグメント
集合の交差と包含は位置ごとに独立に判定できる。

パターン A（`**` を除いた長さ m）と B（同 n）について、次のとおり判定する。

- **どちらも `**` を持たない**: m = n かつ全位置で交差するなら交差する。m = n かつ
  全位置で A ⊆ B なら A ⊆ B である。
- **A だけが `**` を持つ**: n ≥ m かつ位置 1..m で交差するなら交差する。A は長さ m
  以上を無制限に受理するので、A ⊆ B にはならない。
- **B だけが `**` を持つ**: m ≥ n かつ位置 1..n で交差するなら交差する。m ≥ n かつ
  位置 1..n で A ⊆ B なら A ⊆ B である。
- **どちらも `**` を持つ**: k = min(m, n) として位置 1..k で交差するなら交差する。
  m ≥ n かつ位置 1..n で A ⊆ B なら A ⊆ B である。

`paths` は複数のパターンを持つので、受理集合はその合併になる。

- **交差**: A のいずれかのパターンと B のいずれかのパターンが交差すれば交差する。
- **包含**: A の**すべての**パターンが、B の**いずれか 1 つの**パターンに包含される
  とき A ⊆ B とする。

包含の判定は合併に対して不完全である。`{n}` を `["a", "b"]` で制約した 1 本のパターンは、
`/a` と `/b` の 2 本の合併に実際には包含されるが、上の規則は包含と認めない。保守側の
原則どおり「包含しない」に倒し、設定エラーとして書き手に判断を返す。

#### ボディ

`equals { [p] = v }` を `oneOf { [p] = List(v) }` に正規化し、ボディ条件を
（`format`, Pointer → 値集合, `graphql`）の 3 つ組として扱う。

- **`format`**: 「特異度の順序」に掲げた関係で判定する。`"json"` と `"none"` は交差
  しない。それ以外の組は広い側が狭い側を包含する。
- **Pointer → 値集合**: 交差は、両方に現れるすべての Pointer で値集合が交差すること
  とする。片方にしか現れない Pointer は交差を妨げない。包含 (A ⊆ B) は、B に現れる
  すべての Pointer が A にも現れ、その値集合が V_A ⊆ V_B であることとする。A にしか
  現れない Pointer は A を狭めるだけなので包含を妨げない。
- **`graphql`**: `at` が同じなら、`operations` と `rootFields` は集合の交差と包含で、
  `arguments` は Pointer → 値集合と同じ規則（両方に現れる引数名で値集合が交差すれば
  交差、B のすべての引数名が A にもあり値集合が A ⊆ B なら包含）で判定する。省略された
  制約は「制約なし」として最も広く扱う。`at` が異なる 2 つは、交差するとし、どちらも
  包含しないとする。

Pointer どうしの構造的な矛盾は検出しない。`/a` に文字列を要求する条件と `/a/b` に値を
要求する条件は同時には満たせないが、保守側の原則により交差すると見なす。

#### ターゲット

スコープの選択にも同じ判定を使う。ターゲットは (ホストパターン, ポート集合) の組として
扱う。ホストパターンはサフィックスワイルドカードしか持たないので、2 つのホストパターンは
必ず入れ子か素である。ポート集合も単一のポートか全ポートのいずれかなので同じである。

交差しつつどちらも包含しない形は、ホストとポートで包含の向きが逆になるときにだけ生じる。

```pkl
scopes {
  ["a"] { targets { "a.example.com" } }        // ホストが狭く、全ポート
  ["b"] { targets { "*.example.com:8443" } }   // ホストが広く、ポートが 1 つ
}
```

`a.example.com:8443` はどちらにも属し、どちらも他方を包含しない。これは設定エラーで
ある。どちらかのターゲットをポートまで揃えて解消する。

### 評価順

1. ターゲットからスコープを 1 つ選ぶ。該当しなければ `network.fallback` を適用する。
2. スコープ内で、メソッドとパスが一致するルールを候補として集める。
3. 候補を特異度の降順に評価する。特異度で決着しない組は、スコープの `rules`
   Mapping における宣言順で評価する。
4. ボディ条件を評価する。真になった最初の候補を採用する。
5. 判定不能に到達した時点で評価を打ち切り、その候補の `onIndeterminate` を適用する。
6. どの候補も真にならなければ、スコープの `fallback` を適用する。

手順 5 で打ち切る理由は、より特異なルールの判定不能を、より広いルールで黙って
回避されないようにするためである。

手順 3 で宣言順を持ち出す理由は、特異度が全順序ではないためである。受理集合が交差
する比較不能な組は設定エラーで排除されるが、**交差しない**比較不能な組は残る。そして
手順 5 の打ち切りが、その相対順序を観測可能にする。

```pkl
["ping.none"] { match { paths { "/v1/ping" }; body { format = "none" } } ... }
["ping.json"] { match { paths { "/v1/ping" }; body { format = "json" } } ... }
```

`"json"` と `"none"` は互いを包含せず、受理集合も交差しないので、比較不能なまま設定
エラーにもならない。
ここへボディ 0 バイトのリクエストが来ると、`ping.json` を先に評価すれば解析に失敗して
判定不能となり打ち切られ、`ping.none` を先に評価すれば真になって採用される。同じ設定と
同じリクエストで帰結が変わるので、宣言順で全順序を与えてこの差を消す。

条件が偽になった候補は何も主張しないので、より広い候補の帰結がそのまま適用される。
広い `allow` と条件付きルールを同じスコープに置く場合、条件不成立時の帰結は広い側の
`allow` になる。条件を外れたリクエストを人間に見せたいなら、スコープの `fallback` を
`review` にするか、広い `allow` を置かない。

## 受理条件 (Expect)

```pkl
abstract class Expect {
  /// 違反の帰結 (要件 5)。"allow" は違反を記録して通過させる。
  onViolation: "deny"|"review"|"allow" = "deny"
}

class EmptyBody extends Expect {}

class JsonRoot extends Expect {
  rootType: "object"|"array"
}

class BodyExpect extends Expect {
  /// 語彙は BodyMatch と同じ。
  equals: Mapping<String, Any> = new {}
  oneOf: Mapping<String, Listing<Any>> = new {}
  graphql: GraphqlMatch?
}

class UnionShape extends Expect {
  /// 検査対象を選ぶセレクタ
  at: String
  /// 対象から外す部分木 (要件 4)
  exclude: Listing<String> = new {}
  discriminator: String
  allowed: Listing<String>
}
```

`onViolation = "allow"` を選ぶ場合は `audit = "always"` を必須にする。記録なしで
違反を通過させる設定を禁じるためである。

`onViolation` に「次の候補へ」を置かない理由は前述のとおりである。

`BodyExpect` は `match` がボディの解析に成功した後にだけ評価する。解析できないボディは
`match` の側で判定不能になり `onIndeterminate` が処理する。したがって**解析の失敗に
由来する**判定不能は受理条件の側に現れない。走査が予算を使い切る場合は別であり、
「検査が完了しないとき」に定める。

`EmptyBody` と `match.body.format = "none"` は使い分ける。ボディの有無で引き受ける
ルールを分けたいなら `match` に置く。そのルールが引き受けたうえでボディの存在を
拒否として扱いたいなら `EmptyBody` に置く。前者は他の候補へ選択が進み、後者は
`onViolation` の帰結で終わる。

### Listing の意味

`expect` の `Listing` は連言である。すべての要素が成り立つことを要求する。

```pkl
expect {
  new JsonRoot { rootType = "object" }
  new UnionShape { at = "/**/content/*"; exclude { "/tools/**" }; ... }
  new UnionShape { at = "/system/*"; ... }
}
```

ルートがオブジェクトであり、**かつ** content block の型が既知であり、**かつ** system の
要素の型が既知である、と読む。

ただし要素はそれぞれ独自の `onViolation` を持つので、連言の帰結は真偽の合成だけでは
決まらない。以下を定める。

**短絡しない。** 最初の違反で打ち切らず、すべての要素を評価して違反をすべて集める。
打ち切ると承認 UI の所見が 1 件目だけになり、承認者が 1 件承認するたびに次の 1 件が
現れる。違反した値を単位に承認する仕組み（「承認の単位」を参照）が意味を失う。監査に
残る記録も同じ理由で全件とする。

**帰結は最も厳しい違反が決める。** `deny` > `review` > `allow` の順とし、違反した要素の
`onViolation` のうち最も厳しいものをルールの帰結とする。`UnionShape` が `review` で
`JsonRoot` が `deny` のとき、両方が違反すれば `deny` になる。

**所見には違反した要素をすべて載せる。** 帰結が `review` のとき、`allow`（記録して通過）
に留まる違反も承認者に見せる。承認者はリクエスト全体を見て押すので、記録に回った違反を
隠す理由がない。

### 検査が完了しないとき

セレクタの走査が `maxSelectorExpansions` や `maxNodes` を使い切ると、残りの部分木を検査
しないまま評価が終わる。解析の失敗と違い、これは受理条件の側で起きる。

検査未完了は違反として扱う。帰結は、そのルールの `expect` に現れる `onViolation` のうち
最も厳しいものとする。どの要素が違反したはずかを知らないので、宣言されている中で最悪の
帰結を仮定する。所見には、予算を使い切ったセレクタと、走査が到達した最後の JSON Pointer
を含める。

すべての要素が `onViolation = "allow"` であるルールでは、検査未完了も記録して通過に
なる。そのルールは実際の違反も通す設定なので、未完了だけを止める意味がない。この場合は
`audit = "always"` が必須なので記録は残る。

### セレクタと除外 (要件 4)

セレクタは前設計の制限付き JSON Pointer パターンを引き継ぐ。リテラルは `~0` と
`~1` で escape し、`*` は 1 要素に一致し、`**` は 0 個以上の子孫に一致する。正規
表現、フィルタ、式、パーセント復号のいずれも持たない。

`exclude` を追加する。`exclude` に一致した部分木は、そのセレクタの走査から外れる。
除外は部分木ごと切り落とすので、除外された内部のノードは検査対象にならない。

除外により、Anthropic の content block 検査を 5 本の列挙から 1 本に縮められる。

```pkl
new UnionShape {
  at = "/**/content/*"
  exclude { "/tools/**" }
  discriminator = "type"
  allowed = contentTags
}
```

前設計は `/**/content/*` が `tools[].input_schema.properties.content` に届くことを
理由に `**` を捨て、content block が現れうる位置を数え上げていた。数え漏らした位置は
fail-closed の網から外れるという代償を、設計ドキュメント自身が記録している。除外を
持てば、列挙をやめて「検査しない領域」を名指しする形に反転できる。上流が content
block の新しい入れ子位置を追加しても網から漏れない。

`UnionShape` の判定は前設計を引き継ぐ。対象がオブジェクトでなければ違反とし、
discriminator が自身の文字列プロパティとして存在し、その値が `allowed` に含まれる
ことを要求する。セレクタが 0 ノードに一致する場合は違反ではない。

### 違反の所見

`onViolation = "review"` は、違反の所見を承認 UI に渡せる場合にだけ選べる。所見は
違反ごとに次を含む。

- 違反した受理条件の名前
- 違反したノードの JSON Pointer
- 見つかった値（未知タグそのもの）
- そのノードだけの抜粋。秘密をマスクし、深さとバイト数で打ち切る
- 同種の違反の件数

ボディの先頭を切り出した preview では判断できない。現行の `bodyPreview` は先頭 1024
バイトであり、`/v1/messages` の実トラフィックは 100KB を超えるので、承認者は違反箇所を
見ないまま押すことになる。所見はセレクタの走査中に確定しているので、走査に JSON
Pointer を持たせれば取り出せる。

### 承認の単位

`onViolation = "review"` から生じた承認は、リクエストではなく違反を単位とする。

```
承認の単位 = (ルール ID, 受理条件の識別子, 違反した値)
```

リクエストを単位にできない理由は、会話履歴が毎リクエスト再送されるためである。未知
タグが履歴に 1 つ混ざると以後のすべてのリクエストが同じ違反を起こすので、リクエスト
単位ではターンごとに同じ確認が出てセッションが進まない。

ルール ID と値だけでは粗い。`anthropic.messages` で `"fallback"` を承認したとき、
`/**/content/*` で見つけた 1 件を承認したつもりが `/system/*` でも通ってしまう。どの
受理条件が見つけた値かを識別子に含める。`UnionShape` の場合、承認者が見るのは
(`at`, タグ) の組になる。

**受理条件の識別子は `expect` 内の位置とする。** resolved ドキュメントはセッション開始時に
1 度だけ解決され、セッション中は変わらないので、位置で一意に定まる。承認 UI の表示には
位置ではなくセレクタ `at` と受理条件の種別を使う。承認をセッションを跨いで永続化する
なら位置では足りず、`expect` を `Mapping` にしてキーを ID とする必要がある。永続化は
本設計の対象外なので、そのときに移行する。

**値を持たない受理条件では値の成分を空にする。** `EmptyBody`（ボディが存在した）と
`JsonRoot`（ルートが配列だった）には、承認すべき値がない。この場合の単位は
(ルール ID, 受理条件の識別子) となり、「この受理条件をこのセッションの間は満たさなくて
よい」を意味する。ルール全体を無効にするわけではないので、同じルールの他の受理条件は
効き続ける。

**承認済みの集合は broker が保持する。** 受理条件の検査は addon 側で行うが、承認結果を
resolved ドキュメントに書き戻して addon へ押し返すことはしない。addon は違反ごとに
broker へ問い合わせ、broker が承認済みの組をキャッシュから即答する。addon は現行でも
違反時に broker へ往復している（`_query_broker`）ので、状態の同期を持ち込まずに済む。

承認しても秘密のマスクは効き続ける。文字列マスクはタグに依存せずボディ全体に働くので、
未知のノードに平文の秘密があればマスクされる。失うのは、既知の形以外の符号化に隠れた
秘密の検出である。承認者はその判断を抜粋から行う。

## 書き換えを持たない

前設計の `EncodedField`（`{ "type": "base64", "data": ... }` の形をした値を復号し、
秘密をマスクし、再符号化する）を廃止する。ルールから `rewrite` 軸ごと外す。

廃止する理由は、同じ防御がマスク層に既にあるためである。`_build_mask_patterns`
（`src/docker/mitmproxy/nas_addon.py`）は秘密ごとに生値・percent-encoded 2 種に加えて
base64 の**確定部分文字列**を展開し、パターン集合に入れている。確定部分文字列は 3 通りの
バイトアライメントそれぞれについて、隣接バイトの影響を受けない範囲を切り出したもので、
標準アルファベットと URL-safe の両方を生成する。base64 blob の中に秘密が埋まっていても、
blob を復号せずに一致する。

`B64_MIN_PATTERN_LEN = 8` により短すぎるパターンは捨てられるので、被覆は秘密の長さに
依存する。

| 秘密の長さ | base64 パターンの被覆 |
| --- | --- |
| 7 バイト以上 | 3 アライメントすべて |
| 6 バイト | k=0 のみ |
| 5 バイト以下 | なし |

実在の認証情報は 20 文字を超えるので、実質的にすべて被覆される。

`EncodedField` は、マスク層が取りこぼす分を埋めてはいない。埋めていないことを 2 つの
候補について確かめた。**廃止に伴ってマスク層に足す仕事は無い。**

- **折り返された base64。** `EncodedField` もマスクしていない。`_decode_strict_base64`
  は `validate=True` なので、空白を含む値・折り返された MIME 入力・URL-safe
  アルファベットのいずれも復号に失敗し、`encoded-decode-failed` で拒否になる。
  復号できた値だけがマスクの対象だったから、折り返された blob の被覆はもともとゼロで
  ある。廃止しても変わらない。
- **7 バイト未満の秘密。** `B64_MIN_PATTERN_LEN = 8` で捨てられる帯を、`EncodedField`
  は復号後の平文に対する通常のマスクで拾えていた。ただしその被覆は、宣言した位置の
  JSON フィールドという狭い範囲に限られる。閾値は下げない。実在の認証情報は 20 文字を
  超えるのでこの帯に落ちるのは短い語（プロジェクト名、ユーザー名の断片）がほとんどで、
  それを base64 の 6 文字パターンで追うと無関係なボディの中の偶然の 6 文字が `****`
  に化ける。誤マスクは秘密が関与しないリクエストでも起きるので、影響範囲が得より広い。

廃止で挙動が変わるのは、宣言した位置に**復号できない値**が来た場合である。現行は
`encoded-decode-failed` で拒否していたものが、通常の文字列として素通りする。現行の
唯一の宣言は Anthropic preset の `/**` かつ `type == "base64"` の `data`
（画像・文書ブロックの本体）で、ここに来る値は API の要求どおり折り返しのない標準
base64 なので、この経路が守っていたのは不正なペイロードの拒否であって秘密の秘匿では
ない。この拒否は失う。

折り返された base64 blob の中の秘密は、廃止の前後を通じてマスクされない。マスク層の
既知の限界であり、この設計が作るものではない。

マスク層で直すほうが被覆も広い。マスクは全ホスト・全フォーマット・ヘッダー・URL に
働くのに対し、`EncodedField` は宣言したルールの JSON ボディにしか働かなかった。
前設計が置いていた「消費したフィールドは通常の文字列マスクの対象から外す」という
相互排他も、廃止によって不要になる。

代償として、blob の中に秘密があった場合の出力が変わる。復号して再符号化した正常な
blob ではなく、blob の内部が `****` で置換された壊れた blob が送出される。これが起きる
のは秘密が漏れかけたときだけなので、静かに通すより壊れて気付くほうがよいと判断する。

## 秘密の適用範囲 (要件 9)

```pkl
typealias SecretDisposition = "inject"|"mask"|"forbid"|"ignore"
```

- `inject`: `inject` ブロックからの参照を許す。ボディ・URL・クライアント由来の
  ヘッダーに現れた場合の扱いは `mask` と同じである。
- `mask`: 出現箇所を `****` に置換して送出する。
- `forbid`: 出現したら拒否する。値そのものは記録しない。
- `ignore`: 手を触れない。

`network.defaults.secrets`、スコープ、ルールの 3 段で継承する。キー `"*"` はその段の
既定を表し、個別の名前は `"*"` に勝つ。下の段の同名キーは上の段を上書きする。
`network.defaults.secrets` の初期値を `["*"] = "mask"` とする。

この語彙により、「gh token は api.github.com にだけ注入し、他ホストでは同じ値の
出現を拒否する」を書ける。

```pkl
defaults { secrets { ["gh-token"] = "forbid" } }
scopes {
  ["github"] { secrets { ["gh-token"] = "inject" } }
}
```

`mask.proxy = false` のセッションでは `inject` 以外の扱いを実現できないので、
`mask` または `forbid` を持つスコープが存在する設定で `mask.proxy = false` を選ぶ
のは設定エラーにする。

## 注入 (Inject)

```pkl
class Inject {
  name: String
  /// `literal:<value>` / `secret:<name>` / `template:<text>`
  /// `template:` の中の `${<name>}` は secrets レジストリの名前だけを参照できる。
  value: String
}
```

`secret:` と `template:` の参照は `secrets` レジストリの名前を指し、そのスコープまたは
ルールで `inject` として扱われていることを要する。

旧 `CredentialValSpec.valCmd` に対応する `cmd:` は `Inject` には置かない。かわりに
`SecretConfig.from` が `cmd:<command>` を取る。注入する値を必ずレジストリ経由にするため
である。`Inject` から直接コマンドを呼べると、その値はレジストリに存在しないので、マスク
にも `forbid` にも掛からない。「gh token は api.github.com にだけ注入し、他ホストでは
同じ値の出現を拒否する」という本設計の狙いは、トークンが名前を持って初めて成立する。
`gh auth token` はもっとも普通のトークン取得方法なので、これを名前付き秘密にできない
設計は成り立たない。

`template:` は、資格情報がヘッダー値そのものではなく、その一部であるために要る。
GitHub GraphQL API は `Authorization: Bearer <token>` を求めるので、裸のトークンを
値にする `secret:` では書けない。

```pkl
inject {
  new Inject { name = "Authorization"; value = "template:Bearer ${gh-token}" }
}
```

注入はマスクの後に行う。したがって注入のために秘密をマスクの対象から外す必要はなく、
外してもならない。外すと、エージェントが同じ値をボディに書いた場合にそのまま送出される。
現行実装もこの順序であり、`_apply_request_masking` は injectHeaders の適用より前に
呼ばれる（`src/docker/mitmproxy/nas_addon.py`）。

注入は**最終的な帰結が `allow` になったとき**にだけ適用する。自動許可に限らず、
`onMatch = "review"` から人間が承認した場合と、`onViolation = "allow"` で違反を記録して
通過させた場合を含む。拒否したリクエストには注入しない。スコープの `inject` はその
スコープの全ルールに適用し、ルールの `inject` とヘッダー名で突き合わせて、同名はルール側を
採用する。

帰結ごとに違う値を注入したい場合は、`match` でルールを割る。読み取りには読み取り専用
トークンを自動で付け、書き込みは人間の確認に回したうえで書き込み用トークンを付ける、
という書き分けは 2 つのルールになる。

```pkl
["gql.read"] {
  match { methods { "POST" }; paths { "/graphql" }
          body { format = "json"; graphql { operations { "query" } } } }
  onMatch = "allow"
  inject { new Inject { name = "Authorization"; value = "template:Bearer ${gh-token-ro}" } }
}
["gql.write"] {
  match { methods { "POST" }; paths { "/graphql" }
          body { format = "json"; graphql { operations { "mutation" } } } }
  onMatch = "review"
  inject { new Inject { name = "Authorization"; value = "template:Bearer ${gh-token-rw}" } }
}
```

`operations` は「ドキュメント中のすべての top-level operation がこの集合に含まれるとき
だけ真」なので、`{query}` と `{mutation}` の受理集合は交差しない。query と mutation が
混在したドキュメントは両方を偽にして `fallback` へ落ちる。曖昧性の検査を通る。

**この書き方は「判定の二相」の警告に当たらない。** 条件を `match` に置くと緩む方に倒れる
という危険は、同一スコープにより広い `allow` ルールがある場合に生じる。両方の分岐を明示
ルールで覆い、`fallback` が `deny` または `review` であれば、辞退した先に受け皿がない。
帰結そのものを分けたい条件は `match` に置くのが正しい。

「自動許可なら読み取りトークン、人間が承認したなら書き込みトークン」という、同じ
リクエストに対して承認の有無で値を変える書き分けは表現できない。2 つのルールの `match`
が同一になり設定エラーになる。承認による権限昇格は本設計の対象外とする。

要件 3 は、注入をルールの帰結の一部として書くことで満たす。マッチャが独立した値に
なったので、アクセスの条件と注入の条件が同じ 1 つの `match` に集まる。前設計の
`CredentialRule` が持っていた独自のマッチャ（`host` / `pathPrefix` / `method`）は
廃止する。

## 予算 (要件 10)

```pkl
class Limits {
  maxBodyBytes: Int = 33554432
  maxDepth: Int = 64
  maxNodes: Int = 200000
  maxSelectorExpansions: Int = 1000000
}
```

`network.defaults.limits`、スコープ、ルールの 3 段で継承する。既定値は同時に固定の
天井であり、設定は下げる方向にしか変えられない。予算は検査の意味ではなく実行資源の
上限なので、ルールごとに書き写す必要をなくす。

## 監査

```pkl
typealias AuditMode = "always"|"aggregate"|"off"
```

`network.defaults.audit`、スコープ、ルールの 3 段で継承する。`aggregate` は同一の
結果の連続を集約して記録する。`onViolation = "allow"` を持つルールでは `always` を
必須にする。

## preset

preset は名前付きのスコープ宣言として提供する。同一ホストを 2 つのスコープに分割
できないので、preset に手を入れるときは別のスコープを足すのではなく、**同じスコープの
キーを amend する**。

```pkl
scopes {
  ["anthropic"] = (presets.anthropic.v1) {
    rules {
      ["company-bootstrap"] {
        match { methods { "GET" }; paths { "/company/bootstrap" } }
        onMatch = "allow"
        expect { new EmptyBody {} }
      }
    }
  }
}
```

preset のバージョンは不変とする。nas のリリースが既存バージョンに許可先を追加する
ことはない。API の変更は `presets.anthropic.v2` を生み、利用者が明示的に切り替える。

`targets` は amend で差し替えられる。互換のあるゲートウェイを使う場合に、ホスト
マッチングを緩めずに宛先だけ変えられる。

ルールを外したいときは、その ID を `null` で消すか、amend で `match` を狭める。Pkl の
Mapping はキーによる置換ができるので、前設計の `filter` によるリスト操作（ID の
打ち間違いが黙って no-op になる）を使わない。

`prefix` 引数は廃止する。スコープのキーが名前空間を与えるので、同じ preset を 2 つの
ホストに当てるときはスコープを 2 つ作れば ID が衝突しない。

### preset の受理条件は緩められない

amend でできるのはルールの追加・置換・削除までである。preset のルールが持つ `expect` を
**緩める**ことはできない。`expect` は `Listing` なので amend は要素を追加するだけであり、
既にある `UnionShape` の `allowed` を書き換える手段がない。preset のタグ集合に名前を
付けてレジストリ経由で参照させれば緩められるが、参照を遅延束縛する仕組みが要るうえ、
設定の読み方が 1 段深くなる。本設計はこれを採らない。

未知のタグを通したいという動機は、設定ではなく承認で満たす。preset は
`onViolation = "review"` を選ぶので、上流が content block を追加してもセッションは
止まらず、承認 UI に違反した値そのものが提示される。承認は (ルール ID, 受理条件, 違反した値) を
単位とするので、1 度承認すればそのセッションの残りは同じ確認が出ない（「承認の単位」を
参照）。

残る代償は、承認がセッションを跨がないことである。上流が恒久的に追加したタグは、
セッションごとに 1 度ずつ承認することになる。承認の永続化は本設計の対象外なので、
この代償は当面残る。

## ルールの同一性と承認

ルールの実 ID は `<スコープ名>.<キー>` であり、設定が変わらない限り安定である。前
設計は ID を任意にしていたため、`docs/todo/network-approval-scope.md` は承認キャッシュの
キーに `id ?? "#" + sourceIndex` を使う案を検討していた。本設計では ID が必須になり、
位置（`sourceIndex`）が意味を持たなくなるので、承認の同一性を (ルール ID, ターゲット)
の組で定義する。

スコープの `fallback` から生じた確認には、マッチしたルールが存在しない。この場合は
`<スコープ名>.$fallback` を擬似 ID として使う。`$` はルールのキー構文
`[a-z][a-z0-9._-]{0,63}` に含まれないので、ユーザーが書いた ID と衝突しない。
`network.fallback` から生じた確認も同様に `$fallback` とする。

受理条件の違反から生じた確認は、これとは別の単位を持つ（「承認の単位」に前述）。
ターゲットではなく個々の違反に対する許可なので、(ルール ID, 受理条件の識別子, 違反した値)
で同一性を定義する。

承認 UI が提示するスコープは、マッチしたルールの具体性から導出する。ターゲットが
完全一致で固定されているスコープに属するルールでは、選択肢を「今回のみ」と「この
ルールが有効な間ずっと」の 2 つに絞る。ターゲットがワイルドカードのスコープでは、
従来の `host:port` と `host` の粒度を残す。

承認 UI は、**そのリクエストが承認されたときに注入されるヘッダー**を提示する。裸の
リクエストを通す承認と、資格情報を付けて通す承認は、与える権限が別物である。画面に出た
ものと送出されるものが違う状態で押させてはならない。提示するのはヘッダー名と参照する
秘密の名前であり、値そのものは出さない。

セッションを跨いだ永続化は本設計の対象外とする。

## 設定エラー

以下を設定エラーとして扱い、セッションの開始を止める。

- 2 つのスコープのターゲット集合が交差し、どちらも他方を包含しない。
- 2 つのルールの受理集合が交差し、どちらも他方を包含せず、`overrides` による解決も
  ない。
- ルールのキーが `[a-z][a-z0-9._-]{0,63}` に反する。
- パスパターンの `**` が末尾以外に現れる。
- パスパターンの capture 名が同一パターン内で重複する。
- `captures` が、どのパスパターンにも現れない名前を制約する。
- `body.format = "opaque"` と `equals` / `oneOf` / `graphql` を併記する。
- `body.format = "none"` と `equals` / `oneOf` / `graphql` を併記する。
- `format` が `"json"` でないルールに `UnionShape` / `JsonRoot` / `BodyExpect` を
  置く。
- `onViolation = "allow"` を持つルールの `audit` が `"always"` でない。
- `inject` が参照する秘密の扱いが、そのルールの実効値で `inject` になっていない。
- 複数の値に展開される秘密を `inject` から参照する。
- `template:` の `${...}` が `secrets` レジストリに存在しない名前を指す。
- `mask` または `forbid` を持つスコープがある設定で `mask.proxy = false` を選ぶ。
- `limits` が天井を上回る値を指定する。
- `overrides` が存在しないルール ID を指す。
- `overrides` が受理集合の交差しない相手を指す。
- スコープのターゲットが空である。
- `captures` の制約、`oneOf` の値集合、`graphql` の `operations` / `rootFields` /
  `arguments` の各エントリのいずれかが空の Listing である。受理集合が空になり、その
  ルールは決して発火しないため。

## 設定エラーの提示

受理集合の交差を理由とするエラーは、関係だけを述べても書き手が直せない。交差すると判定
した経路から、**両方に一致する具体的なリクエスト**を 1 つ構成して提示する。

証人の構成は交差判定の裏返しである。メソッドは交差した集合から 1 つ選ぶ。パスは交差した
パターンの組から、位置ごとにリテラルがあればそれを、制約付き capture があればその先頭の
要素を、それ以外は `x` を置いて構成する。`**` には交差に必要な数だけセグメントを置く。
ボディは条件を満たす最小の骨格を JSON として構成する。

```
設定エラー: ルール github.repos.read と github.repos.pulls の受理集合が交差します。
            どちらも他方を包含しないため、どちらを適用するか決まりません。

  両方に一致するリクエストの例:
    GET /repos/my-org/x/pulls
    ボディ条件なし

  github.repos.read   (config.pkl:142)  GET|HEAD  /repos/{org}/{repo}/**
  github.repos.pulls  (config.pkl:151)  GET       /repos/*/*/pulls

  解決方法:
    - github.repos.pulls に overrides { "repos.read" } を書く
    - どちらかの match を狭める
    - 交差部分を担当する第 3 のルールを足す
```

スコープのターゲットが交差するエラーも同じ形で提示する。証人はホストとポートの組になる。

包含の判定を保守側に倒しているので（「交差と包含の判定」を参照）、実際には包含関係が
あるのにエラーになる設定が存在しうる。書き手が「これは包含しているはずだ」と考える場面が
残るので、解決方法には常に `overrides` を含める。

## 設定の警告

以下はエラーにせず、設定の読み込み時に警告する。書き方としては成立するが、書き手の
意図と食い違う可能性が高い。

- ボディ条件を持つ `match` のルールが、同一スコープ内のより広い無条件 `allow` ルールに
  覆われている。条件を外れたリクエストは広い側に拾われるので、意図が制限であれば条件は
  `expect` に置く（「判定の二相」を参照）。
- 1 つのスコープの `overrides` の総数が、そのスコープのルール数を超えている。特異度に
  よる選択が手書きの優先順位に退化しかけている（「曖昧性の扱い」を参照）。

## 削除するもの

- `NetworkConfig.reviewRules` と `ReviewRule`
- `NetworkConfig.credentials` と `CredentialRule` / `CredentialValSpec`
- `BodylessRequestPolicy` / `JsonRequestPolicy` / `TaggedUnionGuard`
- `EncodedField` と `JsonRequestPolicy.encodedFields`、`maxDecodedBytes`
  （マスク層の base64 確定部分文字列に一本化する）
- `anthropicV1(pfx, h)` と `anthropicJsonPolicy()` などの関数形 preset
- 位置順による first-match 選択
- shadowing の警告とハードエラー
- `MaskConfig.values` と `MaskValueConfig`（名前付き `secrets` レジストリに統合する）
- `NetworkConfig.pendingDefaultScope`（承認スコープをルールの具体性から導出する）

## 移行

互換のための別名を持たないので、移行は 1 リリースで完了する。既存の `config.pkl` は
書き換えを要する。

### 対応表

| 旧 | 新 |
| --- | --- |
| `ReviewRule { host = h; action = "allow" }`（ホストのみ） | `Scope { targets { h }; fallback = "allow" }`（ルール 0 本） |
| `ReviewRule { host = h; action = "deny" }` | 同上で `fallback = "deny"` |
| `ReviewRule { host = h; method = m; action = a }` | `h` のスコープ内の 1 ルール |
| 末尾の catch-all `ReviewRule { action = "review" }` | `network.fallback = "review"` |
| `CredentialRule { host; header; value.valCmd = c }` | `secrets { [n] { from = "cmd:c" } }` と `h` のスコープの `inject { name = header; value = "secret:n" }` |
| `MaskConfig.values { new { source = s } }` | `secrets { [name] { from = s } }` |
| `anthropicV1(pfx, host)` の展開結果を Listing に継ぎ足す | `scopes { ["anthropic"] = presets.anthropic.v1 }` |

同じ帰結だけを持つホストは 1 つのスコープに複数の `targets` としてまとめられる。旧設定の
`allow(h)` の列は、追加の設定を要するホストを除いて 1 スコープに畳める。

### 本リポジトリの `.nas/config.pkl` の場合

現行の `commonNetwork` は、2 本の `deny`、約 40 本のホスト単位 `allow`、`POST httpbin.org`
の `review`、末尾の catch-all `review` からなる。これは 5 つのスコープになる。

```pkl
network {
  fallback = "review"                          // 旧: 末尾の catch-all

  scopes {
    ["anthropic"] = presets.anthropic.v1       // 旧: anthropicV1 の継ぎ足し

    ["telemetry"] {                            // 旧: deny(...) 2 本
      targets { "http-intake.logs.us5.datadoghq.com"
                "copilot-telemetry.githubusercontent.com" }
      fallback = "deny"
    }

    ["github"] {                               // 旧: allow + ghCred
      targets { "github.com"; "api.github.com" }
      fallback = "allow"
      secrets { ["gh-token"] = "inject" }
      inject {
        // 旧 valCmd はヘッダー値を丸ごと組み立てていた。トークンを名前付き秘密にし、
        // 組み立ては template に移す。これでトークンが他ホストでもマスクされる。
        new Inject {
          name = "Authorization"
          value = #"template:Basic ${gh-token-basic}"#
        }
      }
    }

    ["httpbin"] {                              // 旧: 順序で表していた例外
      targets { "httpbin.org" }
      fallback = "allow"
      rules {
        ["post"] { match { methods { "POST" }; paths { "/**" } }; onMatch = "review" }
      }
    }

    ["allowed"] {                              // 旧: 残りの allow(...) 全部
      targets { "statsig.anthropic.com"; "api.openai.com"; "*.gcr.io" /* ... */ }
      fallback = "allow"
    }
  }
}
```

現行設定の 149-160 行にある「`reviewRules` は first-match なので、後ろに足すとプリセットが
覆われて到達しない。先頭に差し込む」という注意書きと、そのための `for` ループによる Listing
の継ぎ足しは消える。preset はスコープのキーに代入するだけになる。

`POST httpbin.org` の `review` に付いた「must come BEFORE general allow」というコメントも
消える。順序ではなく、`httpbin` スコープの中でルールが `fallback` に勝つという構造で決まる。

### 移行で意味が変わる箇所

機械的な置換では済まない点を挙げる。移行の際はこれらを個別に判断する。

1. **`mask.proxy = false` が設定エラーになる。** `network.defaults.secrets` の初期値が
   `["*"] = "mask"` なので、全スコープが `mask` を持つ状態になり、「`mask` または
   `forbid` を持つスコープがある設定で `mask.proxy = false` を選ぶ」に該当する。現行の
   `commonMask` は `proxy = false` なので、そのままでは起動しない。プロキシでのマスクを
   引き続き行わないなら `network.defaults.secrets { ["*"] = "ignore" }` を明示する。
2. **同一ホストを 2 つのスコープに割れない。** 旧設定が「上に deny、下に allow」で
   表していたホスト内の書き分けは、1 つのスコープ内のルールに畳む必要がある。
3. **`network.fallback` はスコープ内の漏れを拾わない。** 旧 catch-all は全リクエストの
   最後の砦だったが、新しい `network.fallback` はどのスコープにも属さないターゲットに
   だけ効く。スコープ内で誰も引き受けなかったリクエストは、そのスコープの `fallback` に
   落ちる。スコープごとに `fallback` を明示する。
4. **ホスト単位 `allow` を `fallback = "allow"` に写すと `expect` が効かない。** 旧設定と
   同じ緩さを保つ移行だが、そのホストは受理条件による検査を一切受けない。preset のある
   ホストと、ボディを送るホストは、`fallback` ではなくルールで書く。

### 旧スキーマの検出

削除したクラスとプロパティを Pkl から参照すると `Unresolved reference` になるが、移行先が
分からない。`config.pkl` の評価より前に生のソースを走査し、旧識別子を見つけたら移行先を
名指しするエラーを出す。

```
設定エラー: config.pkl:53 で廃止された `reviewRules` を参照しています。
            network.scopes に移行してください。
            対応表: docs/superpowers/specs/2026-08-06-network-authorization-config-model-design.md#移行
```

対象は `reviewRules` / `ReviewRule` / `credentials` / `CredentialRule` / `CredentialValSpec` /
`BodylessRequestPolicy` / `JsonRequestPolicy` / `TaggedUnionGuard` / `anthropicV1` /
`anthropicJsonPolicy` / `MaskValueConfig` / `pendingDefaultScope` とする。

この検出は移行案内の専用であり、互換モードではない。旧識別子を含む設定は動かない。数
リリース後に削除する。

## 実装の段階

一度に作る量ではないので 5 段階に分ける。各段階は単体で出荷可能であり、どの段階でも
fail-closed の性質を失わない。

現行の実装は 3 つの層に分かれている。`src/network/review_rules.ts` がホスト側で設定を
検証して resolved ドキュメントに解決し、`src/docker/mitmproxy/nas_addon.py` がそれを
再検証してリクエストを照合・検査し、`src/network/broker.ts` が確認と承認を扱う。この
分割は本設計でも維持する。

### 段階 0: 静的解析の核

設定もネットワークも触らない純関数だけを作る。

- パスパターンのパーサ、セグメント集合の交差と包含
- メソッド・ボディ・ターゲットの交差と包含
- 特異度の半順序、曖昧性の検出、証人の構成（「設定エラーの提示」）

既存の `methodSubsumes` / `hostSubsumes` / `pathSubsumes`（`review_rules.ts`）を置き換える。

この段階を最初に置く理由は、交差判定の誤りが「理不尽な設定エラー」か「静かな認可の
緩み」のどちらかになり、後から気づけないためである。プロパティテストで健全性を押さえる。

- 包含の健全性: A ⊆ B と判定したら、生成したリクエストのうち A が受理するものは必ず
  B も受理する
- 交差の健全性: 交差しないと判定したら、両方に一致するリクエストは生成されない
- 半順序性: 反射性・推移性・反対称性
- 証人の妥当性: 交差すると判定したとき、構成した証人が実際に両方に一致する

Docker を要さないので `bun test src/` に収まる。

### 段階 1: スコープ体系への移行

`match` の構文部分（メソッド、パス、captures）と、`match.body.format` までを実装する。
`equals` / `oneOf` / `graphql` は入れない。

- `Schema.pkl`: `scopes` / `Scope` / `Rule` / `Match` / `Expect` /
  `secrets` レジストリ / `limits` / `audit`、旧クラスの削除
- `src/config/validate.ts`: 段階 0 の判定を使った設定エラーと警告、旧識別子の検出
- `review_rules.ts` を scope 解決に置き換える
- addon: 選択をスコープ + 特異度に置換。`expect` の評価は既存のセレクタ走査を流用する
  （`UnionShape` は現行の `TaggedUnionGuard`）。`exclude` を追加する
- `EncodedField` と `maxDecodedBytes` を削除する。マスク層の base64 確定部分文字列に
  一本化する。**マスク層は触らない** — この削除は base64 blob のマスク被覆を狭めない
  （「書き換えを持たない」）
- `expect` の評価を短絡から全件収集に変える。最も厳しい `onViolation` を帰結とし、
  予算切れを違反として扱う（「Listing の意味」「検査が完了しないとき」）
- `match.body.format` と、真・偽・判定不能の 3 値、`onIndeterminate`
- `broker.ts`: 承認の同一性を (ルール ID, ターゲット) に変更
- `.nas/config.pkl` と preset の移行

`format` を段階 1 に含める理由は、`UnionShape` / `JsonRoot` / `BodyExpect` /
`BodyExpect` を置くルールが `format = "json"` を要求するためである（「設定エラー」を
参照）。`format` を欠くと Anthropic preset の `messages` ルールが書けず、現行機能を
維持できない。壊れた JSON という判定不能の主要な発生源も `format` に伴うので、3 値と
`onIndeterminate` も同時に入る。

この段階では `onViolation` は `deny` と `allow` だけを許す。`review` は段階 2 で解禁する。

完了条件は、現行の全プロファイルが移行後の設定で起動し、既存の統合テストが通ること。

### 段階 2: 承認の作り直し

`onViolation = "review"` を解禁する。段階 1 までは未知タグが `deny` に落ちるので、この
段階が実運用上の主要な利得になる。

- 違反の所見（違反した受理条件、JSON Pointer、見つかった値、そのノードの抜粋、件数）を
  セレクタ走査から取り出して broker に渡す
- 承認の単位を (ルール ID, 受理条件の識別子, 違反した値) にし、承認済みの集合を broker が
  保持する。会話履歴の再送で同じ確認が繰り返される問題を解く
- 承認 UI の粒度をルールの具体性から導出する。`pendingDefaultScope` を削除する
- `$fallback` 擬似 ID

現行の `bodyPreview`（先頭 1024 バイト）は所見に置き換える。段階 1 で `deny` にしていた
preset の `onViolation` を `review` に切り替えるのはこの段階である。

### 段階 3: ボディの値条件

選択がボディの**形式**ではなく**中身**に依存するようになる。

- `BodyMatch` の `equals` / `oneOf`
- 判定不能での打ち切り（「評価順」手順 5）と、そこから観測される宣言順のタイブレーク
- 段階 0 のボディ条件の交差・包含判定を有効化する

この段階を分ける理由は、複数の候補が同じメソッドとパスを持ちボディの値だけで分かれる
構成が、それまで存在しないためである。段階 2 までは候補が高々 1 つに定まるので、
特異度の降順評価と打ち切りは実質的に働かない。

### 段階 4: GraphQL

- graphql-core の vendoring と、`parse()` による document の解析
- `GraphqlMatch`（`operations` / `rootFields` / `arguments`）を `match.body` と
  `BodyExpect` の両方で有効にする
- 名前のない省略形 `{ ... }` を `query` として扱う、コメント・文字列リテラル・ブロック
  文字列・fragment の区別
- `arguments` の変数解決（引数が変数のときに `variables` を引く）

**graphql-core v3.2.11 を vendoring して使う。** 使うのは `graphql.language.parse()`
だけであり、**スキーマを構築せず、実行もしない**。

前提は `mitmproxy/mitmproxy:11` の中で実測して確かめた。

| 確認したこと | 結果 |
| --- | --- |
| イメージの Python | 3.13.2 |
| 実行時依存 | なし（`typing-extensions` は `python < 3.10` 条件つきで、3.13 では `typing.TypedDict` を使い import されない） |
| `parse(source, max_tokens=N)` | v3.2.11 に存在する |
| ライセンス | MIT |
| vendoring するサイズ | `src/graphql` が 1.1MB / 128 ファイル |
| `import` の所要 | 195ms・127 モジュール（addon の起動時 1 回のみ） |
| 典型的な query 1 本の解析 | 0.093 ms |

pip を使わずに配れる。proxy は `runtimeDir` を `/nas-network` に bind-mount し、
`mitmdump -s /nas-network/nas_addon.py` で起動する（`src/stages/proxy/proxy_service.ts`）。
アセットはバイナリに埋め込まれずディスク上のファイルとして解決されるので
（`src/lib/asset.ts`）、`src/docker/mitmproxy/vendor/graphql/` に置いて
`resolveAssetDir` で解決し、`runtimeDir` にコピーすればよい。addon 側は
`sys.path` に自分のディレクトリを足して `import graphql` する。ディレクトリごと配る形は
`ui/dist` に前例がある。自前イメージのビルドも、実行時のネットワークアクセスも要らない。

実装で手当てが要る点を挙げる。

- `computeAddonHash` は `nas_addon.py` 単体をハッシュし、コンテナのラベル
  （`NAS_ADDON_HASH_LABEL`）で proxy の再作成を判断している。vendor ツリーもハッシュに
  含めないと、ライブラリを更新しても proxy が再起動しない。
- `copyAddonScript` は単一ファイルの内容比較で短絡している。ディレクトリ対応が要る。
- ピン留めするバージョンで、実行時依存が本当にゼロであることと、`parse(source,
  max_tokens=N)` が使えることを確認する。`max_tokens` は 3.2 で追加された。

`max_tokens` は予算の上限をそのまま表現できる。超過は `GraphQLError` になり、`match` の
判定不能に落ちて `onIndeterminate` が処理する。壊れた document、GraphQL でない JSON も
同じ経路に落ちることを実測で確かめた。解析器は「解析できたか否か」を返せばよく、堅牢性の
要求はその分下がる。

**ネストの深さは `RecursionError` に頼らず `maxDepth` で明示的に判定する。** graphql-core
の parser は再帰下降なので、既定の `sys.getrecursionlimit() = 1000` では深さ 247 で
`RecursionError` になる。これは fail-closed ではあるが、実効的な上限が CPython のフレーム
予算という実装の都合で決まることになり、宣言した予算と食い違う。`Limits.maxDepth` の既定は
64 でこれより十分小さいので、解析後に AST の深さを検査して超過を判定不能とする。
`RecursionError` は最後の網として捕捉し、同じく判定不能に落とす。

実装言語を Python 以外にする案は採らない。ここで解析するのはサンドボックス内のエージェント
が完全に制御する入力であり、しかも認可の判断経路上にある。敵対的な入力のパーサを
メモリ安全でない言語に移すのは方向が逆であり、AST を扱うぶんこの論点は強くなる。性能も
理由にならない。GraphQL document は 1〜10KB であり、100KB を超える `/v1/messages` の
ボディは GraphQL 解析の対象外である。この repo は既に `src/network/mask_patterns.ts` と
`nas_addon.py` で TypeScript と Python の同等実装を維持しているので、3 つ目の言語を
持ち込む保守コストも実在する。

解析器の導入と毎リクエストの解析コストが他の段階と独立しているので最後に置く。段階 3
までの体系は GraphQL なしで完結している。

## 記述例

### 要件 1: GraphQL の読み取りだけ自動許可する

```pkl
scopes {
  ["github"] {
    targets { "api.github.com" }
    fallback = "review"
    secrets { ["gh-token"] = "inject" }
    inject { new Inject { name = "Authorization"; value = "template:Bearer ${gh-token}" } }
    rules {
      ["graphql"] {
        match {
          methods { "POST" }
          paths { "/graphql" }
          body { format = "json" }
        }
        onMatch = "allow"
        onIndeterminate = "review"
        expect {
          new BodyExpect {
            graphql { operations { "query" } }
            equals { ["/variables/o"] = "my-org" }
            onViolation = "review"
          }
        }
      }
    }
  }
}
```

mutation を含む document、`variables.o` が別の組織を指す document、`variables` を
持たないボディは、いずれも `graphql` ルールが引き受けたうえで受理条件に違反し、
`onViolation = "review"` で人間の確認に回る。条件を `match` ではなく `expect` に置いた
ので、同一スコープに広い `allow` ルールがあっても拾われない。ボディが壊れていて解析
できない場合は `match` が判定不能になり、`onIndeterminate = "review"` が効く。

ただし `equals { ["/variables/o"] = "my-org" }` が縛るのは**変数の値**であって、query が
実際に読む対象ではない。変数を使わず `organization(login: "my-org")` と直書きした
document はこの条件をすり抜ける。対象組織を絞りたい場合は `equals` ではなく
`graphql.rootFields` と `graphql.arguments` を使う（「GraphQL に対する対象の限定」を
参照）。この例は `match` と `expect` の使い分け、`onIndeterminate`、`BodyExpect` の働きを
示すためのものである。

### 要件 2 と 3: パスのセグメントで絞り、同じ条件で注入する

```pkl
rules {
  ["repos.read"] {
    match {
      methods { "GET"; "HEAD" }
      paths { "/repos/{org}/{repo}/**" }
      captures { ["org"] = new Listing { "my-org" } }
    }
    onMatch = "allow"
  }
  ["issues.write"] {
    match {
      methods { "POST"; "PATCH" }
      paths { "/repos/{org}/{repo}/issues"; "/repos/{org}/{repo}/issues/*" }
      captures { ["org"] = new Listing { "my-org" } }
    }
    onMatch = "allow"
  }
  ["repos.delete"] {
    match { methods { "DELETE" }; paths { "/repos/**" } }
    onMatch = "review"
  }
}
```

`my-org` 以外の組織を指すリクエストはどのルールにも一致せず、`fallback` に落ちる。
注入はスコープの `inject` により、許可されたリクエストにだけ適用される。

### 要件 4 から 6: Anthropic preset の新しい形

旧 `anthropicV1(pfx, h)` の全体を書き下したもの。nas が配布する preset モジュールの
中身であり、ユーザーは書き換えない。

```pkl
/// `anthropic@1` が許可する content block のタグ集合。
local contentTags: Listing<String> = new {
  "text"; "image"; "document"; "thinking"; "redacted_thinking"
  "tool_use"; "tool_result"; "server_tool_use"; "web_search_tool_result"
  "code_execution_tool_result"; "mcp_tool_use"; "mcp_tool_result"
  "search_result"; "container_upload"
}

/// 旧 anthropicJsonPolicy() の 5 本の TaggedUnionGuard を、exclude で 2 本に畳む。
local contentBlocks: Listing<Expect> = new {
  new UnionShape {
    at = "/**/content/*"
    exclude { "/tools/**" }
    discriminator = "type"
    allowed = contentTags
    onViolation = "review"
  }
  new UnionShape {
    at = "/system/*"
    discriminator = "type"
    allowed = contentTags
    onViolation = "review"
  }
  new JsonRoot { rootType = "object" }
}

const v1: Scope = new {
  targets { "api.anthropic.com" }
  fallback = "deny"                      // 旧: anthropic.default-deny
  rules {
    // 旧: messages.create + messages.count-tokens
    ["messages"] {
      match {
        methods { "POST" }
        paths { "/v1/messages"; "/v1/messages/count_tokens" }
        // UnionShape / JsonRoot / BodyExpect を置くルールは format = "json" を要する。
        body { format = "json" }
      }
      onMatch = "allow"
      onIndeterminate = "deny"
      expect = contentBlocks
    }
    // 旧: bodyless.* 7 本
    //
    // ボディの不在は「引き受けの条件」ではなく「引き受けたうえでの受理条件」なので
    // match.body ではなく expect に置く。match に置くと、ボディ付きのリクエストは
    // このルールに引き受けられず fallback に落ちるので、監査には「bootstrap ルールの
    // EmptyBody 違反」ではなく「fallback で deny」としか残らない。
    ["bootstrap"] {
      match {
        methods { "GET" }
        paths {
          "/api/claude_cli/bootstrap"
          "/api/claude_code_penguin_mode"
          "/api/claude_code/policy_limits"
          "/api/claude_code/settings"
          "/mcp-registry/v0/servers"
          "/v1/code/triggers"
          "/v1/mcp_servers"
        }
      }
      onMatch = "allow"
      expect { new EmptyBody {} }
    }
  }
}
```

前設計の 10 ルール（JSON 2 本、bodyless 7 本、終端 deny 1 本）が 2 ルールと
`fallback` に縮む。content block の検査は 5 本のセレクタから 1 本と `exclude` に
変わる。未知タグは 403 ではなく人間の確認に回るので、上流の API がタグを追加しても
セッションが止まらない。

`pfx` 引数が消えている。ルール ID はスコープのキーから `anthropic.messages` /
`anthropic.bootstrap` として導かれる。

## 意図的なトレードオフ

- 特異度の順序を定義できる語彙に限るので、任意の述語は書けない。文字列の式を
  マッチャに置く案は採らない。式にすると特異度の比較も重なりの検出もできなくなり、
  「どのルールが書き込みを許すか」という問いに静的に答えられなくなる。
- 曖昧な重なりを設定エラーにするので、既存の `config.pkl` は書き換えを要する。位置で
  優先を表していた設定は、ルールを狭めるか `overrides` を書く必要がある。
- 特異度で決着しない候補の順序を宣言順に委ねるので、Mapping の順序に依存する。Pkl は
  amend で既存キーの位置を保つのでこの依存は安定するが、「順序に意味がない」という
  性質は失う。位置が意味を持つのはこのタイブレークだけであり、選択の主軸は特異度の
  ままである。
- capture の値をボディ条件の右辺に置けない。パスの `{org}` と `variables.o` の一致を
  要求する書き方はできず、両方を定数で縛る形になる。
- ボディ条件で縛れるのは**ボディに値として現れるもの**だけである。要求の意味が不透明な
  ドキュメントの内部にある API では、その意味を条件にできない。GraphQL に対する対象の
  限定は削減にとどまり、境界にはならない（「GraphQL に対する対象の限定」を参照）。
- `**` を末尾に限るので、`/a/**/b` のようなパターンは書けない。
- 判定不能の既定を `deny` に寄せるので、可用性より安全側に倒れる。
- 同一ホストを複数のスコープに分割できない。ホスト内の書き分けはルールで表現する。
- GraphQL の判定に document の解析を要求するので、`match` の評価コストが JSON の
  解析だけでは済まなくなる。
- クエリ文字列は選択に参加しないので、`?` 以降で挙動が変わる API は区別できない。
- preset の受理条件を設定で緩められない。上流が追加した content block のタグは、設定
  ではなくセッションごとの承認で通す（「preset の受理条件は緩められない」を参照）。
