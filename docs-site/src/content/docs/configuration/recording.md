---
title: 記録と保存期間
description: 会話・利用量・通信本文の収集と、二つの保存先の保持・削除
---

会話や通信の詳細を保存する前に、必要な記録と保持期間を決めます。作業の履歴と許可・拒否の監査ログは別に保存され、削除の条件も異なります。

| 記録 | 既定と閲覧先 |
| --- | --- |
| nas の実行 | プロファイル、エージェント、作業場所、開始・終了時刻、終了理由を記録 |
| 会話・処理・トークン使用量 | 追加収集は無効。対応エージェントで有効化すると History で確認可能 |
| 通信・ホスト実行の判定 | 許可・拒否や理由、対象などを記録。Settings → Audit で確認 |
| マスク前の通信本文 | 保存しない。調査に必要な場合だけ追加設定 |

実際の調べ方は[過去の作業と利用量](/nix-agent-sandbox/work/history/)と[作業中の問題と調査](/nix-agent-sandbox/work/troubleshooting/)にあります。

## 会話・処理・利用量の追加収集

**有効にすると、プロンプトやツールの入出力本文も保存され得ます。** ホスト上にその記録を残してよいか確認してから、`.nas/config.pkl` のトップレベル（profiles の外側）へ追加します。

```pkl
observability = new ObservabilityConfig {
  enable = true
  retention = 31 * 24 * 60 * 60
}
```

observability.enable の既定は false です。無効でも nas の実行履歴は記録されます。対応エージェントからの追加収集は、変更後に起動するセッションで確認します。

Claude Code ではプロンプト、ツールの入出力、API リクエストや hook の記録、Copilot ではプロンプト・応答とツールの入力・結果を含み得ます。user.id、user.email、user.account_id、user.account_uuid は保存前に除去しますが、他の属性に機密情報が含まれない保証はありません。

受信や保存に失敗してもエージェントは実行を続けるため、その間の記録が欠ける場合があります。

## 通信本文の追加保存

**保存するのはマスク前の本文で、秘密値、プロンプト、ツール入力を含み得ます。** 判定の理由だけで調査できる場合は追加保存しません。必要な場合は[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)へ追加します。

```pkl
network {
  requestBodyAudit {
    enable = true
    retentionSeconds = 604800
    maxBodyBytes = 8388608
    maxTotalBytes = 268435456
  }
}
```

この例は7日、1要求8 MiB、総量256 MiBの上限です。保存に失敗した場合や上限を超えた場合は状態だけを記録し、認可処理は続けます。

## 保存先と削除

| 記録 | 保存先（XDG_DATA_HOME 未設定時） | 保持・削除 |
| --- | --- | --- |
| 実行履歴・会話・利用量 | ~/.local/share/nas/history.db | retention の既定は31日。null は無期限。DB を開く際に期限切れデータの削除を試みる |
| 監査ログと通信本文 | ~/.local/share/nas/audit/audit.db | 本文だけに期限・容量による削除がある。判定ログ自体は自動削除しない |

XDG_DATA_HOME を指定した場合は、その配下の nas/history.db と nas/audit/audit.db です。`nas audit --audit-dir DIR` は DIR/audit.db を読みます。

observability.enable を false に戻しても、数値の retention による期限切れ履歴の削除は行います。削除に失敗してもエージェントは停止しません。

期限切れの通信本文は、次の本文保存または詳細読み取り時に削除します。総量上限を超える場合は古い本文から削除します。**本文を削除しても、許可・拒否の判定ログは消えません。** 判定ログ全体の保持と削除はホスト側で管理します。

即時にデータを削除する場合は、使用中のエージェントを停止してからホスト側で DB を管理してください。共有ホストでは、DB ファイルと UI の履歴にアクセスできる利用者も確認します。異常終了時の一時ファイルの回収は[作業の終了と片付け](/nix-agent-sandbox/work/finish/#異常終了後のデータ)で扱います。
