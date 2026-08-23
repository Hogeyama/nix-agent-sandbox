# Approval UI investigation

## 結論

当初の主要課題は実装済みである。

1. network / hostexec の `once` は、押した request 1 件だけを解決する
2. pending card は session name と short ID を表示する
3. network card は、選択中 scope の効果と lifetime を本文に表示する
4. `onIndeterminate` は closed diagnostic で実際の原因を表示する
5. opt-in 時は masking 前の exact request body を host SQLite に保存し、
   pending と audit から遅延取得できる
6. 240px の pending pane でも長い session name、rule ID、SHA-256、body、
   Content-Type が横にはみ出さない

残る承認 UI の主要な不一致は hostexec である。scope selector は Approve にだけ
効くが Deny と共有して見え、UI の初期値は設定の `prompt.defaultScope` ではなく
常に `capability` である。次に変更するなら、この一件だけを独立して扱う。

## 現在の表示と挙動

### Session identity

`App` が sessions store と pending row を `sessionId` で join し、network と
hostexec の両カードに次を表示する。

```text
<session name> · <short ID>
```

name を解決できない場合は short ID だけを表示する。pending payload と
pending store は session name を所有しない。session chip は現在クリック操作を
持たず、terminal への切り替えは行わない。

### Network card

現在のカードには次が表示される。

- session name と short ID
- rule ID と経過時間
- HTTP method と host:port
- review になった理由
- `onIndeterminate` の body diagnostic
- path、Content-Type、body size
- request-policy violation の pointer、value、excerpt
- 注入予定の header 名と secret 名
- raw-body audit の保存状態と、保存済み body の遅延表示
- broker が提示した scope
- 選択中 scope が現在の group と将来 request のどこまでに効くか
- Allow / Deny

scope の意味は tooltip だけでなくカード本文に常時表示する。意味の文章は
frontend にハードコードされているため、broker の semantic を変更するときは
同じ変更で表示とテストも更新する必要がある。

### Network scope

すべて現在の session 内だけで有効で、別 session や次回起動には持ち越さない。

| 表示 | 現在の request への効果 | 将来 request への効果 |
|---|---|---|
| `once` | 押した request 1 件だけを解決し、同じ group の sibling は pending のまま | 記憶しない |
| `this rule` | 現在の group 全件を解決 | 同じ rule、reason、固定 host:port |
| `host:port` | 現在の group 全件を解決 | 同じ rule、reason、host、port |
| `host` | 現在の group 全件を解決 | 同じ rule、reason、host の全 port |
| `these values` | 同じ violation identity で待つ group 全件を解決 | 同じ rule、expect 位置、違反値 |

`this rule` は、authorization scope が target を exact host:port に固定するときだけ
提示される。そのため現在の cache key でも target は固定される。

Network の Allow と明示 scope 付き Deny は同じ単位を使う。UI は常に scope を
明示するため、scope を省略する legacy / CLI Deny の 30 秒 negative cache は
UI 操作では使われない。

### Hostexec card

現在表示するのは次である。

- session name と short ID
- command
- executable integrity warning
- `once` / `capability` selector
- Approve / Deny

wire の pending entry にある `ruleId` と `cwd` は frontend の正規化時に捨てて
おり、表示しない。capability を構成する env binding と `inheritEnv` も表示しない。

現在の操作 semantic は次のとおりである。

| 操作 | 効果 |
|---|---|
| Approve + `once` | 押した request 1 件だけを解決し、将来には記憶しない |
| Approve + `capability` | 現在の同一 capability group を解決し、session 中の完全一致 capability を承認する |
| Deny | selector を無視し、押した request 1 件だけを拒否する |

capability identity には rule ID、正規化 argv0、全引数、cwd、env binding の
key/source、`inheritEnv` mode/keys が入る。secret の実値は入らない。

UI は未選択時に常に `capability` を選び、その値を明示送信する。したがって
backend が scope 省略時に使う `prompt.defaultScope` は、現在の UI 操作には
反映されない。

### Audit

Pending pane の recent audit は次を表示する。

- timestamp
- domain / decision
- target または command
- body diagnostic（存在する場合）
- raw-body audit status（存在する場合）
- 保存済み raw body の遅延表示

Settings/Audit はこれらに session ID と filter / pagination を加える。

backend の audit row が持つ `reason`、`ruleId`、`scope`、request-policy の
method / route、violation detail などは、現在の frontend row または表示で
すべては利用していない。これは raw-body viewer の未実装ではなく、audit 表示の
別の情報設計課題である。

## `onIndeterminate` diagnostic

addon は rule ごとの truth と、truth が `indeterminate` の rule に対応する
closed diagnostic を authorize request に載せる。broker は実際に選択した
rule の diagnostic だけを pending と authorization audit に保存する。

現在の型は次である。

```ts
type BodyDiagnostic =
  | { code: "body-unreadable" }
  | { code: "body-too-large"; byteLength: number; maxBodyBytes: number }
  | { code: "invalid-json" }
  | { code: "empty-json-body" }
  | { code: "non-scalar-at-pointer"; pointer: string };
```

duplicate JSON member と `NaN` / `Infinity` は `invalid-json` に正規化する。
parser の例外文、body の断片、解析位置は送らない。JSON Pointer が存在しない
場合は `false` であり、non-scalar を指した場合だけ `indeterminate` になる。

protocol は受信した `indeterminate` entry に diagnostic があることを検証する。
ただし、body truth entry 自体が欠落した場合は broker の評価 fallback が
`indeterminate` を返す一方、対応する diagnostic は存在しない。この addon / broker
不整合時にも原因を必ず表示する必要があるなら、別の fail-closed contract 修正として
扱う。通常の addon が生成する message の原因表示は実装済みである。

## Raw request body audit

### Configuration

raw body 保存は profile の `network.requestBodyAudit` で切り替える。

```pkl
requestBodyAudit {
  enable = false
  retentionSeconds = 604800
  maxBodyBytes = 8388608
  maxTotalBytes = 268435456
}
```

- 既定は無効で、無効時は body bytes を encode、送信、保存しない
- `maxBodyBytes` の hard ceiling は 32 MiB
- `maxTotalBytes >= maxBodyBytes` を検証する
- 保存失敗は認可の Allow / Deny を変更しない

### Capture and transport

有効時は review request だけでなく、すべての network `authorize` で capture を
作る。masking、rewriting、credential injection より前の
`flow.request.content` を使用する。

capture は既存 version 1 の one-line JSON に一度だけ載せる。body は base64、
byte length、SHA-256、Content-Type、Content-Encoding として送る。broker の
request line 上限は 48 MiB である。binary framing、複数 frame、half-close を
伴う新 protocol は採用していない。

### Persistence and capacity

exact bytes は host の既存 `audit.db` 内にある独立 `request_body` tableへ保存する。
主キーは `(session_id, request_id)` である。通常の audit / pending query は BLOB
列を SELECT せず、detail query だけが一件の BLOB を読む。

insert transaction は次の順で処理する。

1. 期限切れ row を削除する
2. 同一主キーの idempotency を digest と length で確認する
3. 未期限切れ body の総 byte length を計算する
4. 上限内なら新規 BLOB を保存する

容量を超える場合は既存の未期限切れ body を削除せず、新規 body だけを
`unavailable/capacity` とする。truncate や eviction は行わない。

保存結果は raw bytes を含まない次の metadata として pending と audit に残す。

```ts
type RequestBodyAuditStatus =
  | { state: "disabled" | "not-applicable" }
  | { state: "attached"; byteLength: number; sha256: string }
  | {
      state: "unavailable";
      code:
        | "body-unreadable"
        | "body-too-large"
        | "capacity"
        | "invalid-capture"
        | "store-failed";
    };
```

raw-body audit が有効なら、通常の rule audit が `off` でも metadata-only の
authorization audit row を残す。これにより retained body が audit list から
参照不能になることを防ぐ。

### Retrieval boundary

UI は `GET /api/network/body/:sessionId/:requestId` を明示的に呼んだときだけ
body を取得する。未保存・期限切れは 404、保存済みは metadata と base64 data を
返す。lossless UTF-8 は text、それ以外は base64 と明記して表示する。

body は SSE、pending JSON、audit list JSON、log、notification に含めず、
container / agent に取得 API や audit DB を公開しない。panel の `Hide raw body` は
保持した表示データを component state から外し、再度開くと再取得する。

audit directory は `0700` に揃える。DB / WAL / SHM を明示的に `0600` へ chmod
する変更は現在入れていない。これは今回の完成条件へ戻さず、別途明示的な指示が
ある場合だけ扱う。

## 残タスク

### 次に実装する候補: hostexec action 表示だけを整合させる

実装するなら一つの小さい変更として、次を同時に満たす。

- Deny が selector に依存しないことをボタン配置と文言で示す
- `prompt.defaultScope` を UI に反映するか、UI 固有の既定値であることを仕様化する
- capability 承認前に、少なくとも rule / cwd と capability の主要構成を確認できる

hostexec broker の capability key や Deny semantic 自体は変更しない。

### 保留

- notification deep link から対象 session / card への遷移
- keyboard shortcut の `Approve (once)` 表記と選択中 scope の不一致
- expired と never-saved を区別する body detail error
- audit の reason / rule / scope / route / violation detail 表示
- DB / WAL / SHM の明示的な mode 強制
- session 別 Approval Inbox
- UI / CLI 共通の汎用 approval-effect contract
- pending pane 全体や audit page の大規模再設計

`docs/todo/network-approval-scope.md` は古い cache-key 説明を含むため、参照時は
現コードを正とし、別の docs-only cleanup で更新または削除する。

## 対象外として維持するもの

- raw-body 保存失敗時に Approve を禁止する semantic 変更
- binary body framing
- pending evidence lifecycle manager
- network / hostexec 共通の汎用 effect model
- container から audit DB または host file への直接書き込み

これらは今回の UI 要件に不要であり、実測または新しい要件なしには再導入しない。

## 検証記録

2026-08-23 に現在の tree で再実行した結果:

- `bun test src/network/broker_integration_test.ts`: 69 pass
- `bun test src/hostexec/broker_integration_test.ts`: 49 pass
- `bun test src/audit/store_integration_test.ts`: 25 pass
- `bun test src/ui/routes/api_integration_test.ts`: 37 pass
- `bun test src/ui/frontend/src`: 836 pass

すべて failure 0。これらは関連する focused suite の記録であり、repository 全体の
`bun test` を実行したという意味ではない。
