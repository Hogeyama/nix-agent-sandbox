---
title: ACP クライアントとの接続
description: ACP 対応エディターから nas 経由で Claude を使うための、ホストの準備、専用プロファイル、エディターへの登録、承認の応答先と隔離の境界
---

ACP（Agent Client Protocol）に対応したエディターから Claude を使う場合は、エディターがエージェントとして起動するコマンドを `nas` に置き換えます。エディターは nas を子プロセスとして起動し、標準入出力で ACP のメッセージをやり取りします。nas はコンテナを立ち上げ、その中で ACP adapter と Claude を動かし、メッセージをそのまま中継します。エディターから見えるのは通常の ACP エージェントで、Claude が読むファイルと実行するコマンドはコンテナの中にあります。

このページでは、ホストの準備、ACP 用プロファイルの作成、エディターへの登録を行い、最初の応答を確認するところまで進めます。その後、承認要求がどこに届くかと、コンテナの外に出る経路を確認します。nas 自体の導入は[インストール](/nix-agent-sandbox/getting-started/installation/)を参照してください。

## ホスト側の準備

### Claude のインストールとログイン

Claude Code の公式バイナリをホストに導入し、通常のターミナルで一度起動してログインします。

```sh
curl -fsSL https://claude.ai/install.sh | bash
claude
```

nas はホストの `claude` バイナリを読み取り専用でコンテナへマウントし、認証情報と履歴もホストの `~/.claude` と `~/.claude.json` から持ち込みます。ターミナルからの起動では、ホストに Claude がなければコンテナ内でインストーラーを実行しますが、ACP 起動にはこの代替がなく、ホストに `claude` が見つからないと起動を中止します。ログインの対話もコンテナ内では行えないため、先に済ませておきます。

### プロジェクトの設定と信頼

プロジェクトのルートで nas の設定を作成し、Claude API への通信を許可します。手順は[最初の作業のプロジェクトの準備](/nix-agent-sandbox/getting-started/quick-start/#プロジェクトの準備)と同じです。まだ nas をターミナルから使ったことがなければ、そのページの手順で `nas claude` が応答を返すところまで確認しておくと、以降の問題を ACP 固有のものに絞れます。

設定を編集したら `nas config trust` で信頼します。ターミナルからの起動では、未信頼の設定を見つけると nas がその場で信頼するか尋ねますが、ACP 起動では標準入力がプロトコル専用で、尋ねる先がありません。この場合 nas は起動を中止し、実行すべきコマンドをエラーとして書き出します。

```
Refusing to load untrusted config: /path/to/project/.nas/config.pkl
...
    nas config trust
```

このエラーは、後述の `--log-file` を指定していなければクライアントが受け取る stderr に出ます。エディターがそれを表示するかどうかはエディターによるため、原因が分からないときは[起動しないときの診断](#起動しないときの診断)の手順でログファイルへ書き出します。

## ACP adapter の用意

nas はコンテナ内の PATH から `claude-agent-acp` というコマンドを探して起動します。これは npm パッケージ `@agentclientprotocol/claude-agent-acp` が提供するコマンドで、Claude を ACP に橋渡しします。nas のイメージには、このコマンドも、実行に必要な Node.js（22 以上）も入っていません。Nix を使うかどうかで、コンテナへ持ち込む方法を選びます。

Claude バイナリの場所と、nas が通信を仲介するプロキシの CA 証明書は、nas が環境変数で adapter に渡します。adapter 側の設定は必要ありません。

### Nix の devShell に入れる

プロジェクトの flake の devShell に adapter と Node.js を追加します。nixpkgs の `claude-agent-acp` パッケージは既定で unfree な `claude-code` パッケージに依存しますが、コンテナ内では nas が渡すホストの Claude を使うため不要です。スタブに差し替えて依存を外します。

```nix
devShells.default = pkgs.mkShell {
  packages = [
    pkgs.nodejs
    (pkgs.claude-agent-acp.override {
      claude-code = pkgs.writeShellScriptBin "claude" "exit 1";
    })
  ];
};
```

devShell をコンテナ内で読み込むには、プロジェクトの `.envrc` に `use flake` を置き、ACP 用プロファイルで direnv を有効にし、ホストで `direnv allow` を実行します。手順は[開発ツールと Docker](/nix-agent-sandbox/configuration/development/#direnv-の有効化)にあります。次の節のプロファイル例には direnv を有効にする行を含めています。

### Nix を使わずに持ち込む

ホストの一つのディレクトリに Node.js と adapter をまとめ、コンテナへ読み取り専用でマウントして PATH に加えます。次は `~/.local/share/nas-acp` にまとめる例です。Node.js は、コンテナ（Linux、ホストと同じ CPU アーキテクチャ）で動く配布物を選びます。

```sh
mkdir -p ~/.local/share/nas-acp
curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz \
  | tar -xJ --strip-components=1 -C ~/.local/share/nas-acp
~/.local/share/nas-acp/bin/npm install -g --prefix ~/.local/share/nas-acp \
  @agentclientprotocol/claude-agent-acp
ls ~/.local/share/nas-acp/bin
```

最後の `ls` に `node` と `claude-agent-acp` が並べば、ホスト側の準備は終わりです。このディレクトリをコンテナの `/opt/nas-acp` に見せ、その `bin` を PATH の先頭に加える設定を、次の節のプロファイルに追加します。

```pkl
extraMounts {
  new { src = "~/.local/share/nas-acp"; dst = "/opt/nas-acp"; mode = "ro" }
}
env {
  new EnvConfig { key = "PATH"; val = "/opt/nas-acp/bin"; mode = "prefix"; separator = ":" }
}
```

この方法では direnv は不要なので、次の節の `direnv { enable = true }` の行は外して構いません。

## ACP 用プロファイル

`.nas/config.pkl` の `profiles` に、ACP 起動用のプロファイルを別名で追加します。次は[プロジェクトの準備](/nix-agent-sandbox/getting-started/quick-start/#プロジェクトの準備)で作ったファイルに `claude-acp` を足した全体です。既存の `claude` と `codex` はそのまま残します。

```pkl
amends "modulepath:/global.pkl"

profiles {
  ["claude"] = (super["claude"]) {
    network {
      scopes {
        ["anthropic"] = (module.presets.anthropic.v1) {
          fallback = "deny"
        }
      }
    }
  }
  ["codex"] = super["codex"]
  ["claude-acp"] = (super["claude"]) {
    mode = "acp"
    direnv { enable = true }
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

`mode = "acp"` が、Claude の起動方法をターミナルから ACP に切り替える指定です。`agent = "claude"`、認証と履歴のマウント、通信の設定は継承元の `claude` から引き継ぎます。`super["claude"]` は共通設定の claude を指すので、同じファイルの `["claude"]` に書いた通信許可は引き継がれません。そのため `network` を繰り返しています。`nas config init` が生成した `extendProfile` を残しているファイルでは、継承元を `(extendProfile(super["claude"]))` にすると、関数の中に書いた設定も引き継げます。

`direnv { enable = true }` は Nix の devShell から adapter を読み込む行です。Nix を使わずに持ち込む場合は、この行の代わりに前の節の `extraMounts` と `env` を同じ位置に置きます。

編集したら差分を確認し、`nas config trust` を実行します。

### 継承元にあると起動しない設定

共通設定の `claude` に次の設定を足している場合、ACP 用プロファイルではそれを解除しないと設定エラーになり、起動しません。解除の書き方は設定の型ごとに違います。

| 継承元の設定 | 解除の書き方 | 同じことをする場所 |
| --- | --- | --- |
| `agentArgs`（Claude への追加引数） | `agentArgs = new {}` | ACP クライアントの設定、または Claude 自身の設定ファイル（`~/.claude/settings.json` など） |
| `guide`（サンドボックスの制約をエージェントに伝える説明文をコンテナへ置く機能） | `guide { enable = false }` | ワークスペースの `CLAUDE.md` |
| `worktree`（セッションごとの git worktree 作成） | `worktree = null` | 既存の worktree をエディターで開き、そこで起動する |

`session.multiplex`（[ブラウザーからの再接続](/nix-agent-sandbox/work/sessions/#エージェントへの入力と再接続)に使う設定）は、継承していても ACP 起動では無視されるので、解除は不要です。プロセスとセッションの管理はエディターが行います。同じ理由で、ACP 用プロファイルは nas の Web UI から開始できず、UI の一覧にも出ません。

## エディターへの登録

エディターのエージェント設定に、次の 3 項目を登録します。

| 項目 | 値 |
| --- | --- |
| command | `nas`。エディターの PATH から見つからない場合は nas の絶対パス |
| args | `claude-acp`（上で付けたプロファイル名）の 1 要素 |
| cwd | 開くプロジェクトのルートの絶対パス。エディターが自動で決める場合は次の説明を確認 |

Emacs の agent-shell では、Claude 用のコマンドを差し替えます。

```elisp
(setq agent-shell-anthropic-claude-acp-command '("nas" "claude-acp"))
```

agent-shell は、`M-x agent-shell` を実行したバッファの `default-directory` で nas を起動します。プロジェクト内のファイルを開いた状態で実行すれば、そのプロジェクトが対象になります。

Zed では `settings.json` の `agent_servers` に追加します。

```json
{
  "agent_servers": {
    "Claude (nas)": {
      "type": "custom",
      "command": "nas",
      "args": ["claude-acp"],
      "env": {}
    }
  }
}
```

他のクライアントでも、コマンドと引数を指定する設定があれば同じ値を使えます。ただし、nas を子プロセスとして起動し、標準入出力を pipe で接続するクライアントに限ります。ターミナルからの直接起動、dtach、nas の Web UI 内のターミナルから ACP 用プロファイルを起動すると、nas はエラーを出して終了します。

nas を起動したときの cwd が、コンテナへマウントされるワークスペースになります。コンテナ内でも同じ絶対パスです。ACP にはセッションごとに cwd を指定する仕組みもありますが、nas はプロトコルの中身を読まないため、その値を見ていません。エディターが nas を起動した場所と違うパスをセッションの cwd として送ると、そのパスはコンテナにありません。エディターが nas を起動する場所と、セッションの対象にする場所を揃えてください。

## 動作の確認

エディターで nas のエージェントを選び、セッションを開始して「このプロジェクトの構成を説明して」と送ります。プロジェクトについての応答が返れば、nas の起動、adapter の起動、Claude API への通信まで確認できています。

初回は nas のイメージ構築で数分かかることがあります。その間、エディターから送ったメッセージは nas が保持し、adapter が起動してから渡します。初期化の応答を待ってから次を送るクライアントなら保持されるのは最初の 1 通だけで、応答を待たずに送り続けるクライアントでも合計 1 MiB までは保持されます。上限を超えると nas は起動を中止します。

セッションが動いていることは、ブラウザーで `http://localhost:3939` を開いても確認できます。nas はセッション開始時に Web UI を自動で立ち上げます。左の Sessions に、プロファイル `claude-acp` のセッションと、その作業ディレクトリが表示されます。ディレクトリが開いているプロジェクトと違う場合は、前の節の cwd を見直します。

エディターでセッションを終了すると、nas とコンテナも終了します。エディターが nas を強制終了（SIGKILL）した場合でも、nas が起動時に用意した補助プロセスが、そのセッションの Docker リソースを片付けます。この補助プロセスを用意できなかったときは、起動ログに `nas container clean` を案内する警告が出るので、そのコマンドをホストで実行します。

## 承認の応答先

ACP セッションで許可を求められる場面は 2 つあり、届く先が違います。

一つは Claude 自身のツール使用許可（ファイルの編集やコマンドの実行）です。adapter が ACP のメッセージとして送るため、エディターの承認画面に出ます。どのツールにどこまで確認を求めるかは、エディター側の設定と、ホストと共有している Claude 自身の設定ファイルで決まります。

もう一つは、nas の承認です。許可していない接続先への通信と、[ホストでのコマンド実行](/nix-agent-sandbox/configuration/host-commands/)がこれに当たります。こちらは ACP のメッセージに乗らないため、エディターの承認画面には出ません。

初期設定では、nas の承認要求が届くとホストにデスクトップ通知が出て、押すと Web UI の該当する要求が開きます。エディターから起動していても、この経路はそのまま働きます。要求の読み方と応答の手順は[通信・ホスト実行の承認](/nix-agent-sandbox/work/approvals/)を参照してください。

ホストで `notify-send` が使えないと通知は出ません。エディター側にも何も出ないまま、Claude は応答を待って止まり、初期設定では 300 秒後に拒否されます。この環境では nas が起動時に次の警告を出します。

```
[nas] notify-send not found. Install libnotify (e.g. apt install libnotify-bin) for desktop notifications.
```

待ち時間は ACP 用プロファイルで変更できます。通信は `network { pendingTimeoutSeconds = 600 }` のように秒数で指定します。ホスト実行を設定している場合は、その `hostexec` の中の `prompt { timeoutSeconds = 600 }` が待ち時間です。

通知を使えない、または使いたくない場合は、作業中に Web UI を開いておくのが簡単です。エディターの中で要求を扱いたい場合は、要求の購読を自分で組み込みます。手順は[自作のクライアントに組み込む](/nix-agent-sandbox/work/approvals/#自作のクライアントに組み込む)にあります。

購読は既定で、そのユーザーの全セッションの要求を流します。自分のセッションだけに絞るのは購読側の `--session` で、そこへ渡すセッション id が必要になります。id は nas が起動時に決めるため、`--write-session-id` で書き出し先を指定して受け取ります。args の先頭、プロファイル名より前に置きます。

```elisp
(setq agent-shell-anthropic-claude-acp-command
      '("nas" "--write-session-id" "/tmp/nas-acp-session-id" "claude-acp"))
```

書き出されたファイルを読み、購読側へ渡します。

```sh
nas hostexec watch --session "$(cat /tmp/nas-acp-session-id)"
```

## 起動しないときの診断

エディターから起動しても応答がない場合は、`--log-file` を args の先頭、プロファイル名より前に追加し、nas の診断をホストのファイルへ書き出します。

```elisp
(setq agent-shell-anthropic-claude-acp-command
      '("nas" "--log-file" "/tmp/nas-acp.log" "claude-acp"))
```

`--write-session-id` と併用する場合も、どちらもプロファイル名より前に置きます。プロファイル名より後ろや `--` 以降に置くと Claude への引数と解釈され、ACP 起動では引数を受け付けないため起動しません。

ファイルには nas 自身の診断だけが追記されます。新規ファイルは mode 0600 で作られます。記録されるのは、実行中のステージ名、イメージ構築の有無、起動するコンテナとコマンド、警告、そして起動を中止したときのエラーです。`--verbose` を付けると各ステージの所要時間も記録します。

```
[nas] Running stage: DockerBuildStage
[nas] Docker image "nas-sandbox" already exists, skipping build
[nas] Running stage: LaunchStage
[nas] Launching container...
[nas]   Image: nas-sandbox
[nas]   Agent: claude
[nas]   Command: claude-agent-acp
```

`Launching container...` まで出ていれば nas 側の準備は終わっています。そこから先で失敗している場合、原因はコンテナの中、つまり adapter かその実行環境にあります。典型的なのは `claude-agent-acp` か `node` がコンテナの PATH にない場合で、adapter は起動直後に終了し、クライアントが受け取る stderr に `command not found` が出ます。`Launching container...` の前で止まっている場合は、直前のエラーを読みます。未信頼の設定なら `nas config trust` の案内が、ホストに Claude がなければその旨が書かれています。

ACP のメッセージ、会話の内容、Docker や adapter など子プロセスの stderr は、このファイルには記録されません。子プロセス側のエラーは、クライアントが受け取る stderr で確認します。`--log-file` を指定している間、nas はエラーも含めて診断をコンソールへ出さないため、起動しない原因を探すときはこのファイルを読んでください。

## クライアントと MCP の境界

このページで指定した adapter（`@agentclientprotocol/claude-agent-acp`、確認したのは 0.78.0）は、ファイルの読み書きとコマンドの実行に Claude Code 自身のツールを使います。ACP にはクライアント側でファイルを読み書きする機能とターミナルを開く機能もありますが、この adapter はどちらも使いません。したがって Claude が読むファイル、書き込むファイル、実行するコマンドはすべてコンテナの中にあり、[値のマスク](/nix-agent-sandbox/configuration/files/#値のマスク)やホスト実行の許可はターミナルからの起動と同じように働きます。

コンテナの外を通る経路は 3 つあります。

エディターが context としてメッセージに添える内容は、エディターがホストで読んだものです。ファイルの内容を添える機能では、マスクを通らない元の値が Claude に届きます。

エディターに登録した MCP server のうち、コマンドで起動する stdio 型は、adapter がコンテナ内で起動します。コンテナの PATH にそのコマンドが必要で、実行もコンテナの権限で行われます。一方、URL で指定する HTTP 型と SSE 型は外部サービスへの通信なので、nas のプロキシを通り、[通信許可](/nix-agent-sandbox/configuration/network/)が必要です。返ってくる内容は nas がマスクしたホストのファイルではありません。

エディター自身の機能（エディターが自分で行うファイル操作や検索）は、ACP とは無関係にホストで動きます。何をエディターに任せ、何を Claude に任せるかは、エディター側の設定で確認してください。
