---
title: ACP クライアントとの接続
description: Claude ACP 用プロファイル、クライアントの起動設定、ログと隔離の境界
---

ACP 対応のエディターやクライアントから Claude を使う場合は、nas を ACP の子プロセスとして登録します。この起動方法では、Claude と ACP adapter は nas の Docker コンテナ内で動きます。初回設定とログインは、クライアントへ登録する前にホストのターミナルで済ませます。

## ホスト側の準備

ホストに Claude Code の公式スタンドアロンバイナリをインストールし、通常のターミナルで `claude` を起動してログインします。ACP モードは起動中に Claude をインストールしたり、対話形式でログインしたりしません。

プロジェクトのルートで nas の設定を作成し、内容を確認して信頼します。

```sh
cd /absolute/path/to/project
nas config init
```

生成直後の設定は Claude API への通信を許可していません。[最初の作業のプロジェクト準備](/nix-agent-sandbox/getting-started/quick-start/#プロジェクトの準備)で Anthropic preset の範囲を確認し、下の ACP 用プロファイルにも同じ通信許可を含めます。

ACP の標準入力はプロトコル専用です。設定の自動作成、移行、信頼確認が必要な状態ではクライアントから起動せず、表示されたコマンドをホストのターミナルで実行します。

nas を更新した後も既存の `nas-sandbox` イメージを使っている場合は、ACP adapter を含むイメージへ作り直します。

```sh
nas rebuild
```

## ACP 用プロファイル

`.nas/config.pkl` の `profiles` に、Claude 用設定を継承する別名のプロファイルを追加します。次の例は共通設定の `claude` を引き継ぎます。継承元に残っている ACP 非対応の設定は、このプロファイルで明示的に解除します。

```pkl
amends "modulepath:/global.pkl"

profiles {
  ["claude-acp"] = (super["claude"]) {
    mode = "acp"
    agentArgs = new {}
    worktree = null
    guide { enable = false }
    network {
      scopes {
        ["anthropic"] = (module.presets.anthropic.v1) {
          fallback = "deny"
        }
      }
    }
  }
}
```

初期生成されたファイルの `extendProfile` にプロジェクト共通の通信許可や共有設定を追加している場合は、継承元を `(extendProfile(super["claude"]))` にします。既存の `claude` と `codex` の行は残してください。編集後は差分を確認し、もう一度 `nas config trust` を実行します。

`agent = "claude"` は継承され、`mode = "acp"` だけが独立した起動方法を選びます。既存の Claude 認証、履歴、ネットワーク、マウントの設定も継承されます。

## クライアントの起動設定

ACP クライアントのエージェント設定で、次の3項目を指定します。設定ファイルのキーや画面名はクライアントごとに異なります。

| 項目 | 値 |
| --- | --- |
| command | `nas`。クライアントの PATH から見つからない場合は nas の絶対パス |
| args | `claude-acp` の1要素 |
| cwd | 開くプロジェクトのルートとなる絶対パス |

クライアントは通常の子プロセスとして nas を起動し、標準入力と標準出力を pipe で接続する必要があります。ターミナルからの直接起動、dtach、nas の Web terminal では ACP プロファイルを使えません。

イメージ構築などの準備中、adapter に渡す前の入力は合計 1 MiB まで保持されます。上限を超えると起動を中止するため、追加の入力は初期化の応答を待って送ってください。adapter 起動後のメッセージに、この上限は適用されません。

起動時の cwd が nas のワークスペースになります。コンテナ内でも同じ絶対パスを使うため、ACP セッションがクライアントから受け取る cwd と Claude が操作するワークスペースを一致させてください。既存の git worktree を cwd に指定することはできますが、ACP 起動時に nas で worktree を作成することはできません。

## 非対応の設定

ACP モードでは、関連する設定と操作が次のように制限されます。

| 設定・操作 | 代わりの指定先 |
| --- | --- |
| `agentArgs`、プロファイル名より後ろの引数、`--` 以降の引数 | ACP クライアントまたは Claude settings |
| `guide.enable = true` | ACP クライアントが提供する指示設定、またはワークスペースの `CLAUDE.md` |
| `worktree`、`--worktree` | 既存のワークスペースまたは worktree を cwd に指定 |
| `session.multiplex` | ACP クライアントがプロセスとセッションを管理。継承値は無視される |

`agentArgs`、`guide.enable`、`worktree` が継承元に設定されている場合は、上の例のように ACP 用プロファイルで解除します。`session.multiplex` は設定されていても ACP 起動では使われません。Web UI の New Session にも ACP プロファイルは表示されません。

## 診断ログ

クライアントから起動できない場合は、`--log-file` を command の直後、プロファイル名より前に追加します。

| 項目 | 値 |
| --- | --- |
| command | `nas` |
| args | `--log-file`, `/absolute/path/to/nas-acp.log`, `claude-acp` の順 |
| cwd | プロジェクトのルートとなる絶対パス |

ファイルには nas の診断だけが追記され、新規ファイルは mode 0600 で作られます。指定中は同じ nas 診断をコンソールへ出しません。ACP メッセージ、会話、Docker・entrypoint・adapter など子プロセスの stderr は記録されません。子プロセスのエラーはクライアントが受け取る stderr も確認します。

stdout は ACP メッセージ専用です。ログファイルを `claude-acp` より後ろや `--` 以降に置くと nas のオプションとして解釈されないため、上の順序を保ちます。

## クライアントと MCP の境界

Claude の標準ツールと、クライアントが渡した stdio MCP server のコマンドはコンテナ内で実行され、nas がマウントしたワークスペースを見ます。maskfs を設定していてもコンテナ内のパスはホストと同じ絶対パスで、ファイルの内容だけがマスク済みの view に置き換わります。

一方、ACP クライアントが context として送る内容は、プロトコル経由でコンテナへ入るため nas の maskfs を通りません。ACP にはクライアント側のファイル読み書き capability もありますが、同梱する adapter 0.77.0 の通常のファイル操作は Claude の標準ツールを使ってコンテナ内で行われます。クライアント自身の機能や別バージョンの adapter がクライアント側のファイル API を使う場合、その読み書きは nas の外側です。

remote MCP server など外部サービスが返す内容も、nas がマスクしたホストファイルではありません。クライアントから渡す context の範囲、クライアント側のファイル機能、MCP server の実行場所と権限を、クライアント側の設定でも確認してください。
