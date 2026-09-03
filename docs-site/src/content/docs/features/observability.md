---
title: Observability
description: agent 実行の履歴、OTLP telemetry、監査ログを保持して確認する
---

## どんな機能？

nas は通常の agent invocation ごとに、profile、agent、worktree、開始・終了時刻、終了理由を host の history database に記録します。Observability はその lifecycle history を止める switch ではなく、対応する agent に OTLP receiver を配線して trace、span、log を追加する opt-in です。`observability.enable = false` でも invocation metadata と history database は作成・記録されます。`nas audit` と UI の Audit は、network / HostExec の許可・拒否を記録する別の audit database を読む機能です。履歴と監査は用途も保持するデータも別です。

## いつ使う？

agent の利用量、モデル、token、trace を session をまたいで確認したいときに有効にします。既定の無効は OTLP wiring を省く選択です。invocation metadata を保存させない設定ではないため、host に profile、agent、worktree、時刻を残せない要件にはこの flag だけでは対応しません。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `observability.enable` | `false` | 対応する agent の OTLP receiver を配線し、trace / span / log の保存を有効にする。invocation lifecycle history はこの値にかかわらず記録する。 |
| `observability.retention` | `2678400` 秒（31 日） | history の保持期間。`null` は無期限に保持する。 |

## 最小の設定例

```pkl
observability = new ObservabilityConfig {
  enable = true
  retention = 31 * 24 * 60 * 60
}
```

無期限保存を選ぶ場合は、削除時期を別途決めます。

```pkl
observability = new ObservabilityConfig {
  enable = true
  retention = null
}
```

## 保存されるデータと UI

history には invocation の profile、agent、worktree path、開始・終了時刻、終了理由と、OTLP trace / span の時刻、名前、種別、duration、model、input / output / cache token、属性が保存されます。OTLP log signal は `user_prompt`、`api_request`、hook 実行開始・完了を対象にし、conversation の詳細で時系列として表示します。属性からは `user.id`、`user.email`、`user.account_id`、`user.account_uuid` を保存前に除きますが、これ以外の telemetry 属性が機密でないことを保証するものではありません。

これは metadata だけの収集ではありません。Observability を有効にすると、Claude Code には user prompt を unredact する設定と tool の詳細・content を出す設定を渡すため、user prompt と tool の入力・出力本文が span / log の属性や event に保存され得ます。Copilot CLI にも message content capture を有効にするため、prompt / response message と tool input / result が span 属性に保存され得ます。これらは通常の Observability の高感度データであり、`requestBodyAudit` を有効にしなくても発生し得ます。

UI の History は conversation list、会話の trace / span / log record、関連 invocation、model 別 token と cost 表示を提供します。receiver や history database を開けない場合、telemetry は agent の実行を止めずに無効へ degrade します。telemetry は完全な監査証跡ではなく、receiver が停止している間などに span が欠けることがあります。

## 保持と掃除

history database は `$XDG_DATA_HOME/nas/history.db`（未設定なら `~/.local/share/nas/history.db`）です。数値の `retention` を設定すると、通常の invocation lifecycle が database を開くたびに、`observability.enable` の値にかかわらず、期限より古い invocation とその trace、span、log record、参照されなくなった conversation を best-effort で削除します。Observability が有効なら stage 側も writer を開きます。

prune の 1 時間 throttle は process-local です。同じ `nas` process 内では繰り返しの削除を抑えますが、別々の `nas` process は state を共有しないため、別 process がより短い間隔で prune を実行し得ます。prune が失敗しても agent run は継続します。`null` では自動削除しません。

無期限保存や即時の消去が必要なときは、agent を停止してから history database を host 側で管理してください。history と audit の database は別なので、一方を削除しても他方の記録は消えません。

## `nas audit` と request body の扱い

`nas audit` は audit database から network / HostExec の許可・拒否を読みます。既定では当日の UTC date からを表示します。`--since`、`--session`、`--domain` で対象を絞り、`--json` では集約しない entry の JSON array を出力します。

```sh
nas audit --since 2026-09-01 --session sess_abc123 --domain network
nas audit --json --since 2026-09-01
```

UI の Audit でも domain、session ID の部分一致、active session による絞り込みができます。audit entry には target または command、判断、理由、rule / request policy の metadata が含まれます。これは observability history とは別のデータです。

`requestBodyAudit` は observability の一部ではなく、**network の明示的な高感度 opt-in** です。`requestBodyAudit.enable` の既定は `false` で、request body は既定では保存されません。有効にすると、マスク前の正確な request body を host の audit database に保存します。必要性を確認してから、`retentionSeconds`、`maxBodyBytes`、`maxTotalBytes` を小さく設定してください。期限切れ body は次の body 保存または明示的な body detail 読み取り時に `request_body` から削除され、総量上限を越える新規保存では最も古い `request_body` row を削除します。body を読めない、上限超過、または保存失敗なら metadata に状態だけを残し、認可処理は続きます。

この body の expiry / capacity cleanup は `audit_log` の entry を消さず、history database にも影響しません。`audit_log` 自体には自動 retention がなく増え続けるため、body だけでなく audit metadata の保持期間と host 側での database cleanup も別途運用してください。

## 注意点・セキュリティへの影響

history、audit、特に Observability の prompt / tool content と raw request body は host 上の高感度な運用データです。container に生の secret を mount する仕組みではありませんが、保存する telemetry、metadata、raw body を読める host ユーザーはその内容を見られます。共有 host では UI の History / Audit と database file へのアクセスを、承認を任せられる信頼済みユーザーに限定してください。

raw request body capture は秘密、prompt、tool input を含み得ます。通常の history を有効にすることと同一視せず、保存期間と容量を決め、不要になった body を host 側で掃除してください。

[observability retention](/nix-agent-sandbox/security/risks/#observability-retention)と[request-body audit](/nix-agent-sandbox/security/risks/#request-body-audit)は別の opt-in / cleanup なので、両方の保持を管理してください。

## 関連ページ

- [UI daemon](/nix-agent-sandbox/features/ui/) — History と Audit の画面
- [ネットワーク制御](/nix-agent-sandbox/features/network/) — request rule と `requestBodyAudit` の設定
- [HostExec](/nix-agent-sandbox/features/hostexec/) — host command の audit 対象
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `ObservabilityConfig` と `RequestBodyAuditConfig` の全定義
