---
title: 監査ログを確認する
description: Network と HostExec の認可記録を CLI と UI で絞り込む
---

## 認可の記録を絞り込む

`nas audit` は Network と HostExec の許可・拒否を記録する audit database を読みます。
既定の開始日は当日の UTC date です。

```sh
nas audit
nas audit --since 2026-09-01
nas audit --session sess_abc123 --domain network
nas audit --since 2026-09-01 --domain hostexec --json
```

`--since YYYY-MM-DD` は開始日、`--session ID` は session ID、`--domain network|hostexec` は
domain を絞ります。`--json` は JSON array を出力し、通常表示で同じ request-policy
outcome が連続する場合の行の集約を行いません。別の audit database を調べる必要がある
運用では `--audit-dir DIR` も使えます。

## request body は別の高感度 opt-in

authorization audit record には decision、理由、target または command、rule / request
policy metadata が入ります。これは request body を既定で保存する機能ではありません。
`network.requestBodyAudit.enable = true` を明示したときだけ、mask 前の正確な request body を
host audit database に保存しようとします。body の保存に失敗・上限超過した場合は status
だけを audit metadata に残し、認可処理は続きます。

raw body は `retentionSeconds`、`maxBodyBytes`、`maxTotalBytes` で短く制限してください。
期限切れ body は後の保存または detail 読み取りで削除され、容量不足では古い body row が
先に削除されます。これは audit log metadata を消さず、`audit_log` 自体には自動 retention
がありません。host 側で両方の保持と database access を運用してください。

## UI でも確認する

[UI daemon](/nix-agent-sandbox/features/ui/) の Settings にある Audit は、同じ永続 audit log を
表示します。domain、session ID の部分一致、active session で絞り込み、古い行をさらに
読み込みます。UI は local trusted user 向けの操作面なので、共有 host では audit data と
承認操作にアクセスできるユーザーを信頼済みの人に限定してください。

## 関連ページ

- [Observability](/nix-agent-sandbox/features/observability/)
- [ネットワーク制御](/nix-agent-sandbox/features/network/)
- [HostExec](/nix-agent-sandbox/features/hostexec/)
