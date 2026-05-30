---
title: 運用コマンド
description: サンドボックス・セッション・承認キューを操作するサブコマンド
---

起動後のサンドボックスやセッション、承認キューを操作するためのサブコマンド群です。

## Docker イメージの再ビルド

Docker イメージを再ビルドしたい場合（アップデート後など）は `rebuild` サブコマンドを使います。

```sh
nas rebuild
nas rebuild --force
```

## Worktree の掃除

溜まった worktree を手動で管理するには `worktree` サブコマンドを使います。

```sh
nas worktree list            # nas が作成した worktree を一覧表示
nas worktree clean           # すべて削除（確認プロンプトあり）
nas worktree clean --force   # 確認なしで削除
```

## Sidecar コンテナの掃除

`docker.shared = true` や `network.allowlist` / `network.prompt.enable` を使っていると、DinD / Envoy 関連のコンテナが残ることがあります。未使用のものだけを止めて削除するには `container clean` を使います。

```sh
nas container clean
```

このコマンドは nas が管理する DinD / proxy コンテナのうち、現在どのエージェントコンテナからも使われていないものだけを `stop` + `rm` します。削除後に空になった nas 管理 network と DinD 用 tmp volume もあわせて回収します。現在実行中のエージェントコンテナは対象外です。

## セッションの管理

`session.multiplex = true` のときに使えるセッション管理コマンドです。detach 中のセッションへ別ターミナルから入り直したいときに使います。

```sh
nas session                     # アクティブなセッション一覧（list のエイリアス）
nas session list                # アクティブな dtach セッション一覧
nas session list --format json  # JSON 形式で出力
nas session attach <session-id> # セッションに再接続（複数ターミナルから同時 attach 可能）
```

## Network 承認キューの確認と操作

allowlist 外の通信は承認待ちのキューに積まれます。デスクトップ通知や UI からの操作に加えて、コマンドでも approve / deny できます。

```sh
nas network pending
nas network approve <session-id> <request-id> --scope [once|host-port|host]
nas network deny    <session-id> <request-id>
nas network review
nas network gc
```

- `pending` は `session_id request_id target state created_at` を 1 行ずつ表示します
- `review` は fzf で pending を対話的に選択し approve / deny できます
- `gc` は stale session registry / pending dir / broker socket / auth-router pid/socket を掃除します

## HostExec 承認キューの確認と操作

`approval = "prompt"` のルールにマッチしたコマンドは承認待ちになります。こちらも通知・UI のほか、コマンドで approve / deny できます。

```sh
nas hostexec pending
nas hostexec approve <session-id> <request-id>
nas hostexec deny    <session-id> <request-id>
nas hostexec review
nas hostexec test --profile <profile> -- <command> [args...]
```

- `pending` は `session_id request_id rule_id cwd argv...` を 1 行ずつ表示します
- `review` は fzf で pending を対話的に選択し approve / deny できます
- `test` はルールマッチングを試行し、マッチしたルールの id・approval・env keys を表示します。regex パターンの試行錯誤に便利です
