---
title: 制約・注意事項
description: 対応環境、非対話実行、追加機能の制約
---

対応環境は[インストール](/nix-agent-sandbox/getting-started/installation/)、設定によるアクセス権限の違いは[機能別リスク](../risks/)を参照してください。

## 非対話実行

引数なしの対話起動には TTY が必要です。CI やスクリプトでは、エージェントにプロンプトなどの引数を渡してください。未信頼の設定は対話確認ができず失敗するため、事前に内容を確認して `nas config trust` を実行します。

## 追加機能の前提条件

- Nix：`enable = true` でも、ホストに `/nix` がなければ共有されません。
- DBus：ホストの UID または `xdg-dbus-proxy` がなければ有効化を省略します。`DBUS_SESSION_BUS_ADDRESS` が未設定なら `unix:path=/run/user/$UID/bus` を使いますが、バスが利用できなければ起動に失敗します。
- X11：必要なツールや WSL の条件は [X11 アプリの表示](/nix-agent-sandbox/recipes/x11-apps/#前提条件)を参照してください。ビューアーの自動接続に失敗しても、コンテナと X server は動作を続けます。
- Docker：`docker.shared = true` は廃止済みの互換フィールドで、DinD 有効時には設定エラーになります。

## 異常終了後のデータ

通常の終了処理では、補助プロセスや一時データの削除を試みます。SIGKILL や削除処理の失敗では、一部が残る場合があります。

特に、出力マスク用のセッションディレクトリには、権限 `0600` の `mask-secrets` ファイルに秘密値が平文で残る場合があります。**nas の再起動や `nas network gc` では自動回収されません。** 保存先は起動時の `$XDG_RUNTIME_DIR/nas/mask-filter/<session-id>/mask-secrets`、`XDG_RUNTIME_DIR` が未設定なら `/tmp/nas-<ホストのUID>/mask-filter/<session-id>/mask-secrets` です。ホストの UID は `id -u` で確認できます。使用中のセッションがないことを確認してから、該当するセッションのディレクトリをホストで削除してください。

未使用の Docker 補助コンテナは `nas container clean` で削除できます。取得キャッシュ `nas-registry-cache` は残ります。Worktree の削除とあわせて[イメージ・作業環境の管理](/nix-agent-sandbox/operations/maintenance/)を参照してください。

## 実装上の境界

- HostExec の `fallback = "deny"` は、現在の実装では不一致時の動作を変えません。[不一致時の動作](/nix-agent-sandbox/features/hostexec/#不一致時の動作)を参照してください。
- 相対パスと `workspace-only` の組み合わせは、実行元をルートディレクトリに固定しません。[相対パスコマンドのホスト実行](/nix-agent-sandbox/recipes/relative-hostexec/)を参照してください。
- 収集・保存に失敗すると処理記録は欠けます。また、リクエスト本文の期限切れ削除は監査ログ全体の削除ではありません。[監査ログ](/nix-agent-sandbox/operations/audit/)と[実行履歴・利用量](/nix-agent-sandbox/features/observability/)は別々に管理してください。
