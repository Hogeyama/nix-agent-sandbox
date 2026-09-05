---
title: 監査ログ
description: 通信・ホスト実行の許可と拒否の記録、検索、保持期間
---

通信と HostExec の許可・拒否は、`nas audit` またはブラウザ UI の Settings → Audit で確認できます。エージェントの[実行履歴・利用量](/nix-agent-sandbox/features/observability/)とは別の記録です。

## CLI の検索条件

既定では当日の UTC 日付以降の記録を表示します。

```sh
nas audit
nas audit --since 2026-09-01
nas audit --session sess_abc123 --domain network
nas audit --since 2026-09-01 --domain hostexec --json
```

| オプション | 対象 |
| --- | --- |
| `--since YYYY-MM-DD` | 開始日以降の記録。 |
| `--session ID` | 指定セッション。 |
| `--domain network\|hostexec` | 通信または HostExec。 |
| `--json` | 連続した同じ判定を集約せず、JSON 配列で出力。 |
| `--audit-dir DIR` | 指定ディレクトリの監査 DB。 |

## UI の検索条件

Settings → Audit では、種類、セッション ID の部分一致、実行中のセッションで絞り込めます。古い記録は追加で読み込めます。

## リクエスト本文の保存

通常は判定、理由、通信先またはコマンド、ルールなどを記録します。`network.requestBodyAudit.enable = true` を指定した場合だけ、マスク前のリクエスト本文も保存します。秘密値やプロンプト、ツール入力を含み得ます。

`retentionSeconds` で保持期間、`maxBodyBytes` と `maxTotalBytes` で容量を制限してください。保存失敗や上限超過では状態だけを記録し、認可処理は続けます。

## 保存先

監査 DB は `$XDG_DATA_HOME/nas/audit/audit.db`、`XDG_DATA_HOME` が未設定なら `~/.local/share/nas/audit/audit.db` に保存します。`--audit-dir DIR` では `DIR/audit.db` を読みます。

## 保持期間と削除

期限切れの本文は、次の本文保存または詳細読み取り時に削除します。総量上限を超える場合は古い本文から削除します。

**本文の削除は、許可・拒否の記録を削除しません。** `audit_log` 自体に自動削除はないため、ホスト側で監査 DB の保持と削除を管理してください。DB ファイルと UI の閲覧権限も確認してください。
