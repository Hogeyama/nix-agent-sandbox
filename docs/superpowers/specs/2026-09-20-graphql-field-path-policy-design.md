# GraphQL の取得経路を限定する

状態: 実装済み。ホスト・addon・`.nas/config.pkl` を新語彙へ移行した。
稼働中のサンドボックスの設定は次の起動から新しいルールを読む。

## この文書で決めること

対象読者は、信頼する GitHub owner の日常的な読み取りを自動許可し、それ以外は人間に
確認したい設定管理者と実装者である。root field と owner/login の制限を既に知っている
読者が、どの取得を自動許可できるか、その保証と設定コストを判断できるようにする。
問題、設定例、判定規則、承認、実装契約、受け入れ条件の順に読む。

既存の認可モデルは [ネットワーク認可の設計](2026-08-06-network-authorization-config-model-design.md)
を参照する。本書は GraphQL 条件を置き換える仕様であり、HTTP の選択順位や他の expect を
変更しない。実装の順序は [実装計画](../plans/2026-09-20-graphql-field-path-policy.md) に分ける。

## 問題と目標

信頼する organization を入口にしても、次の query はメンバーの star 経由で第三者の
リポジトリにある Issue、コメント、README を取得できる。

```graphql
query {
  organization(login: "my-org") {
    membersWithRole(first: 10) {
      nodes {
        starredRepositories(first: 10) {
          nodes {
            issues(first: 10) {
              nodes { body comments(first: 10) { nodes { body } } }
            }
            object(expression: "HEAD:README.md") { ... on Blob { text } }
          }
        }
      }
    }
  }
}
```

現行の operations/rootFields/arguments だけではこの query を許可してしまう。
組織が private repository だけを使っていても、メンバーの star は外部へ出られる。
GitHub の [Organization](https://docs.github.com/en/graphql/reference/orgs#organization) と
[User](https://docs.github.com/en/graphql/reference/users#user) の定義もこの関係を持つ。

目標は、**明示的に許可した末端フィールドへの経路だけで構成された query を自動許可し、
それ以外の取得経路を含むリクエストは全体を review または deny にすること**。
`review` は UI 上の ask に相当する。本文を自然言語で安全判定する機能ではない。

`security.md` の C が要求する「信頼境界外のコンテンツの無人流入を防ぐ」ための道具に
する。ただし、信頼するデータの範囲は設定管理者が決める。owner が一致することから
全投稿者の信頼を推論しない。private repo の本文・コメントを信頼する運用なら、その
経路を明示的に許可できる。外部投稿者や取り込んだ外部テキストまで安全にはならない。

## 設定管理者が書くもの

`GraphqlMatch` の `rootFields` と全域 `arguments` を廃止し、必須の `fieldPaths` と
経路別の `fieldArguments` に置き換える。旧設定との互換性は持たせない。
両方とも `match.body.graphql` と `BodyExpect.graphql` で使用できる。
入口を持つ HTTP ルールは広く捕捉し、取得内容の条件は expect に置く形を推奨する。

```pkl
rules {
  ["graphql.read"] {
    match {
      methods { "POST" }
      paths { "/graphql" }
      body { format = "json" }
    }
    onMatch = "allow"
    onIndeterminate = "review"
    expect {
      new BodyExpect {
        graphql {
          operations { "query" }
          fieldPaths {
            "/repository/nameWithOwner"
            "/repository/issues/nodes/body"
            "/repository/issues/nodes/comments/nodes/body"
            "/repository/issues/pageInfo/endCursor"
            "/repository/issues/pageInfo/hasNextPage"
            "/repository/object/text"
            "/organization/login"
            "/organization/membersWithRole/nodes/login"
          }
          fieldArguments {
            ["/repository"] { ["owner"] { "my-org" } }
            ["/organization"] { ["login"] { "my-org" } }
          }
        }
        onViolation = "review"
      }
    }
  }
}
```

この例では自 organization のメンバーの login は読めるが、そのメンバーの
starredRepositories は読めない。README の経路は `repository(owner: "my-org", ...)`
から始まるものだけを許可する。同じ `text` や `body` という名前でも、別経路からの
取得は許可しない。ページングの `nodes`、`edges`、`node` は実際のフィールド名なので
省略・相互変換せず、使用する経路をそれぞれ列挙する。

fieldArguments に書かない引数はこの追加条件では制約しない。上の `name`、`first`、
`after`、`expression` などが該当する。値により信頼範囲が変わる引数は管理者が制約する。
この機能はサーバのスキーマや引数の意味を自動で理解するものではない。

## 経路の意味

### 末端の完全一致と途中のフィールド

`fieldPaths` は取得を許す末端フィールドの経路の非空 Listing である。
`/` から始め、各要素は GraphQL Name (`[_A-Za-z][_0-9A-Za-z]*`) とする。
JSON Pointer ではなく GraphQL の選択経路であり、配列 index、escape、alias、型名は
含めない。`*`、`**`、空要素、末尾 `/`、空文字列を拒否する。大文字小文字を区別する。

判定は出現ごとに行う。

- 子の selection set を持たない field は、その経路が Listing に完全一致する必要がある。
- 子を持つ field は、許可経路の真の接頭辞でなければならず、子もすべて検査する。
- `/repository/issues/nodes/body` を許すと、その途中の field を通過できる。
  `/repository` 自体や、その下の任意の field を取得する権限にはならない。
- `/repository` だけを Listing に書いても、`repository { issues { ... } }` は許さない。
- 許可経路をすべて要求する必要はない。許可経路の部分集合で構成した query を許す。
- `__typename` を含む introspection 名にも特別な自動許可はない。

`fieldPaths` の省略、null、空 Listing は設定エラーにする。経路を制約しない GraphQL
条件は提供しない。旧キー `rootFields` / `arguments` も設定エラーとし、無視しない。

### Alias、fragment、operation

alias を捨て、AST の実フィールド名を使う。
`safe: starredRepositories` は `starredRepositories` として検査する。

named fragment と inline fragment は全階層で展開し、使用位置の経路を引き継ぐ。
同じ fragment が異なる親に現れれば、それぞれの経路で検査する。fragment 名だけで
検査済みと扱ってはならない。同一経路でも field の別出現や operation ごとの変数値を
まとめてから引数を検査してはならない。

型条件 (`... on Blob` など) は経路要素にせず、全分岐を検査する。スキーマを取得しない
ため、実行されない型分岐だと推測して除外しない。**同じ経路を型ごとに区別する機能は
ない**。管理者はその経路で取り得る型の意味も確認し、型によって信頼範囲が変わり、
区別が必要ならその経路を自動許可しない。

`operationName` に関係なく、文書中の全 operation を検査する既存の方針を維持する。
未使用 fragment は独立した取得経路を作らない。未定義・循環の拒否は維持する。
未使用 fragment の無害な名前を許可経路に混ぜて、使用中の違反を相殺できない。

`@skip` と `@include` の条件に関係なく両方の選択を検査する。この2つ以外の directive
を到達可能な operation/field/fragment に使用した場合、解析結果を判定不能にする。
未知 directive の意味を推測して自動許可しない。

## 経路に紐づく引数条件

`fieldArguments` は「フィールド経路 → 引数名 → 許可する文字列」の Mapping とする。
省略時は空 Mapping となる。各キーは許可末端またはその途中の経路でなければ
ならない。空の引数 Mapping、空の値 Listing、不正な名前や経路は設定エラーにする。
最外の Mapping の空は制約なしである。

その field が query に現れたとき、指定した引数が**その出現に存在し**、解決後の文字列が
許可集合に含まれることを要求する。field 自体の出現は要求しない。

| 状況 | match の真理値 | expect |
| --- | --- | --- |
| 対象 field が無い | この条件は満たす | 違反なし |
| 必須引数が無い | false | 違反 |
| 文字列が許可外 | false | 違反 |
| 文字列として解決できない | indeterminate | 違反 |
| 同じ field が複数あり、1つだけ不正 | 全体を false / indeterminate | 違反 |

変数の値・既定値は既存の `resolveArgumentValue` / `_resolve_graphql_argument` と同じ
規則で、**その operation の文脈**で解決する。明示的 null や数値を文字列化しない。
引数名が重複する field は曖昧なので、解析結果を判定不能にする。

`operations`、`fieldPaths`、`fieldArguments` はすべて AND である。
他の field や directive にある `owner` で `/repository` の必須 owner を満たすことは
できない。異なる出現の owner/name の組合せを混ぜることもない。

## 失敗時の動作と承認

既知の経路違反は match では false、expect では違反にする。解析不能、未知 directive、
予算超過、必要な facts の欠落は、match の indeterminate / expect の
違反にする。AND 内に false と indeterminate があれば既存どおり indeterminate を優先する。

match の false は別ルールへ進み得る。したがって、安全な設定例では POST /graphql を
捕捉して expect で全取得を検査し、fallback は review とし、別の無条件 allow を置かない。
URL query string、UTF-8 application/json 制限、重複ヘッダー等の既存ガードは弱めない。

新しい違反レコードは既存の `kind = schema-mismatch` を使う。`at` と `pointer` は
文書を運ぶ JSON Pointer、`excerpt = null`、`value` は毎リクエスト生成する UUID とする。
`label` にマスク・長さ制限済みの以下の理由を載せる。

```text
fieldPath:/organization/membersWithRole/nodes/starredRepositories/nodes/object/text
fieldArgument:/repository@owner=(missing)
fieldArgument:/repository@owner=(unresolved)
fieldArgument:/repository@owner=(not-allowed)
```

経路違反は許可外の末端ごとに記録する。同じ末端の反復は表示上まとめてよいが、引数は
全出現を検査する。本文、alias、引数の実値、parser の例外文は表示しない。
構造を解析できない場合は既存の `document:(unanalysable)` として扱う。

新しい違反そのものの承認は、そのリクエストにだけ有効とする。経路だけをセッション中の許可キーにすると、
同じ経路を使う別 repo や別の子選択まで承認したことになってしまうためである。
既存の `label` 付き UUID 違反と `violationScopesFor` の動作を使い、broker の承認キーを
変更しない。GraphQL の違反だけなら UI は `once` のみになる。他の値単位違反が混在する
ときは既存どおり `violation` も選べるが、記憶できるのは従来の値の部分だけである。
新しい違反は UUID が変わるため、同じ経路でも次の要求は改めて review になる。
例えば別の BodyExpect.equals/oneOf の値を記憶しても、GraphQL の経路・引数違反を
承認済みにしてはならない。旧 GraphQL の引数値単位承認は引き継がない。
違反数の上限で切れた場合は `findings-truncated` により承認不能にする既存規則を維持する。

match 側の未解決引数には `graphql-unresolved-field-argument` 診断を追加する。
内容は設定由来の `pointer`、`fieldPath`、`argument` のみとする。
不足した必須引数は false なので、この診断を出さない。
承認画面だけで判断できない場合は deny する運用を前提にし、レスポンスの内容を
リクエスト前に分かったものとして表示しない。

## 実装契約

### 設定と facts

```ts
interface GraphqlMatch {
  readonly at?: string; // 既定値 /query
  readonly operations: readonly GraphqlOperation[];
  readonly fieldPaths: readonly string[];
  readonly fieldArguments?: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
}

interface GraphqlFieldOccurrence {
  readonly path: string;
  readonly leaf: boolean;
  readonly argumentValues: Readonly<Record<string, string>>;
  readonly unresolvedArguments: readonly string[];
}

interface GraphqlDocument {
  readonly operations: readonly GraphqlOperation[];
  readonly fields: readonly GraphqlFieldOccurrence[];
}
```

parser は完全な GraphqlDocument または null を返す。有効な facts は少なくとも1つの
operation と末端を持つ。予算超過等で経路を検査しきれなければ文書全体を null にし、
root/全域引数だけの部分的な facts にフォールバックしない。
欠落・旧形式の手書き facts を空集合として許可してはならない。テストも新形式へ移行する。

TypeScript の `graphql.ts` は参照実装、実通信での解析は Python addon が担当する。
GraphQL 本文・AST・生の引数値を broker に渡さない。facts はリクエスト内だけで保持する。
メモ化は変数を解決する前の AST/構造に限り、変数、operation の既定値、適用 limits が
異なる評価に誤って解決済み facts を共有しない。

### 解析予算

新しい設定用 limits は追加しない。既存の token 数・AST 深さの検査を残し、その上で
全 operation からの展開を反復スタックで行う。展開中に訪れた field、inline fragment、
fragment spread をそれぞれ1として、文書全体で `maxNodes` を上限とする。
引数は既存 token 制限でも制約されるが、展開後に評価する各引数出現も1として数える。
重複をまとめる前に課金し、ダイヤモンド状の fragment 展開を無制限に展開しない。
展開後の field の入れ子段数にも `maxDepth` を適用する。
予算が尽きたとき途中までの facts で true にしてはならない。

訪問と引数だけを数えると、1 課金の裏の仕事量が定数にならない。1 つの訪問には
directive が何個でも付けられ、しかも spread で同じノードに再到達するたびに走査し
直す。GraphQL の Name はどれだけ長くても 1 token なので、出現ごとに作る経路の
文字列は本文サイズだけで決まる。そこで次の 2 つも同じ `maxNodes` から引く。

- 走査した directive 1 つ。operation、変数定義、selection、使用される fragment
  定義のどこに付いていても、そのノードに到達するたびに数える。
- 出現に記録する経路の 64 バイト (`floor(len(path)/64)`)。出現そのものの課金に
  上乗せする。

これにより「走査する directive 数 ≤ `maxNodes`」と「保持する経路の総バイト数
≤ 64 × `maxNodes`」が成り立ち、小さな本文で大量の CPU・メモリを使わせられない。
64 は実装内部の定数であり、設定項目にはしない。ホストと addon は同じ値を使う
(片側だけ違うと、同じ document で片方だけが解析不能になる)。

この課金の代償として、**合法だが非常に深く、長い名前を並べた query は解析不能と
して拒否され得る**。予算超過は match の判定不能・expect の違反に倒れるのであって、
自動許可には倒れない。実際に落ちる設定に当たったら、`maxNodes` を上げるか、その
取得をやめるかを設定管理者が決める。

### 正規化、関係判定、解決済み設定

正規化では必須 fieldPaths を重複除去し、fieldArguments の省略は空 Map にする。
ResolvedGraphql の JSON にも `fieldPaths` と `fieldArguments` を常に含める。
rootFields / arguments は解決済み JSON からも削除する。Python の exact-key 検証も
同時に変更する。契約 version は既存の1のまま再定義し、旧 addon は新形式を拒否、
新 addon は旧形式を拒否する。旧形式の読込み・補完・変換は実装しない。
ホスト、addon、リポジトリ内の設定・fixture を同じ変更単位で新形式に揃える。

静的解析が新制約を無視して「同じ条件」「包含」と判断することを禁止する。
`a ⊆ b` の経路に関する十分条件は次のとおり。

1. a の許可末端集合が b の部分集合である。
2. b の必須 fieldArguments がすべて a にあり、a の許可値集合が b の部分集合である。
3. a の operations が b の部分集合である。

この十分条件で証明できなければ「包含しない」に倒す。実際には出現し得ない経路の
制約などを使う追加の最適化は不要。交差は、operations または許可末端集合が互いに素なら
否定できる。それ以外は保守的に「交差し得る」とする。GraphQL 条件自体が無い場合の
他ルールとの比較は、既存のボディ条件の規則に従う。

交差の証人は、共通の許可末端に至る field の鎖と、各 field に必要な引数の許可共通値
から作る。作れなければ null を返し、交差しない
証明と取り違えない。表示する証人の文書と facts が同じ選択と引数を表すことを検証する。

## 導入範囲と旧形式の廃止

後方互換は不要。旧キーの受理、経路制限を省略するモード、旧 facts の読込み、旧 GraphQL
診断・承認の互換分岐を残さない。旧設定は起動時に設定エラーとし、fieldPaths と
fieldArguments への明示的な書換えを要求する。元の rootFields から `/**` 相当の許可を
自動生成してはならない。リポジトリ内の実行対象の設定・fixture・テスト・現行利用例は
同時に移行する。過去の設計履歴には置換先を明記して残してよい。

実装時には、このリポジトリの `.nas/config.pkl` の共通 GraphQL ルールを経路制限へ
移行し、claude/codex/copilot/graphql-demo に適用する。初期の許可範囲は下表とする。
必要な field を追加するたびに取得範囲をレビューする。実装前に新キーを書いてはならない。

| root | 自動許可する末端 | 必須引数 |
| --- | --- | --- |
| repository | `nameWithOwner`, `url`, `issues/nodes/number`, `issues/nodes/title`, `issues/nodes/body`, `issues/nodes/comments/nodes/body`, `issues/pageInfo/endCursor`, `issues/pageInfo/hasNextPage`, `pullRequests/nodes/number`, `pullRequests/nodes/title`, `pullRequests/nodes/body`, `pullRequests/nodes/comments/nodes/body`, `pullRequests/pageInfo/endCursor`, `pullRequests/pageInfo/hasNextPage`, `object/text` | owner = Hogeyama または hogeyama |
| organization | `login` | login = Hogeyama または hogeyama |
| user | `login` | login = Hogeyama または hogeyama |
| repositoryOwner | `login` | login = Hogeyama または hogeyama |

全末端に `/root/` を付けた完全経路を設定する。mutation、未知の経路、他 owner は review。
広い別ルールがこの条件を迂回しないことも検証する。REST/Web/Git の許可範囲は今回変更
しない。REST の starred 一覧には第三者の description が含まれ得るが、README 本文は
別の `/repos/{owner}/{repo}/readme` への要求であり、GraphQL 内の横断と同一視しない。
GraphQL の経路制限を、GitHub 全通信の安全性の保証として説明しない。

## 受け入れ条件

| ID | 入力・条件 | 結果 |
| --- | --- | --- |
| A1 | 上の organization → member → star → Issue/README の反例 | expect 違反、review。upstream に未承認で送らない |
| A2 | 許可 owner の repository → Issue 本文・コメントだけ | allow |
| A3 | 許可 owner の repository → object → Blob.text | allow |
| A4 | 同じ body/text を author、fork、parent 等の別経路から取得 | review |
| A5 | alias で禁止 field を許可名に見せる | A1/A4 と同じ違反 |
| A6 | named/inline fragment で A1 を隠す、同一 fragment を安全・不安全な親の両方で使用 | 不安全な出現を検出 |
| A7 | 禁止経路に skip/include、型条件を付ける | 条件に関係なく違反 |
| A8 | 未知 directive、重複引数、循環・未定義 fragment、展開予算超過 | 自動許可しない |
| A9 | owner を省略、別 field の owner で代用、片方の alias だけ owner 不正 | 違反 |
| A10 | owner が変数・既定値・明示 null・数値、複数 operation で既定値が異なる | 既存の値解決規則を出現ごとに適用 |
| A11 | 許可末端の子を追加、nodes を edges/node に変更、未許可 __typename を追加 | 自動許可しない |
| A12 | 許可・禁止の取得が混在 | 全体を review/deny。安全部分だけを送信しない |
| A13 | 経路違反を once 承認後、同経路で repo/引数/子選択を変えて再要求 | 再度 review |
| A14 | GraphQL 違反と他の値単位違反が混在、表示が省略・切り詰められる | GraphQL 違反は記憶しない。上限超過は承認不能 |
| A15 | 不正な fieldPaths/fieldArguments、旧・新設定と addon の混在 | 設定を拒否し、制約を黙って捨てない |
| A16 | 新制約を含むルールの包含・交差・証人 | 実評価と矛盾してルール選択を緩めない |
| A17 | fieldPaths 省略・null・空、旧キー指定、旧形式 facts | 設定は拒否。文書の有効な facts が無ければ判定不能。旧評価へ戻らない |
| A18 | Content-Type、URL query string、body limit の既存反例 | 既存ガードを維持 |
| A19 | 通常4プロファイルで自 owner の許可経路、他 owner、反例、REST README | 意図した allow/review と既存 REST の境界を確認 |

## なぜこのアプローチを選んだか

必要な取得だけを増やせる経路の許可制を選ぶ。フィールド追加や新しい横断が生じても、
未登録の経路は自動許可にならない。root 制限だけでは存在しなかった検査範囲を明示できる。
引数を経路と出現に結び付けるのは、別の場所の owner で所有者検査を満たさせないため。
既存の AST パーサ・expect・一回限り承認を使い、外部スキーマの取得は必要にしない。

## なぜ他の方法を選ばないか

- `starredRepositories` 等の禁止リストは、新しい横断を列挙し続けなければならない。
- query 全文のテンプレート登録は、alias、fragment、取得項目の部分集合、ページング等の
  日常的な組合せにも登録負担を生む。今回はユーザーが選んだ経路単位の表現を使う。
- GitHub スキーマによる所有者の自動追跡は、型の関係だけでは内容の信頼を証明できず、
  API 固有の意味とスキーマ更新への追従を必要とする。今回の範囲を越える。
- レスポンスから危険なテキストを分類して除く方式は、誤分類と配信前の完全検査が別の
  問題になる。今回はリクエストの取得範囲を制限し、本文の安全判定は行わない。
