# Approval UI investigation

## 結論

承認プロンプトの課題は、単なる情報量不足ではない。UI 上の表現と実際の承認効果が一致していない箇所があり、特に `once`、hostexec の scope、キーボードショートカットは誤操作につながりうる。

推奨する方向は、重要な判断材料と選択中操作の効果をカード上で常時説明し、詳細だけを展開する evidence-first な承認カードである。

## この調査の扱い

この文書は発見事項を残す調査記録であり、書かれた項目をすべて同じ実装へ入れる計画ではない。今回の再実施では次の順に扱う。

1. session name と短縮 ID を表示する。
2. network の各 scope が現在の待機 request と将来 request のどこまでに効くかを常時表示する。
3. `onIndeterminate` の実際の原因を表示する。
4. opt-in 時に exact raw body を retention・容量上限付きで保存し、承認時と事後 audit から参照できるようにする。

通知 deep link、hostexec capability の完全表示、shortcut 操作、古い TODO、ローカル build の問題も有効な調査結果として残す。ただし、上の四項目を実装するために必要でなければ同じ変更へは入れない。Session 別 inbox、CLI を含む汎用 approval contract、画面全体の再設計は今回の対象外とする。

保存失敗時に承認自体を禁止するか、既定の retention・容量値、SQLite table の分け方、addon と broker の body transport は、この調査だけでは確定しない。これらは認可挙動やresource消費を変えるため、比較と実測なしに spec へ固定しない。

## 現在の表示

### Network

現在のカードには次が表示される。

- セッション短縮 ID
- ルール ID
- 経過時間
- HTTP method と host:port
- 確認理由
  - matched rule が review
  - body condition が indeterminate
  - scope fallback
  - network fallback
- path、Content-Type、body size
- request-policy violation の pointer、value、excerpt
- 注入予定の header 名と secret 名
- broker が提示した scope
- Allow / Deny

scope の意味はマウス hover 時の `title` にしかない。幅 340px の pane では、長い理由、path、違反内容がかなり縦に伸びる。

### Hostexec

表示されるのは次だけである。

- セッション短縮 ID
- command
- executable integrity warning
- `once` / `capability`
- Approve / Deny

wire 上には存在する `ruleId` と `cwd` が frontend の正規化時に捨てられている。環境変数 binding や inheritEnv など、`capability` を構成する情報も表示されない。

### Audit

Pending pane の recent audit には次しか出ない。

- timestamp
- domain / decision
- target または command

Settings の Audit ページでも session ID が増える程度で、reason、rule、scope、request path、body 診断などは表示されない。

## セッションが分からない原因

Pending SSE payload には session name がなく、`pendingStore` は常に `sessionName: null` を設定している。

一方、左 pane の sessions store には同じ session ID に対応する次の情報がすでにある。

- session name
- container name
- directory
- profile
- worktree
- agent

App は両 store を結合せず、そのまま PendingPane へ渡している。第一段階は backend 変更不要で、frontend の純粋な join で解決できる。

推奨表示:

```text
auth-refactor · aaaabb
profile: codex · ~/repo/nas
```

session chip をクリックすると、その session の terminal へ切り替える。該当 session が終了している場合だけ短縮 ID へ fallback する。

## scope が実際に許可する単位

すべて現在の broker/session のメモリ内だけで有効で、別 session や次回起動には持ち越されない。

### Network

| 表示 | 実際の効果 |
|---|---|
| `once` | 将来の cache には保存しない。ただし同時待機中の同一 group 全件を解決する |
| `this rule` | 現 session 中、同じ rule、同じ確認理由、同じ host:port |
| `host:port` | 現 session 中、同じ rule、同じ確認理由、同じ host:port |
| `host` | 現 session 中、同じ rule、同じ確認理由、同じ host の全 port |
| `these values` | 現 session 中、同じ rule、同じ expect 位置、同じ違反値 |

`this rule` は名前から想像するより狭く、target も固定される。完全一致 host+port を持つ scope にしか提示されないためである。

確認理由も cache key に含まれる。正常に読めた body を承認しても、同じ rule の `indeterminate` body までは承認されない。この分離は安全上正しい。

#### `once` の重大な食い違い

network broker は、同じ rule、reason、target に対する同時 request を group 化する。UI には request ごとのカードが複数出るが、そのうち一枚を `once` で承認すると group 全件が通る。

現在の tooltip の `Applies to this request only.` は正確ではない。実態は「この時点で同じ確認 group に待機している全 request を解決し、将来分は記憶しない」である。

#### Network Deny

Network では選択 scope が Deny にも適用される。`host` を選んで Deny すると、同じ rule/reason/host の後続 request も拒否される。

ただし UI が明示的に `once` を送った場合、broker の 30 秒 negative cache は使われない。CLI の scope 省略 Deny とは挙動が異なる。

### Hostexec

| 表示 | 実際の効果 |
|---|---|
| `once` | 将来には保存しないが、同一 capability で同時待機中の全件を解決する |
| `capability` | 現 session 中、完全一致する実行 capability を承認する |
| Deny | 選択 scope を無視し、現在の group だけ拒否する |

`capability` の同一性には次が入る。

- rule ID
- 正規化された argv0
- 全引数
- cwd
- env binding の key/source
- inheritEnv mode/keys

secret の実値は入らない。実行ファイルの変更は cache 確認より前に別途検査される。

scope 選択が Approve と Deny の共通 UI に見えることが問題である。`capability` を選択して Deny しても capability-wide deny にはならない。

さらに hostexec の設定には `prompt.defaultScope = once | capability` があるが、UI は設定を受け取らず常に `capability` を初期選択して明示送信する。設定で `once` にしても UI 操作では無視される。

## `onIndeterminate` の原因

現在 addon から broker へ送られるのは、rule ごとの三値だけである。

```text
true | false | indeterminate
```

raw body や原因コードは送られない。

`indeterminate` になりうる主な原因:

- Content-Encoding 展開などに失敗し、`flow.request.content` が取得不能
- body が rule の `maxBodyBytes` を超えた
- JSON として不正
- duplicate member を含む JSON
- `NaN` 等の非標準 JSON 定数
- JavaScript の安全整数範囲外
- JSON を要求しているが body が空
- equals/oneOf 対象の JSON Pointer が object/array を指しており scalar 比較できない
- addon と broker の不整合で body truth entry が欠落

body 自体が存在しない場合と JSON Pointer が存在しない場合は通常 `false` で、`indeterminate` ではない。

現在 UI の説明は unreadable、oversized、unparseable と候補を並べるだけで、実際の原因は addon と broker の境界で失われている。

## body を audit DB へ保存する

後から「あの承認は問題なかったか」を再検証できることを優先し、policy が実際に評価した masking 前の request body bytes を raw のまま audit DB へ保存する。preview や hash だけでは、承認時に見落とした内容を事後検証できないため不十分である。

raw body には API key、token、agent との会話、source code、PII、upload 内容、request-policy による masking 前の secret が入りうる。このため、保存しないのではなく保存場所・寿命・アクセス境界を厳格にする。

- body は host 側 audit DB の BLOB にだけ保存する
- container/agent に audit DB、body、取得 API を露出しない
- policy が評価した `flow.request.content` の exact bytes を保存する
- pending card から body を開けると表示する前に保存を完了する
- 保存失敗時は原因を `unavailable` として表示し、保存済みと誤認させない
- body を無言で truncate しない。上限超過時は保存不能を明示する
- retention 期限と総容量上限の両方で回収する
- DB、WAL、SHM を明示的に `0600` へ締める

retention だけでは、期限内に巨大 body が集中したときのディスク枯渇を防げない。そのため個別 body 上限と DB 全体の容量上限も必要になる。期限切れ body は先に削除する。それでも容量を確保できない場合に未期限の body を削除するか、新しい保存を拒否するかは未決定であり、pending evidence の寿命を増やす前に単純な「保存不能」案を比較する。

raw body 保存は top-level config で切り替えられるようにする。既存利用者が意図せず secret を永続化しないよう既定値は無効とし、有効時だけ review 対象の body を addon から broker へ送る。

設定形状の候補:

```pkl
audit {
  requestBodies {
    enable = false
    retentionSeconds = 7 * 24 * 60 * 60
    maxBodyBytes = 33554432
    maxTotalBytes = 1073741824
  }
}
```

`enable = false` は確定要件である。既定 retention、個別上限、総容量は上の例をそのまま採用せず、既存の body budget と実際の保存・transport costを確認して決める。

承認カードは `raw audit: saved / disabled / unavailable` を常時表示する。保存自体が無効な場合は、監査 body が残らないことを明示したうえで従来どおり承認できる。保存が有効なのに body が上限超過、DB 書き込み失敗、容量確保失敗などで保存できなかった場合に Approve を無効化するかは未決定とする。これは audit 表示ではなく認可 semantic の変更だからである。

raw body と併せて、検索・表示用の診断 metadata も保存する。

```ts
type RawBodyEvidenceMetadataCandidate = {
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  contentType: string | null;
  contentEncoding: string | null;
  capturedAt: string;
  expiresAt: string;
};
```

`onIndeterminate` の原因を検索・表示するための情報:

```ts
type IndeterminateDetailCandidate = {
  code:
    | "body-unavailable"
    | "body-too-large"
    | "invalid-json"
    | "duplicate-member"
    | "unsafe-number"
    | "empty-json"
    | "expected-scalar"
    | "truth-missing";
  pointer?: string;
  observedType?: string;
  observedBytes?: number;
  limitBytes?: number;
  parseOffset?: number;
};

```

データ経路の候補:

```text
mitmproxy addon
  -> policy が評価した exact body bytes と原因コードを送る
  -> broker protocol でサイズと型を厳格に検証
  -> host 側 audit DB へ raw BLOB を永続化
  -> session ID と request ID に対応する保存状態と診断 metadata を pending UI へ渡す
  -> audit log の session ID と request ID から同じ evidence を参照する
```

SQLite では通常の audit 一覧 query が BLOB を読まないことを必須にする。BLOB を既存 `audit_log` へ置くか別 tableへ置くか、decision 後に `audit_id` を書くか `(session_id, request_id)` で参照し続けるかは、最小の lifecycle を比較して決める。detail endpoint が明示的に要求したときだけ body を読む。

### Body transport の比較

#### 既存 NDJSON に bounded base64 field を追加する

既存の one request / one response を維持できる。decode 後の bytes は exact だが、wire と一時 memory は約 1/3 増える。採用する場合は `readJsonLine` の request byte 上限を先に設け、設定可能な body 上限を含めても安全なことを実測する。

#### bounded header と binary body を追加する

base64 の膨張はないが、protocol discriminator、fragment、余剰 byte、half-close、承認待ち中の disconnect を新たに扱う。前回の実装ではこの lifecycle が多数の修正を生んだため、NDJSON案がresource上成立しないと測定できた場合だけ選ぶ。

#### container から audit DB またはhost fileへ直接書く

host-only audit境界を壊すため採用しない。

追加で必要な制約:

- retention と総容量上限の設定
- DB/WAL/SHM を明示的に `0600`
- UI では折りたたみ表示
- raw 表示と copy 時の警告
- container/agent 側へ body を返さない
- expired body は metadata を残し、body が retention により削除済みだと明示する

現行 audit には body 以外にも不足がある。

- network の承認 scope が記録されていない
- authorization の method/path/content-type/body-size がない
- hostexec の rule/cwd/scope がない
- 同時 group の件数がない
- UI は backend が持つ reason/rule 等も捨てている

## 追加で見つかった問題

### 通知 deep link が機能していない（後続）

desktop notification の URL には `type/sessionId/requestId` が付与されるが、frontend は query parameter を読まない。通知をクリックしても対象 session/card へ移動しない。

### ショートカット表記が危険（scope表示の後続）

設定画面では `Ctrl+Shift+A` が `Approve (once)` となっているが、実際には選択中 scope を使用するため `host` や `capability` を承認できる。

カードに focus がなければ、先頭 network、次に先頭 hostexec を暗黙選択する。

### scope 説明が frontend にハードコードされている（今回）

backend は許可可能な scope 名だけを送り、意味は frontend 側で再構成している。このため protocol と表示が容易にずれる。

### 古い TODO が現状と矛盾する（後続）

`docs/todo/network-approval-scope.md` は「cache key が target だけ」「未着手」としているが、現コードはすでに rule、reason、target へ変更済みである。更新または削除対象。

### ローカル UI が古くなりうる（調査手順）

`src/ui/dist` は gitignored で、直接 `bun run main.ts ui` すると以前の build が表示される場合がある。Nix package では事前 build されるため release 問題ではないが、開発時の確認を誤らせる。

## 解決案

### A. 既存データで表示の嘘を先に直す

session name は既存 sessions store と pending row の frontend join だけで表示できる。scope説明も既存情報で正せる範囲はtooltipから常時表示へ移す。group件数、正確な原因、raw bodyは存在しないのでこの案だけでは完結しないが、backend基盤を待たずに最初のユーザー価値を出せる。

今回の第一段階として採用する。

### B. Evidence-first な承認カード

最終的な表示案。重要情報を inline 表示し、詳細だけ展開する。ただし、すべてを支える共通contractを先に作らず、下の表示に必要なdataを一項目ずつend-to-endで追加する。

```text
auth-refactor · aaaabb               12s ago
POST api.example.com:443
/api/messages · application/json · 82 KiB

WHY
JSON parse failed at byte 1834

THIS ACTION WILL
Allow 3 currently waiting requests.
Remember nothing for future requests.

[body evidence v]

[Allow these 3 once]        [Deny these 3]
```

永続 scope なら、選択中操作の効果を動的に表示する。

```text
Allow future requests in this session
matching rule api.messages
for api.example.com:443
when the review reason is indeterminate
```

hostexec では scope selector を Deny と共有せず、次を独立 action にする。

- `Approve once`
- `Approve this capability for this session`
- `Deny this pending group`

### C. Session 別 Approval Inbox へ全面再設計

session ごとに group 化し、detail drawer で body/capability/audit を表示する。大量 pending には強いが変更範囲が大きく、今回の対象外とする。

## 推奨実装順

### P0: UI が嘘をつかない状態にする

- session name + short ID を frontend で join
- frontendで分かる範囲のscope説明をtooltipから常時表示へ移す
- network brokerから現在のgroupと将来cacheの説明に必要な最小metadataだけを渡し、同じ変更でcardへ表示する
- `once` を current pending group、future cacheなしと正しく表示する

session chipのterminal選択、通知deep link、hostexec Deny/defaultScope/capability、shortcutは調査結果として残すが、このP0へは含めない。

### P1: indeterminate と audit の説明能力を追加

- addon で正確な `indeterminateDetail` を生成
- 選択されたruleのdetailだけをbrokerからpending cardとauditへ渡す
- このcause表示をend-to-endで完成させてからraw body保存へ進む
- policy が評価した raw body bytes をbrokerへ渡し、host側audit DBへ保存する
- pending cardとaudit detailからbodyを遅延取得する
- DB/WAL/SHM permission、retention、容量上限を明示する
- body transportはbounded NDJSON案を先に測定し、成立しない証拠がある場合だけbinary案へ進む

### P2: 意味の一元化

UI と CLI を同時移行する汎用 `ApprovalImpact` contract は今回作らない。P0でnetwork cardに必要なmetadataを限定して追加し、他consumerで同じ問題が現れてから別途一元化を検討する。

## 調査時の検証

関連する既存テストを実行した。

- network broker: 3 pass
- hostexec broker: 2 pass
- pending/card frontend: 48 pass
- failure: 0

同一 group の複数 request が一回の操作で解決されること、scope の提示条件、hostexec の `defaultScope` 挙動をテストで裏取りした。
