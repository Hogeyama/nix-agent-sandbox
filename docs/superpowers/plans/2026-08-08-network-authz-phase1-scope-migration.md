# 段階 1: スコープ体系への移行

## このドキュメントの読み方

段階 0（`2026-08-08-network-authz-phase0-static-analysis.md`）の続きである。段階 0 は
`7248cdfc feat(network): decide intersection and containment of authz matches` で完了し、
`src/network/authz/` に受理集合の交差・包含・特異度・証人を判定する純関数が入った。
**まだ何もそれを使っていない。** 既存の first-match 経路（`review_rules.ts`）は無傷で動いている。

設計は
`docs/superpowers/specs/2026-08-06-network-authorization-config-model-design.md`
に確定している。**規則を再設計しないこと。** 仕様どおりに実装し、仕様が曖昧なら実装を
止めて質問する。

段階 1 の範囲は仕様「実装の段階 > 段階 1」に列挙されている。この計画はそれを
**コミット単位に割った**ものである。

## 段階 0 の終了条件の確認（済み）

段階 0 の計画が「完了後」に指示していた `.nas/config.pkl` の 5 スコープ移行を
`targetSetsIntersect` / `targetSetsSubsume` に通した。**スコープ間のターゲット曖昧性は
ゼロ**である。危ないと目していた `*.gcr.io` / `*.api.openai.com` /
`*.data.mcr.microsoft.com` とポートなし完全一致の組み合わせは、いずれも移行後は同じ
`allowed` スコープの中に入るので、スコープ間の判定に出てこない。スコープ内の
`targets` は合併なので重なって構わない。

## コミットの割り方

段階 1 は 4 コミットに割る。**Schema.pkl を差し替えるコミット（S3）が唯一の
「大きい」コミットで、それ以外は前後どちらでも壊れない。** S1 と S2 は既存の挙動を
1 つも変えないか、変えても旧契約の中で閉じる。各コミットで `bun run check` と
`bun test src/` が通る状態を保つ。

| | 内容 | 既存挙動 |
| --- | --- | --- |
| S1 | セレクタ走査の作り直し（`exclude` / 全違反収集 / 予算切れ） | 旧契約のまま。違反時の帰結は同じ |
| S2 | ホスト側の scope 解決器（未接続） | 変わらない |
| S3 | Schema.pkl と addon と `.nas/config.pkl` の切り替え | 総取り替え |
| S4 | broker の承認同一性 | 変わる |

### マスク層は触らない

`EncodedField` の廃止（S3）に伴ってマスク層に足す仕事は無い。前の版のこの計画は
「`EncodedField` を先に外すと被覆が狭まる」として、閾値の引き下げと折り返し base64
への対応を先頭のコミットに置いていた。**どちらも誤りだったので消した。**

- 折り返された base64 は `EncodedField` でもマスクされていない。
  `_decode_strict_base64` は `validate=True` なので空白を含む値は復号に失敗し、
  `encoded-decode-failed` で拒否になっていた。被覆はもともとゼロで、廃止しても
  変わらない
- `B64_MIN_PATTERN_LEN` は 8 のまま。7 バイト未満の秘密が base64 blob の中で
  検出されないのは既知の限界であり、閉じないことがユーザーの判断である。6 文字の
  base64 パターンは無関係なボディの中の偶然の 6 文字を `****` に化けさせ、その誤
  マスクは秘密が関与しないリクエストにも起きる

仕様「書き換えを持たない」に同じことが書いてある。**マスク層のこの 2 点を「穴」と
呼んでいる記述を見つけたら、それは消し漏らしである。**

---


## S1: セレクタ走査の作り直し

addon 側の受理条件の評価を、仕様「Listing の意味」「検査が完了しないとき」
「セレクタと除外」に合わせる。**旧契約（`TaggedUnionGuard`）のまま**行う。

### 変えること

1. **`exclude` を足す。** 一致した部分木をセレクタの走査から切り落とす。除外された
   内部のノードは検査対象にならない。`_collect_selector_matches` に入る。
2. **短絡をやめる。** `_validate_tagged_unions` は最初の違反で `_PolicyBlock` を
   投げている。全要素を評価して違反をすべて集める形に変える。
3. **予算切れを違反として扱う。** `maxSelectorExpansions` / `maxNodes` を使い切ったら
   検査未完了とし、違反として扱う。所見に、予算を使い切ったセレクタと走査が到達した
   最後の JSON Pointer を含める。
4. **所見を作る。** 違反ごとに（受理条件の名前、JSON Pointer、見つかった値、そのノード
   だけの抜粋、同種の件数）を組み立てる。S4 と段階 2 が使う。抜粋は秘密をマスクし、
   深さとバイト数で打ち切る。

### 変えないこと

- 旧契約の JSON を読む形は保つ。`exclude` はスキーマにまだ無いので、resolved
  ドキュメントに現れなければ空として扱う。
- 帰結は現行と同じ（違反 → 403）。`onViolation` はまだ無い。**この段階では、全違反を
  集めてから 403 にするだけ**であり、外から見た挙動は変わらない。

### なぜ先に出すか

これは addon の中でいちばん量のある部分で、`nas_addon_mask_test.py` に Docker 不要の
テスト基盤がある。S3 に混ぜると、切り替えコミットの中で走査器のバグと選択器のバグが
区別できなくなる。

---

## S2: ホスト側の scope 解決器（未接続）

段階 0 と同じ形で、**新しいモジュールを足すだけ**にする。既存の何も置き換えない。

```
src/network/authz/config.ts     新 config の TS 型（Scope / Rule / Expect / Inject / ...）
src/network/authz/validate.ts   設定エラーと警告。段階 0 の判定を使う
src/network/authz/resolve.ts    resolved ドキュメントの生成
```

### 設定エラー

仕様「設定エラー」の箇条書きを網羅する。**証人つきの提示**は仕様「設定エラーの提示」
のメッセージ例と同じ情報を出す（段階 0 の `witness.ts` がその材料を持っている）。

エラーの一覧は仕様にあるので写すこと。取りこぼしやすいものを挙げる。

- 空の Listing（`captures` の制約 / `oneOf` の値集合 / `graphql` の各エントリ）は
  受理集合を空にするのでエラー。ルールが決して発火しないため
- `captures` がどのパスパターンにも現れない名前を制約する
- `overrides` が受理集合の交差しない相手を指す
- `mask` または `forbid` を持つスコープがある設定で `mask.proxy = false`

### 警告

仕様「設定の警告」の 2 件。

### 旧識別子の検出

`config.pkl` の**評価より前に生のソースを走査**して、廃止した識別子を見つけたら移行先を
名指しするエラーを出す。対象は仕様「旧スキーマの検出」の 12 個。Pkl の
`Unresolved reference` では移行先が分からないのでこれが要る。

### テスト

段階 0 と同じく生成テストを回せる部分は回す。少なくとも、仕様の記述例（要件 1 / 2・3 /
4〜6 の 3 つ）がそのまま解決でき、意図した設定エラーが出る設定が実際にエラーになること。

---

## S3: 切り替え

ここだけは分割できない。`Schema.pkl` を変えると下流が全部動かなくなる。

### 対象

- `src/config/Schema.pkl`: `scopes` / `Scope` / `Rule` / `Match` / `Expect` /
  `secrets` レジストリ / `limits` / `audit` を足し、旧クラスを消す
- preset を Pkl の関数から名前付きのスコープ宣言に変える。`demo.pkl`（untracked）に
  書き下しの検討結果がある
- `src/config/types.ts` / `src/config/validate.ts`: S2 の判定を繋ぐ
- `src/network/review_rules.ts`: 削除し、S2 の `resolve.ts` に置き換える
- `src/docker/mitmproxy/nas_addon.py`: 選択をスコープ + 特異度に置換。
  `match.body.format` と 3 値と `onIndeterminate`。`EncodedField` と
  `maxDecodedBytes` を削除
- `.nas/config.pkl`: 5 スコープに移行（仕様「本リポジトリの `.nas/config.pkl` の場合」に
  移行後の形がそのまま書いてある）
- `src/config/templates/*.pkl`: 3 つある。同じ移行が要る

### この段階の制限

- `onViolation` は `deny` と `allow` だけ。`review` は段階 2 で解禁する。preset は
  当面 `deny` で出す（`demo.pkl` は `review` で書いてあるので、そこだけ落とす）
- `equals` / `oneOf` / `graphql` は入れない（段階 3・4）。`format` までで止める

`format` を含める理由は、`UnionShape` / `JsonRoot` / `BodyExpect` を置くルールが
`format = "json"` を要求するためである。`format` を欠くと Anthropic preset の
`messages` ルールが書けない。

### 移行で意味が変わる 4 箇所

仕様「移行で意味が変わる箇所」に列挙されている。機械的な置換で済まないので個別に判断
すること。特に `mask.proxy = false`: 現行の `commonMask` は `proxy = false` なので、
`network.defaults.secrets { ["*"] = "ignore" }` を明示しないと起動しなくなる。

### 完了条件

現行の全プロファイルが移行後の設定で起動し、既存の統合テストが通ること。

---

## S4: broker の承認同一性

- 承認の同一性を (ルール ID, ターゲット) に変更する
- `$fallback` 擬似 ID。`$` はルールのキー構文に含まれないのでユーザー ID と衝突しない
- 承認 UI の粒度をルールの具体性から導出し、`pendingDefaultScope` を削除する
- 承認 UI が**注入されるヘッダー**を提示する。ヘッダー名と秘密の名前だけで、値は出さない

受理条件の違反から生じる承認（(ルール ID, 受理条件の識別子, 違反した値)）は段階 2 で
ある。ここでは `onMatch = "review"` から生じる承認だけを扱う。

---

## 着手前に読むもの

- `test-policy` — テストの分類・命名・cleanup の規約
- `effect-separation` — 副作用の置き場所。`src/network/authz/` は純関数を保つ
- `security-constraints` — コンテナ境界とシークレットの不変条件。S3 に効く

仕様は段階 1 に効く節を読む。

- 「秘密の名前付きレジストリ」「スコープ」「ルール」「判定の二相」（S2・S3）
- 「Match の語彙」のうち パスパターンと `format`（`equals` / `oneOf` / `graphql` は段階 3・4）
- 「受理条件 (Expect)」全体（S1・S2・S3）
- 「秘密の適用範囲」「注入」「予算」「監査」（S2・S3）
- 「設定エラー」「設定エラーの提示」「設定の警告」（S2）
- 「移行」全体（S3）
- 「書き換えを持たない」（S3。マスク層を触らない理由）
- 「ルールの同一性と承認」（S4）

## 未コミットで残っているもの

- `.nas/config.pkl` に作業中の変更（`GITHUB_TOKEN` のダミー、`api.github.com` の
  コメントアウト）。S3 で移行するときに素性を判断する
- `demo.pkl` が untracked。anthropic preset を新 config で書き下した検討用。S3 で
  `Schema.pkl` に取り込んだら消す
- `a3f202d4 tmp: test用config` が履歴に残っている
