---
title: 実行履歴・利用量
description: 実行履歴とトークン使用量の記録、保存内容、保持期間
---

エージェントの実行履歴は、[ブラウザ UI](/nix-agent-sandbox/features/ui/) の History で確認できます。プロファイル、エージェント、作業場所、開始・終了時刻、終了理由は常に記録されます。

`observability.enable = true` にすると、対応エージェントの利用モデル、トークン数、処理の記録も追加します。**プロンプトやツールの入出力本文も保存され得ます。**

## 保存内容

History には会話ごとの処理記録、関連する実行、モデル別のトークン数と費用が表示されます。

- Claude Code：プロンプト、ツールの入力・出力、API リクエストや hook の実行記録を含み得ます。
- Copilot CLI：プロンプト・応答とツールの入力・結果を含み得ます。
- `user.id`、`user.email`、`user.account_id`、`user.account_uuid` は保存前に除去します。他の属性に機密情報が含まれない保証はありません。

データ受信や DB の利用に失敗しても、エージェントは実行を続けます。その間の記録は欠けることがあります。

## 設定例

`.nas/config.pkl` のトップレベルに追加します。`profiles` の外側です。

```pkl
observability = new ObservabilityConfig {
  enable = true
  retention = 31 * 24 * 60 * 60
}
```

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `observability.enable` | `false` | 対応エージェントから OTLP 形式の処理・利用量データを収集。実行履歴は無効でも記録。 |
| `observability.retention` | `2678400` 秒（31 日） | 履歴の保持期間。`null` は無期限。 |

## 保存先と保持期間

保存先は `$XDG_DATA_HOME/nas/history.db`、未設定時は `~/.local/share/nas/history.db` です。

数値の `retention` を設定すると、nas が履歴 DB を開く際に期限切れの実行履歴と関連データの削除を試みます。`enable = false` でも削除対象になり、`retention = null` では自動削除しません。削除の失敗はエージェントの実行を止めません。

即時に消去する場合は、エージェントを停止してからホスト側で DB を管理してください。共有ホストでは、DB ファイルと UI の History にアクセスできる利用者を制限してください。

## 監査ログ

通信と HostExec の許可・拒否は、履歴とは別の DB に記録されます。`retention` を変更しても監査ログの保持期間は変わりません。リクエスト本文の保存と削除を含め、[監査ログ](/nix-agent-sandbox/operations/audit/)を参照してください。
