---
title: 推奨設定
description: 設定変更時の権限、承認範囲、保存データの確認項目
---

設定を変更したら、差分を確認してから `nas config trust` を実行してください。確認対象は、エージェントに渡すファイル、実行権限、通信先です。

## ファイルと認証情報

- 追加マウントは必要なファイル・ディレクトリだけに限定し、書き込みが不要なら `ro` にします。
- Nix、クラウド認証、GPG、DBus は使用するプロファイルだけで有効にします。Nix はホストに存在すると自動で有効になるため、不要なら `nix.enable = false` を指定します。
- 秘密値は通常の `env` に直接書かず、`secrets` に取得元を登録します。ホストでコマンドを実行する `cmd:` は、他の取得元で足りない場合に使います。

設定例は[ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/)と[シークレット・認証情報](/nix-agent-sandbox/features/secrets/)を参照してください。

## ホスト実行

- 実行ファイルはエージェントが変更できない絶対パスを指定し、引数と作業ディレクトリを制限します。シェルやビルドツールが読む設定・スクリプトも確認します。
- `inheritEnv.mode = "minimal"` を使い、必要な環境変数だけを追加します。
- `approval = "prompt"` と一回限りの承認を基本にします。再利用は、同じ操作を繰り返す場合に選びます。
- 秘密を注入する場合は、出力マスクも設定します。注入だけでは出力を隠せません。

[HostExec](/nix-agent-sandbox/features/hostexec/)に設定例があります。[相対パスコマンド](/nix-agent-sandbox/recipes/relative-hostexec/)には作業ディレクトリの制約があります。

## 通信と画面

- 通信先、メソッド、パスを限定し、fallback は `deny` を基本にします。承認の再利用範囲は[通信・ホスト実行の承認](/nix-agent-sandbox/operations/approvals/)で確認します。
- localhost 転送先の DB や管理 API にも認証を設定します。転送機能はサービスのアクセス制御を追加しません。
- UI とデスクトップ通知の承認操作は、信頼できる利用者だけに任せます。
- xpra 画面へのキー入力と貼り付けは、エージェント側のアプリに渡ります。

## 保存データと終了後の処理

- [実行履歴・利用量](/nix-agent-sandbox/features/observability/)と[監査ログ](/nix-agent-sandbox/operations/audit/)は別々に保持期間を管理します。リクエスト本文の保存は調査で必要な場合に限定します。
- Docker イメージは必要に応じて digest を固定します。キャッシュ利用時には新たな通信承認がないため、承認の有無だけではイメージの確認になりません。
- worktree はエージェントの終了後に削除します。残存コンテナやキャッシュの扱いは[イメージ・作業環境の管理](/nix-agent-sandbox/operations/maintenance/)を参照してください。
