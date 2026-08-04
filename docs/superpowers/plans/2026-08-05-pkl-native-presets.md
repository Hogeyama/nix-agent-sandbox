# pkl ネイティブ・プリセット化 + タグガード誤検知の修正

対象ブランチ: `feat/configurable-request-policies`

やりたいことは 2 つ。独立して価値があるが、どちらも同じファイル群を触るので
まとめて行う。

1. **プリセットを TypeScript 定数から Schema.pkl へ移す。** 新しいプロバイダを
   pkl だけで追加できるようにする。
2. **`anthropic@1` のタグガードの誤検知を直す。** 現状 Claude Code の実トラ
   フィックが 403 で落ちる。

---

## 背景: 現状の何が壊れているか

`ANTHROPIC_V1` のタグガードは `at = "/**/content/*"` を使っている。`**` は任意
の深さにマッチするので、メッセージ本文だけでなく

```
tools[].input_schema.properties.content
```

にまで届く。Claude Code は `content` パラメータを持つ `Write` ツールを毎回送る
ため、その JSON Schema の中身（`{"type":"string"}` 等）がタグ検査に掛かり、
`"string"` は `allowedTags` に無いので `schema-mismatch` → 403 になる。

実測で確認済み（`nas_addon._validate_tagged_unions` を直接呼んだ結果）:

```
PASS   plain messages (no tools)
BLOCK  with Write tool schema  -> schema-mismatch
PASS   nested tool_result content
```

稼働中セッションの audit にも同じものが出ていた:

```
deny | reason=schema-mismatch | POST /v1/messages
     | rule_id=anthropic.messages.create | json | block
```

統合テストは合成ボディしか使っていないため見逃されていた。

### 修正するセレクタ

本文が載る場所だけを名指しする。`tool_result` のネストは一段だけなので明示する。

```
/messages/*/content/*
/messages/*/content/*/content/*
/system/*
```

検証済みの挙動（fail-closed は維持される）:

| ケース | `/**` (現行) | 絞った版 |
|---|---|---|
| plain messages | PASS | PASS |
| **with Write tool schema** | **BLOCK** | **PASS** |
| nested tool_result | PASS | PASS |
| 未知タグ（messages 直下） | BLOCK | BLOCK |
| 未知タグ（tool_result ネスト） | BLOCK | BLOCK |
| 未知タグ（system） | BLOCK | BLOCK |

`encodedFields` の `at = "/**"` は**変えない**。あれは「構造の要求」ではなく
「base64 の運び手の候補」を指すセレクタで、非オブジェクトは skip される。

---

## 調査で確定した事実（再導出しないこと）

1. **resolved document は config から生成される。** `src/stages/proxy/stage.ts:118`
   で `resolveReviewRules(profile.network.reviewRules)` を呼び、セッションごとに
   書き出して addon が読む。`src/network/fixtures/resolved_review_rules/anthropic-v1.json`
   は参照コピー（テスト資産）であって実行時の入力ではない。
   → **pkl が普通の `ReviewRule` を吐けば、そのまま同じ経路に乗る。**

2. **`.nas/Schema.pkl` は nas が毎回上書きする。** `src/config/load.ts:325`
   「Schema.pkl を CLI アセットから .nas/ に上書き (エディタ補完用)」。手編集は
   `loadConfig` 実行後に消える（実測済み）。
   → **Schema.pkl に置いたプリセットはユーザーが書き換えられない。TypeScript
   定数だった頃と同じ不変性が保てる。**

3. **`.nas/` に残すのは 3 ファイルだけと決め打ち。** `load.ts` のコメント
   「.nas/ にはユーザーが触るファイル (config.pkl, Schema.pkl, PklProject)
   だけを残す」。
   → **別ファイル `Presets.pkl` を配るには TS 変更が要る。Schema.pkl 同梱なら
   TS 変更ゼロ。** これが Schema.pkl を選ぶ決め手。

4. **pkl のスコープ規則。** `reviewRules { ... }` のような amend ブロックの中では
   レシーバが Listing になり、**無修飾のメソッド解決がモジュールまで遡らない**。

   | 呼び方 | 結果 |
   |---|---|
   | `for (r in anthropicV1(...))` | FAIL `Cannot find method` |
   | `for (r in module.anthropicV1(...))` | OK |
   | top-level `local rs = anthropicV1(...)` → `for (r in rs)` | OK |

   プロパティは無修飾で解決される（メソッドだけの制約）。モジュール内で他の
   関数を呼ぶときも `module.` を付けておくのが安全。

5. **pkl の自己参照トラップ。** `new ReviewRule { host = host }` と書くと右辺が
   オブジェクト自身の `host` を指してスタックオーバーフローする。**関数の
   パラメータ名を `ReviewRule` のプロパティ名と衝突させない**こと
   （`h` / `pfx` / `lid` など）。

6. **`local` プロパティと関数は評価結果に出ない。** 確認済み: top-level keys は
   `ui, observability, profiles` のままで `anthropicTags` は漏れない。

7. **`pkl eval` レベルでは実証済み。`loadConfig` 経由は未検証。** 2 の上書き機構
   のせいで手編集 Schema.pkl では試せなかった。配布元 `src/config/Schema.pkl`
   に入れてアセットをビルドし直してから確認すること。

---

## 作業項目

### 1. `src/config/Schema.pkl` にプリセットを追加

- `local anthropicTags: Listing<String>`（14 タグ、現行 `ANTHROPIC_TAGS` と同じ）
- `function anthropicJsonPolicy(): JsonRequestPolicy` — **セレクタは上記の絞った版**
- `local function anthropicBodylessRule(pfx, h, lid, p): ReviewRule`
- `function anthropicV1(pfx: String, h: String): List<ReviewRule>` — 9 エンドポイント
  + 終端 deny。第 1 引数はルール ID の接頭辞（同じプリセットを複数ホストに当てた
  ときの ID 衝突を呼び出し側で避けるため）

呼び出し側の使い方をドキュメントコメントに書く:

```pkl
reviewRules {
  for (r in module.anthropicV1("anthropic", "api.anthropic.com")) { r }
  new ReviewRule { action = "review" }
}
```

一括 allow より **前** に置くこと（first-match のため）。

### 2. `src/config/Schema.pkl` からプリセット型を削除

- `class ReviewRulesPreset` を削除
- `reviewRules: Listing<ReviewRule> = new {}` に戻す

**副産物**: 要素型が union でなくなるので、commit `64f8af1d`
「fix(config): keep untyped review rules constructible」で入れた
`default = (_) -> new ReviewRule {}` の回避策が**不要になる**。削除してよい。
ただし同コミットの回帰テスト（型を書かない `new { ... }` が構築できること）は
価値があるので**残す**。

### 3. `src/config/types.ts`

- `ReviewRulesPreset` / `ReviewRuleSpec` を削除
- `NetworkConfig.reviewRules: ReviewRule[]`

### 4. `src/network/review_rules.ts`

削除するもの:
`ANTHROPIC_TAGS` / `ANTHROPIC_JSON_POLICY` / `BODYLESS_POLICY` / `ANTHROPIC_V1` /
`PRESETS` / `ImmutablePreset` / `ImmutablePresetRule` / `expandPreset` /
`presetRuleToReviewRule` / `resolveReviewRules` 内の `"preset" in spec` 分岐

- `resolveReviewRules(rules: ReviewRule[])` にシグネチャを変更
- `JSON_LIMITS` は上限検証に使っているので**残す**

### 5. fixture の再生成

`src/network/fixtures/resolved_review_rules/anthropic-v1.json` を新しい pkl
プリセットから作り直す（セレクタが変わるので中身が変わる）。参照箇所:

- `src/network/review_rules_test.ts:862`
- `src/docker/mitmproxy/nas_addon_integration_test.ts:270`
- `src/docker/mitmproxy/nas_addon_mask_test.py:292`

手で維持すると pkl 側と乖離するので、**生成スクリプトを用意するか、pkl から
生成して一致を検証するテストを足す**ことを推奨。

### 6. テスト更新

| ファイル | preset 参照数 |
|---|---|
| `src/network/review_rules_test.ts` | 27 |
| `src/config/validate_test.ts` | 16 |
| `src/stages/proxy/stage_test.ts` | 6 |
| `src/config/pkl_integration_test.ts` | 4 |

`pkl_integration_test.ts` の「serializes and expands a preset overlay」は
overlay 機能ごと無くなるので、**`module.anthropicV1(...)` を呼ぶ pkl 関数の
テストに書き換える**。

### 7. 回帰テストの追加（これが本命）

**ツール定義入りの現実的なリクエストで落ちないこと**を固定する。ガードは addon
で動くので Python 側（`nas_addon_mask_test.py`）に置く。最低限:

- `tools[].input_schema.properties.content` を含むボディが **PASS** すること
- 未知タグが messages 直下・`tool_result` ネスト・`system` の各位置で **BLOCK**
  されること

合成ボディだけを使っていたのが今回の見逃しの原因なので、**実際の Claude Code の
リクエスト形状**（system 配列・tools 配列・tool_result ネスト）を含めること。

### 8. 呼び出し側の更新

- リポジトリ直下の `config.pkl`（未追跡の作業コピー）に手書き展開した
  `anthropicV1` 相当があるので、`module.anthropicV1(...)` 呼び出しに置き換える
- `.nas/config.pkl` はコンテナ内 read-only。反映はホストで
  `cp config.pkl .nas/config.pkl` + `nas config trust` の再承認が必要

### 9. ドキュメント更新

`docs/superpowers/specs/2026-07-23-configurable-request-policies-design.md` は
TS 定数プリセットと overlay を前提に書かれている。pkl ネイティブ化に合わせて
更新すること。

---

## 意図的に失うもの（記録すること）

### `removeRules` / `addRules` のオーバーレイ検証

現状 TS が保証しているもの:

- 存在しないルール ID を `removeRules` に書いたらエラー
- `addRules` の `host` は effective host と一致必須
- `addRules` は終端ルールの直前に挿入される
- `addRules` の非 deny ルールは `requestPolicy` 必須

pkl のリスト操作で組み立てる形になるため、**これらのガードは消える**。特に
typo した `removeRules` が黙って無視される。

代替案（実装者判断）: `anthropicV1(pfx, h, remove: List<String>)` のような
パラメータを生やして pkl 側で filter する。ただし「存在しない ID を弾く」検証は
pkl では書きにくい。

### 終端 `default-deny` の `protected`

現状 preset 由来のルールは**すべて** `protected` になり、手前のルールに覆われる
と設定エラーになる。pkl 展開後に protected になるのは
`spec.requestPolicy !== undefined` のルールだけなので、**`requestPolicy` を持た
ない終端 deny が保護されなくなる**。誰かが手前に `allow(host)` を書くと静かに
素通りする。

緩和案（実装者判断）: `validateProtectedShadowing` の protected 判定を
「`requestPolicy` を持つ **または** `id` を持つ」に広げる。ID 付きルールは
意図的に名前を付けたルールなので、黙って覆われるべきではない、という理屈。

### 失われないもの

**プリセット内容の不変性は保たれる。** 上記「確定した事実」の 2 のとおり
`.nas/Schema.pkl` は毎回上書きされるので、ユーザーはプリセット本体を書き換え
られない。

---

## 検証

- `bun run check`
- `bun run test:unit`
- `bun run test:integration`
  - Docker 統合テストは nas セッション内から走らせる場合 DinD (`docker { enable = true }`)
    が要る。`NAS_DIND_SHARED_TMP` が立っていないとホスト `/tmp` を前提にして
    bind mount に失敗する
  - `nas-mask-filter --supervise > fails closed ...` の失敗は**環境要因**で本件
    とは無関係（ホスト側 bun からコンテナの `bash.real` を env 無しで起動して
    ライブラリ解決に失敗する）。develop 単体でも落ちる
- **実機確認**: `anthropic-policy-demo` プロファイルでセッションを起動し、
  audit.db に `reason=schema-mismatch` / `rule_id=anthropic.messages.create` の
  行が出ないことを確認する。クエリ例:

```sql
SELECT timestamp, decision, reason, method, route, rule_id,
       request_policy_kind, request_policy_result
FROM audit_log
WHERE request_policy_result IS NOT NULL
ORDER BY timestamp DESC LIMIT 20;
```

（`~/.local/share/nas/audit/audit.db`。`target` は outcome 行では NULL なので
`target` で絞らないこと）
