# TODO: ネットワーク承認スコープを (ルール × ターゲット) に組み替える

優先度: **P2**（実害は「UI の約束と挙動の食い違い」＋「ルール跨ぎの軽微な過剰許可」。
認可セマンティクスとプロトコルに跨るので、単発の bugfix ではなく設計変更として扱う）

状態: 未着手。`feat/configurable-request-policies` では**文言修正のみ**で凌いでいる
（`PendingPane.tsx` の scope チップに `title` を付けた）。

---

## 現状

`SessionBroker.authorize()` の判定順（`src/network/broker.ts:350-415`）:

1. `findMatchingRule()` → マッチ無しなら deny (`no-matching-rule`)
2. マッチしたルールの `action === "deny"` → deny して return
3. `action === "allow"` → allow して return
4. ここまで来る = `action === "review"`。**ここで初めて**セッションの
   `deniedTargets` / `deniedHosts` / `approvedTargets` / `approvedHosts` を見る
5. どれにも当たらなければ pending キューへ

つまりキャッシュは「**どれかの review ルールにマッチした**リクエスト」にしか効かない。
一方キャッシュのキーは host / host:port だけで、**どのルールで承認したかを覚えていない**。

- スコープの値: `once` / `host-port` / `host`（`ALLOWED_NETWORK_SCOPES`, `broker.ts:101`）
- pending グループのキー: `${sessionId}:${host}:${port}`（`broker.ts:443`）
- `PendingGroup.allowedScopes` (`broker.ts:87`) は既にグループ単位でスコープの上限を持つが、
  今は常に定数 `ALLOWED_NETWORK_SCOPES` を入れているだけ（`broker.ts:494`）

## 問題

### 1. UI の "host" が host を意味しない

`config.pkl` の実例:

```pkl
:124  new { method = "POST"; host = "httpbin.org"; action = "review" }
:133  "httpbin.org",   // 127-134 の allow(h) ループ内
```

1. `POST https://httpbin.org/post` → `:124` にマッチ → pending
2. scope=`host` で Deny → `deniedHosts.add("httpbin.org")`
3. `GET https://httpbin.org/get` → `:124` は `method = "POST"` なのでマッチせず `:133` の
   `allow` にマッチ → **上記の判定順 3 で return するのでキャッシュを見ずに allow**

`main` では 2 の直後から httpbin.org 宛が全部止まっていた（`main` の `authorize()` は
キャッシュ → `findMatchingRule` の順）。設計ドキュメントは現行挙動を意図と明記している:

> Approval and denial caches apply only while resolving a currently matched `review`
> rule. They do not override explicit `allow` or `deny` rules.

挙動は設計どおり。**ラベルが実態より広い約束をしている**のが問題。

### 2. ルール跨ぎの過剰許可（approve 側）

review ルール A で host X を scope=`host` で Allow すると、**別の** review ルール B に
マッチする X 宛リクエストも無確認で通る。ルール B が別の意図（別 method / 別パス /
requestPolicy 付き）で人間の確認を求めていても、キャッシュがそれを飛ばす。

## 却下した案: スコープを `once` / `cache`（ルール単位）の 2 択にする

「キャッシュのキーにルールが入っていないのが原因」までは正しいが、**ターゲット軸を
捨てるとルールが広いときに破綻する**。`config.pkl` の review ルールは 2 本:

```pkl
:124  new { method = "POST"; host = "httpbin.org"; action = "review" }   // 狭い
:137  new { action = "review" }                                          // catch-all
```

`:137` は未知のホスト全部にマッチする。ルール単位キャッシュにすると、未知ホストを 1 つ
Allow しただけで**以後あらゆる未知ホストが無条件 allow** になる。catch-all review は
「知らない通信を人間に見せる」ための最重要ルールなので、そこが最も壊れる。
ワイルドカードホスト（`*.gcr.io`）や host 無しルール（`method = "POST"` だけ）でも同じ。

## 対案: キーを (ルール, ターゲット) の複合にする

軸を捨てず足す。そのうえで**提示するスコープをルールの具体性から決める**
（`PendingGroup.allowedScopes` が既にその器）。

| マッチしたルール | 出すボタン | 意味 |
|---|---|---|
| host が完全一致で固定（`:124` など） | `once` / `always` | always = このルールが効く間ずっと |
| host が広い or 無い（`:137`, `*.gcr.io`） | `once` / `host:port` / `host` | いずれも「このルールの中で」 |

狭いルールでは選択肢が 2 つになり**嘘をつきようがなくなる**（"host を止める" と言えない
ので、explicit allow に負ける話自体が発生しない）。広いルールでは現在の粒度が残る。
UI の `title` による補足は不要になる。

## 作業項目

1. **グループキー**。今は target だけなので、**1 グループに別ルールのリクエストが混ざる**
   （`PendingGroup.matchedRules` が request → ReviewRule の Map になっているのがその証拠）。
   ルール相対の決定にするならキーを (target, rule) にする
2. **ルールの同一性**。`ReviewRule.id` は optional で catch-all には id が無い
   （`src/config/types.ts:150`）。`id ?? "#" + sourceIndex` で足りる。config はセッション中
   不変なので `sourceIndex`（`review_rules.ts:47`）は安定
3. **キャッシュ構造**。`approved/denied` × `Targets/Hosts` の 4 セットを、ルール ID で
   引ける形に組み替える
4. **`allowedScopes` の算出**。`broker.ts:494` の定数を、マッチしたルールから導出する関数に
5. **UI**。`NETWORK_SCOPES` を pending エントリが申告する `allowedScopes` から描画する
   （現在はフロント側の定数。バックエンドは既に検証しているので、表示を追従させるだけ）

## 影響範囲（プロトコル面）

`ApprovalScope` の値は以下に露出している。値を変えると CLI フラグの互換と、過去 audit
との意味の連続性が切れる。

- broker メッセージ (`approve` / `deny` の `scope`)
- `nas network approve|deny --scope`（`src/cli/network.ts:33` に選択肢がハードコード）
- UI の REST (`src/ui/routes/api.ts:39` の `NETWORK_SCOPES` で検証)
- audit の `scope` 列（`src/audit/store.ts:86`）

hostexec 側のスコープ（`once` / `capability`）はこの問題と無関係。触らない。

## 副産物

「deny キャッシュを explicit `allow` ルールより優先させるべきか」という保留中の設計判断
（`2026-08-06-handover-review-scope-ui.md` の案 2）が**消滅する**。ルール相対なら
キャッシュは他ルールを覆うと主張しないので、優先順位を決める必要がない。
「このホストを完全に止めたい」は設定変更の仕事、と言い切れる。

## 決めていないこと

- `always`（狭いルール用）を内部的に別スコープ値にするか、`host-port` の別名として
  扱うか。audit の可読性とプロトコル互換のトレードオフ
- ルールが `host` を持つが `*.example.com` のようなワイルドカードのとき、`always` を
  出してよいか（ホスト集合が固定でないので `host` 相当に落とすのが安全側）
- セッションを跨ぐ永続化は現状どこにも無い（すべてセッション寿命）。この変更でも
  そのままにする前提
