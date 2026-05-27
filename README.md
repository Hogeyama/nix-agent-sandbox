# nas — Nix Agent Sandbox

Docker を使って、AI エージェント用の隔離された作業環境を起動する CLI ツールです。デフォルトでホストのファイルシステムやネットワークを隔離し、必要に応じてアクセスを許可できます。Claude Code / GitHub Copilot CLI / OpenAI Codex CLI に対応しています。
[agent-workspace](https://github.com/hiragram/agent-workspace) にインスパイアされました。

> [!NOTE]
> **名前について**: 当初は「Nix 統合」と「Docker in Docker」を主目的として *nix-agent-sandbox* と命名しました。
> その後、ネットワーク制御・コマンド移譲・Worktree 管理など様々な機能が追加された結果、
> Nix 統合は数ある機能のひとつに過ぎなくなっています。

## 前提条件

- Linux
- **Docker** (20.10+)
- **Nix** (multi-user installation)
  - `nix profile install` で導入する場合や、非 Nix ユーザー向け配布バイナリを作る場合に必要
- **dtach** （`session.multiplex = true` を使う場合のみ）
- **エージェントバイナリ** — スタンドアロンバイナリとしてインストール済みであること（npm 版は不可。詳細は[制約・注意事項](#エージェントバイナリ)を参照）

<details>
<summary>エージェントのインストール</summary>

エージェントは **npm ではなく、公式のスタンドアロンバイナリ** をインストールしてください。

**Claude Code:**

```sh
# 公式インストーラー
curl -fsSL https://claude.ai/install.sh | bash
```

**GitHub Copilot CLI:**

公式のインストール手順に従ってスタンドアロンバイナリを導入してください。

**OpenAI Codex CLI:**

[Releases · openai/codex](https://github.com/openai/codex/releases) からインストールしてください。

</details>

## インストール

### GitHub Releases からインストール

GitHub Releases からビルド済みバイナリをダウンロードできます（x86_64-linux / aarch64-linux）。

```sh
# x86_64-linux
gh release download --repo Hogeyama/nix-agent-sandbox --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C ~/.local/bin

# aarch64-linux
gh release download --repo Hogeyama/nix-agent-sandbox --pattern 'nas-*_aarch64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
```

> [!NOTE]
> aarch64-linux 版は動作未確認です。

### ローカルでビルドしてインストール

```sh
nix profile install github:Hogeyama/nix-agent-sandbox
```

## クイックスタート

```sh
cd /path/to/your-project
nas config init                 # .nas/ ディレクトリと設定ファイルを生成
vim .nas/config.pkl             # 設定を編集

nas                             # デフォルトプロファイルで起動
nas copilot-nix                 # プロファイルを指定して起動
nas copilot-nix -p "blah"       # オプションをエージェントに渡して起動
```

## 主要な機能

### Nix 統合

`nix.enable` を有効にすると、ホストの nix daemon をソケット経由で利用できます。
そのため、コンテナ内に Nix を個別にインストールしなくても、`nix develop` や `nix run` を使って必要な開発環境やツールを利用できます。

### Docker in Docker

DinD サイドカーを起動して、エージェントコンテナから隔離された Docker 環境を提供します。

### ネットワーク制御

通信先ドメインを allowlist で指定できます。`"example.com"` のようなホスト名のほか `"api.example.com:443"` や `"*.cdn.com:8080"` のようにポートを含む形式も使えます。allowlist 外の通信はデスクトップ通知経由で approve / deny できます（`ui.enable = true` の場合はブラウザ UI、`false` の場合は通知のアクションボタン）。

![network prompt](./images/network-prompt.png)

### ホストの localhost ポート転送

`network.proxy.forwardPorts` を使うと、ホスト側で `127.0.0.1` (loopback) に bind しているポートをコンテナ内から同じ `localhost:<port>` で利用できます。ポートごとに 1 本の Unix domain socket をホスト側 `nas` プロセスが立て (`<runtimeDir>/forward-ports/<sessionId>/<port>.sock`)、それをコンテナへ `/run/nas-fp/<port>.sock` として bind-mount します。コンテナ内の `local-proxy` が `127.0.0.1:<port>` を listen して受け取った TCP 接続をその UDS にそのまま流し込み、ホスト側 relay が UDS 受信を `127.0.0.1:<port>` の TCP に pipe します。envoy / 認証付き proxy / `host.docker.internal` 経由の経路ではないため、ホスト側のサービスを `0.0.0.0` で listen させる必要はなく、`127.0.0.1` のままでローカル開発サーバーや DB にコンテナから接続できます。

```pkl
profiles {
  ["blah"] {
    network {
      proxy {
        forwardPorts = new Listing { 8080; 5432 }
      }
    }
  }
}
```

> [!NOTE]
> `18080` は nas の内部認証 proxy 用に予約されているため指定できません。

### コマンド移譲

指定したコマンドの実行をホスト側に移譲できます。
これにより、秘匿情報が必要なコマンドをホスト側で実行し、コンテナ内には直接渡さない運用が可能になります。

また、ネットワーク制御と同様に、実行ごとにデスクトップ通知経由で approve / deny することもできます。

![hostexec prompt](./images/hostexec-prompt.png)

![hostexec result](./images/hostexec-result.png)

> [!WARNING]
> `deno task` のような「設定ファイルを読んで実行するコマンド」を hostexec で委譲すると、
> エージェントが `deno.json` を書き換えることで実質的に任意コマンドのホスト実行が可能になります。
> 本番運用で使う場合は `extraMounts` で設定ファイルを read-only マウントするなどの工夫が必要です。
>
> ```pkl
> extraMounts = new Listing {
>   new { src = "deno.json"; dst = "deno.json"; mode = "ro" }
> }
> ```

### X11 ディスプレイ転送（xpra サンドボックス）

`display.sandbox = "xpra"` を有効にすると、nas はホスト上に **xpra** の detached X server を 1 つ立ち上げます（バックエンドは xpra が spawn する Xvfb）。コンテナには**その Xvfb のソケットと per-session の MIT-MAGIC-COOKIE Xauthority だけ**が渡ります。エージェントから動かせるのはこの仮想 X server 内のアプリだけで、ホスト本体の X セッション（他のウィンドウ・キー入力・スクリーン）には到達できません。

X server の準備が整い次第、nas は同時にホスト側で `xpra attach :N` を seamless モードで自動起動します（nas プロセスの `DISPLAY` / `XAUTHORITY` を継承）。エージェントが描画した X11 アプリケーションのウィンドウは、ユーザの実際のデスクトップに通常のウィンドウとしてポップアップします。何もウィンドウが出ていない間は viewer も画面に何も描かないので「常時 attach」のコストは実質ありません。viewer プロセスは X server と同じスコープで管理され、セッション終了時にまとめて落ちます。

主な用途は `playwright test --headed` のような GUI 付き E2E をエージェントから実行するケースです。

```pkl
profiles {
  ["e2e"] {
    agent = "claude"
    display {
      sandbox = "xpra"     // "none"（デフォルト）/ "xpra"
      size = "1366x768"    // Xvfb のスクリーンサイズ（デフォルト: "1920x1080"）
    }
  }
}
```

前提として、ホストに `xpra` がインストールされている必要があります（Debian系: `xpra`、Nix: `pkgs.xpra`）。xpra が内部で Xvfb を起動するので追加で `Xvfb` も必要です（通常 xpra パッケージが引き連れてきます）。`xauth` は不要です（nas が `FamilyWild` の Xauthority を直接書き出すため、コンテナのホスト名と無関係に cookie がマッチします）。xpra が見つからない場合は明示的なエラーで起動を中止します。

> [!WARNING]
> 仮想 X server **内部**ではエージェントは依然として X11 client として全権を持ちます。auto-attach された viewer ウィンドウにフォーカスを当てている間は、ユーザのキー入力やクリップボード内容が viewer 経由でエージェント側のアプリに流れます（これは X11 アプリを操作している以上避けられない仕様）。この仮想 server に別の信頼アプリを同時に attach しないでください。xpra/Xvfb 自体に脆弱性があった場合のみホスト権限まで escape する余地が残りますが、ホスト本体の X server に対するキーロガー・画面キャプチャ・キー注入・クリップボード窃取は構造的に不可能になります。

> [!NOTE]
> **WSL ユーザー向け**: WSL2 では `/tmp/.X11-unix` がカーネルにより read-only マウントされているため、Xvfb がソケットを作成できません。nas はこの状況を自動検知し、`unshare --user --mount` で private mount namespace を作成して回避します。ソケットの実体はセッションディレクトリ配下に置かれるため、Docker からも問題なくアクセスできます。この回避策は unprivileged user namespace が利用可能な環境で動作します。もし `unshare` が失敗する場合は、`sudo mount -o remount,rw /tmp/.X11-unix` を nas 起動前に実行してください。

### セッション管理（dtach）

`session.multiplex = true` にすると、nas プロセス全体（プロキシ等を含む）が dtach セッション内で起動されます。これにより複数のターミナルから同じセッションに attach でき、detach してもコンテナやプロキシは動き続けます。tmux と違い prefix キーの衝突やヘッダの二重表示が起きません。

```pkl
profiles {
  ["claude"] {
    agent = "claude"
    session {
      multiplex = true
      detachKey = "^\\"   // デタッチキー（デフォルト: Ctrl+\）
    }
  }
}
```

```sh
nas session                     # アクティブなセッション一覧（list のエイリアス）
nas session list                # アクティブな dtach セッション一覧
nas session attach <session-id> # セッションに再接続
```

### Worktree

`nas --worktree <base-branch> <profile>` を実行すると、ベースブランチから `nas/{profile}/{timestamp}` ブランチ付きの git worktree が自動作成されます。
エージェント終了後は、stash、コミットの cherry-pick、ブランチを残して手動で取り込む、などの方法で成果物を回収できます。

<details>
<summary>実行例</summary>

```
$ nas --worktree HEAD claude
[nas] Resolved HEAD to current branch: main
> git -C '/home/hogeyama/repo/nix-agent-sandbox' worktree add -b 'nas/claude/2026-03-17T14-01-57-692Z' '/home/hogeyama/repo/nix-agent-sandbox/.nas/worktrees/nas-claude-2026-03-17T14-01-57-692Z' main
Preparing worktree (new branch 'nas/claude/2026-03-17T14-01-57-692Z')
HEAD is now at d79dcfc

  ... (エージェントが起動し、作業を行う) ...

[nas] Worktree HEAD: 48be913994c4f92ac256d60215b72f0ab9aa1b15
[nas] ⚠ Worktree has uncommitted changes.
[nas] What to do with the worktree?
  1. Delete
  2. Keep
[nas] Choose [1/2]: 1
[nas] Worktree has uncommitted changes.
[nas] How should we handle them before deleting it?
  1. Stash and delete
  2. Delete without stashing
  3. Keep
[nas] Choose [1/2/3]: 1
> git -C '/home/hogeyama/repo/nix-agent-sandbox/.nas/worktrees/nas-claude-2026-03-17T13-35-20-819Z' stash push --include-untracked -m 'nas teardown nas-claude-2026-03-17T13-35-20-819Z 2026-03-17T13:35:33.117Z'
Saved working directory and index state On nas/claude/2026-03-17T13-35-20-819Z: nas teardown nas-claude-2026-03-17T13-35-20-819Z 2026-03-17T13:35:33.117Z
[nas] Stashed worktree changes: nas teardown nas-claude-2026-03-17T13-35-20-819Z 2026-03-17T13:35:33.117Z
[nas] What to do with the branch?
  1. Delete
  2. Cherry-pick to base branch
  3. Rename and keep
[nas] Choose [1/2/3]: 2
[nas] No commits to cherry-pick.
[nas] Removing worktree: /home/hogeyama/repo/nix-agent-sandbox/.nas/worktrees/nas-claude-2026-03-17T13-35-20-819Z
Deleted branch nas/claude/2026-03-17T13-35-20-819Z (was 48be913).
[nas] Deleted branch: nas/claude/2026-03-17T13-35-20-819Z
```

</details>

## 設定ファイル

`nas config init` でプロジェクトルートに `.nas/` ディレクトリが生成されます。設定は Pkl 形式です。

```
$XDG_CONFIG_HOME/nas/
├── Schema.pkl          # 型付きスキーマ（CLI が自動管理）
└── global.pkl          # グローバル設定 (amends "Schema.pkl")

.nas/
├── PklProject          # Pkl プロジェクト定義（CLI が自動管理）
├── Schema.pkl          # 型付きスキーマ（CLI が自動管理）
└── config.pkl          # プロジェクトローカル設定 ← これを編集する
```

`config.pkl` はデフォルトで `amends "modulepath:/global.pkl"` により [グローバル設定をベースにプロジェクト設定を上書き](src/config/Schema.pkl) する形でマージされます。グローバル設定を無視したい場合は `amends "Schema.pkl"` に切り替えてください。

各フィールドの型・デフォルト値・説明は [`src/config/Schema.pkl`](src/config/Schema.pkl) を参照してください。Pkl IDE 拡張（pkl-lsp）を使えば補完・型チェックも効きます。

```pkl
// .nas/config.pkl
amends "modulepath:/global.pkl"

default = "copilot-nix"

ui {
  enable = true
  port = 3939
  idleTimeout = 300
}

profiles {
  ["copilot-nix"] {
    agent = "copilot"
    nix {
      enable = "auto"
      mountSocket = true
    }
    docker {
      enable = false
      shared = false
    }
    network {
      allowlist = new Listing {
        "api.anthropic.com"
        "github.com:443"
        "*.githubusercontent.com:443"
      }
      proxy {
        forwardPorts = new Listing { 8080; 5432 }
      }
      prompt {
        enable = true
        timeoutSeconds = 300
        defaultScope = "host-port"
        notify = "auto"
      }
    }
    dbus {
      session {
        enable = false
        sourceAddress = "/path/to/bus"
        see = new Listing { "org.freedesktop.secrets" }
        talk = new Listing { "org.freedesktop.secrets" }
        calls = new Listing {
          new { name = "org.freedesktop.secrets"; rule = "*" }
        }
        broadcasts = new Listing {
          new { name = "org.freedesktop.secrets"; rule = "*" }
        }
      }
    }
    extraMounts = new Listing {
      new { src = "~/.cabal"; dst = "~/.cabal"; mode = "ro" }
      new { src = "/dev/null"; dst = ".env" }  // 相対パスは作業ディレクトリ基準
    }
    env = new Listing {
      new { key = "SOME_VAR"; val = "value" }
      new { key = "ANOTHER_VAR"; valCmd = "cat /path/to/value" }
      new { key = "PATH"; val = "/opt/hoge/bin"; mode = "prefix"; separator = ":" }
    }
    hostexec = new {
      secrets {
        ["github_token"] { from = "env:GITHUB_TOKEN"; required = true }
      }
      prompt {
        enable = true
        timeoutSeconds = 300
        defaultScope = "capability"
        notify = "auto"
      }
      rules = new Listing {
        new {
          id = "git-readonly"
          match { argv0 = "git"; argRegex = "^(pull|fetch)\\b" }
          cwd { mode = "workspace-or-session-tmp" }
          env { ["GITHUB_TOKEN"] = "secret:github_token" }
          inheritEnv { mode = "minimal"; keys = new Listing { "DISPLAY" } }
          approval = "prompt"
          fallback = "container"
        }
      }
    }
  }
}
```

### YAML から Pkl への移行

既存の `.agent-sandbox.yml` を Pkl 形式に変換するには:

```sh
nas config migrate yml2pkl            # ローカル設定を変換
nas config migrate yml2pkl --global   # グローバル設定を変換
```

- ローカル: cwd から親方向に `.agent-sandbox.yml` を探索し、`.nas/config.pkl` を生成
- グローバル: `$XDG_CONFIG_HOME/nas/agent-sandbox.yml` を `$XDG_CONFIG_HOME/nas/global.pkl` に変換
- 既に出力先が存在する場合はエラー。`--force` で上書き可能
- 変換後、元の YAML は手動で削除する

## 設定パターン

### .env を隠しつつ、必要なコマンドはホストに移譲する

```pkl
profiles {
  ["blah"] {
    agent = "copilot"
    extraMounts = new Listing {
      new { src = "/dev/null"; dst = ".env" }
      new { src = "package.json"; dst = "package.json"; mode = "ro" }
    }
    hostexec = new {
      secrets {
        ["build_api_token"] { from = "dotenv:.env#API_TOKEN"; required = true }
      }
      rules = new Listing {
        new {
          id = "pnpm-build"
          match { argv0 = "pnpm"; argRegex = "^build\\b" }
          cwd { mode = "workspace-only" }
          env { ["API_TOKEN"] = "secret:build_api_token" }
          approval = "allow"
          fallback = "deny"
        }
      }
    }
  }
}
```

> [!WARNING]
> `deno task` / `npm run` / `make` のような「設定ファイルを読んで実行するコマンド」を hostexec で委譲すると、
> エージェントがその設定ファイルを書き換えることで任意コマンドのホスト実行が可能になります。
> これらのコマンドを委譲する場合は `extraMounts` で設定ファイルを read-only マウントするなどしてください。

### Git の署名をホストに移譲する

```pkl
profiles {
  ["blah"] {
    agent = "copilot"
    env = new Listing {
      // hostexec の gpg で署名する
      new { key = "GIT_CONFIG_COUNT"; val = "1" }
      new { key = "GIT_CONFIG_KEY_0"; val = "gpg.program" }
      new { key = "GIT_CONFIG_VALUE_0"; val = "/opt/nas/hostexec/bin/gpg" }
    }
    hostexec = new {
      rules = new Listing {
        // git commit/tag -S が呼ぶ形だけを通す:
        //   gpg --status-fd=2 -bsau <keyid>
        new {
          id = "gpg-git-sign"
          match { argv0 = "gpg"; argRegex = "^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$" }
          cwd { mode = "workspace-or-session-tmp" }
          approval = "allow"
          fallback = "deny"
        }
        new {
          id = "gpg-default"
          match { argv0 = "gpg" }
          approval = "deny"
          fallback = "deny"
        }
      }
    }
  }
}
```

> [!WARNING]
> `gpg` のような「任意の引数で副作用を起こせるコマンド」を委譲する場合、`--sign` を含むだけ通す
> ような緩い regex は危険です（`--output` で任意ファイル上書き、`--homedir` で keyring 差し替え等）。
> git の呼び出し形 (`gpg --status-fd=2 -bsau <keyid>`) のような完全一致パターンに絞ってください。

### 相対パスのコマンド（`./gradlew` など）をホストに移譲する

```pkl
profiles {
  ["android"] {
    agent = "claude"
    hostexec = new {
      rules = new Listing {
        new {
          id = "gradlew"
          match { argv0 = "./gradlew" }
          cwd { mode = "workspace-only" }
          approval = "prompt"
          fallback = "deny"  // 相対パス argv0 では "container" は使用不可
        }
      }
    }
  }
}
```

> [!NOTE]
> 相対パス `argv0` を指定すると、コンテナ内の該当ファイル（例: `./gradlew`）がラッパースクリプトで bind-mount 置換されます。
> そのためコンテナ内での直接実行にフォールバックできず、`fallback` は `"deny"` のみ利用可能です。

### `http_proxy` を参照しないツールにプロキシを設定する

nas のコンテナ内では `http_proxy` / `https_proxy` が自動設定されますが、JVM ベースのツール（Gradle、Maven など）はこれらの環境変数を無視し、JVM システムプロパティでプロキシを受け取ります。
そのようなツールには `env` でプロパティを明示的に渡してください。nas の Envoy forward proxy はコンテナ内から `localhost:18080` でアクセスできます。

**Gradle**

```pkl
profiles {
  ["android"] {
    agent = "claude"
    env = new Listing {
      new {
        key = "GRADLE_OPTS"
        val = "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080 -Dhttp.nonProxyHosts=localhost|127.0.0.1"
      }
    }
  }
}
```

**Maven**

```pkl
profiles {
  ["java"] {
    agent = "claude"
    env = new Listing {
      new {
        key = "MAVEN_OPTS"
        val = "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080 -Dhttp.nonProxyHosts=localhost|127.0.0.1"
      }
    }
  }
}
```

### `cli_auth_credentials_store = "keyring"` な Codex を使う

```pkl
profiles {
  ["codex"] {
    agent = "codex"
    dbus {
      session {
        enable = true
        calls = new Listing {
          new { name = "org.freedesktop.secrets"; rule = "org.freedesktop.Secret.Service.OpenSession" }
          new { name = "org.freedesktop.secrets"; rule = "org.freedesktop.Secret.Service.SearchItems" }
          new { name = "org.freedesktop.secrets"; rule = "org.freedesktop.Secret.Item.GetSecret" }
        }
      }
    }
  }
}
```

## 運用コマンド

### Docker イメージの再ビルド

Docker イメージを再ビルドしたい場合（アップデート後など）は `rebuild` サブコマンドを使います。

```sh
nas rebuild
```

### Worktree の掃除

溜まった worktree を手動で管理するには `worktree` サブコマンドを使います。

```sh
nas worktree list            # nas が作成した worktree を一覧表示
nas worktree clean           # すべて削除（確認プロンプトあり）
nas worktree clean --force   # 確認なしで削除
```

### Sidecar コンテナの掃除

`docker.shared = true` や `network.allowlist` / `network.prompt.enable` を使っていると、DinD / Envoy 関連のコンテナが残ることがあります。未使用のものだけを止めて削除するには `container clean` を使います。

```sh
nas container clean
```

このコマンドは nas が管理する DinD / proxy コンテナのうち、現在どのエージェントコンテナからも使われていないものだけを `stop` + `rm` します。削除後に空になった nas 管理 network と DinD 用 tmp volume もあわせて回収します。現在実行中のエージェントコンテナは対象外です。

### セッションの管理

`session.multiplex = true` のときに使えるセッション管理コマンドです。

```sh
nas session                     # アクティブなセッション一覧（list のエイリアス）
nas session list                # アクティブな dtach セッション一覧
nas session list --format json  # JSON 形式で出力
nas session attach <session-id> # セッションに再接続（複数ターミナルから同時 attach 可能）
```

### Network 承認キューの確認と操作

デスクトップ通知からの操作に加えて、コマンドでも approve / deny できます。

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

### HostExec 承認キューの確認と操作

デスクトップ通知からの操作に加えて、コマンドでも approve / deny できます。

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

### セッション通知（エージェントフック経由）

`nas hook --kind start|attention|stop [--when path=value ...]` をエージェントのフックから呼び出すと、
そのセッションが今「エージェントが作業中（`agent-turn`）」「ユーザーの入力待ち（`user-turn`）」「終了済み（`done`）」のどれにあるかを nas UI に伝えられます。UI 上で `user-turn` を ACK すると `ack-turn`（認識済み・検討中）として表示されます。

Claude Code のフック設定は `~/.claude/settings.json`（ユーザー共通）またはプロジェクト直下の `.claude/settings.json` に書きます。設定例:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "nas hook --kind start" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "nas hook --kind start" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "nas hook --kind attention" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "nas hook --kind attention" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "nas hook --kind stop" }] }
    ]
  }
}
```

GitHub Copilot CLI では、リポジトリ直下の `.github/hooks/*.json` を読み込みます。設定例:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "nas hook --kind start",
        "timeoutSec": 10
      }
    ],
    "userPromptSubmitted": [
      {
        "type": "command",
        "bash": "nas hook --kind start",
        "timeoutSec": 10
      }
    ],
    "preToolUse": [
      {
        "type": "command",
        "bash": "nas hook --kind attention --when toolName=ask_user",
        "timeoutSec": 10
      }
    ],
    "postToolUse": [
      {
        "type": "command",
        "bash": "nas hook --kind start --when toolName=ask_user",
        "timeoutSec": 10
      }
    ],
    "sessionEnd": [
      {
        "type": "command",
        "bash": "nas hook --kind stop",
        "timeoutSec": 10
      }
    ]
  }
}
```

`notification` フックを無条件に `attention` へつなぐと `permission_prompt` なども拾ってしまうため、
この用途では設定しないでください。`--when` はドット区切りの JSON パスに対する完全一致です
（例: `toolResult.resultType=success`）。

OpenAI Codex CLI では、`~/.codex/config.toml`（ユーザー共通）または
リポジトリ直下の `.codex/config.toml` に書きます。設定例:

```toml
[features]
codex_hooks = true

[[hooks.SessionStart]]
matcher = "startup|resume"
[[hooks.SessionStart.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind start || true'"
timeout = 10

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind start || true'"
timeout = 10

[[hooks.PreToolUse]]
matcher = "*"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind start || true'"
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "sh -c 'test -n \"${NAS_SESSION_ID:-}\" && exec nas hook --kind attention || true'"
timeout = 10
```

![ui containers tab](./images/ui-containers.png)

## セキュリティについて

nas はコンテナ内のファイルシステム変更をホストから隔離しますが、**設定次第ではホストの認証情報やデーモンへのアクセスを許可します**。各機能のリスクを理解した上で有効化してください。

### デフォルトで隔離されるもの

- **ファイルシステム**: マウントされたディレクトリ／ファイルを除き、コンテナ内の変更は overlay で隔離され、ホストには影響しません
- **プロセス・ネットワーク**: Docker コンテナの標準的な隔離が適用されます

### ネットワーク制御（`network.allowlist` / `network.prompt`）

nas は shared Envoy forward proxy、host 上の auth-router、session ごとの broker を使って、エージェントコンテナの外部通信を常に制御します。`network.allowlist` に一致する通信は即時許可され、allowlist 外通信は `network.prompt.enable = true` のときだけ pending になり、無効時は deny されます。

```
session network
├── Agent container   (http_proxy / https_proxy → nas-envoy:15001)
├── shared Envoy      (dynamic forward proxy + ext_authz)
├── auth-router       (host daemon, UDS)
└── DinD sidecar      (有効時のみ同じ session network に attach)
```

- エージェントは資格情報付き proxy URL を通じて Envoy に接続し、`Proxy-Authorization` は auth-router で検証された後に upstream へは除去されます
- `localhost` / loopback / RFC1918 / link-local / ULA など deny-by-default 宛先は broker 前で拒否されます
- `network.prompt.enable = true` のとき、allowlist 外通信は `nas network pending` に現れ、`approve` / `deny` で制御できます
- DinD 有効時、`docker.shared = true` なら既存の共有 DinD サイドカーに session network を attach するだけで、サイドカー自体は再作成されません

### 設定により隔離が緩和されるもの

以下の設定は明示的な opt-in です。有効にするとコンテナからホストリソースへのアクセスが可能になります。

| 設定 | リスク |
|------|--------|
| `nix.mountSocket = true` | ホストの nix-daemon ソケットをコンテナに渡す。nix-daemon 経由で任意のビルド実行・`/nix/store` への書き込み・後続の nix 操作への影響などが可能で、実質的にホストユーザーと同等の権限をコンテナに与えることになる。信頼できないプロジェクト／エージェントで有効化しない |
| `docker.enable = true` | `docker:dind-rootless` サイドカーが `--privileged` で起動される（user namespace セットアップに必要）。エージェントコンテナ自体は非特権のまま。Docker 操作はサイドカー内に隔離され、ホストの Docker デーモンにはアクセスできない |
| `network.proxy.forwardPorts` | 指定した各ポートについて、ホスト `127.0.0.1:<port>` に bind しているサービスへコンテナから直接到達できるようになる（per-port UDS をコンテナへ bind-mount し、コンテナ内の `127.0.0.1:<port>` をホストの同ポートに pipe する）。ホスト側を `0.0.0.0` に晒す必要はないが、認証なしで動かしている開発用 DB・管理 UI・デーモンがあれば、コンテナ内のエージェントがそのままフルアクセスできる点に注意 |
| `dbus.session.enable = true` | 許可した DBus service に対して host 側資産へ到達できる。session bus 全体の露出は減るが、許可先 service の権限そのものは残る |
| `gpg.forwardAgent = true` | ホストの gpg-agent ソケットと公開鍵リング・信頼 DB・設定ファイルがコンテナにマウントされる。agent が unlock されている間はコンテナから任意の署名・復号が可能 |
| `extraMounts` | 指定したホストディレクトリがコンテナにマウントされる（`mode = "rw"` の場合は書き込みも可能） |
| `display.sandbox = "xpra"` | ホスト上に xpra の detached X server (Xvfb backing) を 1 つ起動し、その Xvfb ソケット + per-session cookie のみコンテナへ渡す。nas プロセスが seamless モードの `xpra attach :N` を同時に自動起動するため、エージェントが描画したウィンドウはユーザのデスクトップに通常のウィンドウとして出る。エージェントはこの仮想 X server **内**のアプリに対しては X11 client として全権を持つ（同 server 内のキー入力・画面取得・キー注入は可能）。ホスト本体の X server へは到達不可。xpra の control socket は xpra デフォルト (`$XDG_RUNTIME_DIR/xpra/`) に置かれる（ユーザ自身が再 attach/stop に使うだけで機微情報ではない）。xpra/Xvfb 自体に脆弱性があった場合のみホスト権限まで escape する余地あり |
| `hostexec.rules[].inheritEnv.mode = "unsafe-inherit-all"` | host の環境変数が広く継承されるため、secret 漏えい面が大きくなる |

### HostExec の注意点

hostexec ルールで許可したコマンドはホスト側で実行されるため、そのコマンドが持つ能力（任意コード実行経路、任意ファイル I/O、ネットワーク、鍵アクセス等）はそのままエージェントの能力になります。ルールを追加する際は「意図した機能」だけでなく「そのコマンドで他に何ができてしまうか」（全オプション、設定ファイル依存、任意コード実行パス）を把握した上で追加してください。特に `approval = "allow"` は恒久的な貫通口になるため、必要最小限に留めてください。

ルール設計時の指針:

- hostexec の入力となるパス（`argv0`、ホスト側 `PATH` に含まれるディレクトリ、委譲先コマンドが参照する設定ファイル 等）は、コンテナから書き込み不能に保たれる必要があります。これが崩れるとエージェントによる書き換えが直ちにホスト任意コード実行に繋がります
  - 相対パス `argv0`（例: `./scripts/foo`）→ 対応する `extraMounts` を `mode = "ro"` に
  - bare name `argv0`（例: `git`）→ ホスト側 `PATH` 上のディレクトリ（`~/.local/bin`, `~/.nix-profile/bin` 等）を `extraMounts` で rw マウントしない
  - 設定ファイルを読むコマンド（`deno task` / `npm run` / `make` 等）→ 当該設定ファイルを `ro` マウントする
- `"allow"` はできる限り避け、`approval = "prompt"` + 絞り込んだ `argRegex` を既定とする
- `bash -lc` / `sh -c` / `python -c` のような任意コード実行に直結する委譲はルール化しない
- `"unsafe-inherit-all"` は互換性用の escape hatch。通常は `"minimal"` + `inheritEnv.keys` を使う

特に注意すべきコマンドカテゴリ:

- **テスト・ビルドランナー**（`bun test`, `npm test`, `make`, `cargo` ...）: 定義上、テスト・ビルドファイル経由で任意コード実行
- **言語ランタイム**（`python`, `node`, `ruby`, `deno` ...）: `-c` / スクリプト引数で任意コード実行
- **ローカルに HTTP サーバを立てるツール**（静的ファイルサーバ / live-reload プレビュー / API モック 等）: `--bind` で非-loopback、あるいは `--port` を `network.proxy.forwardPorts` と衝突させると、コンテナからホスト任意ファイルが読める経路になる
- **`gpg`**: `--output` 系オプションでホスト任意パスへの書き込みが可能。`argRegex` で意図した最小フォーマット（例: git の署名だけ許すなら `^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$`）に絞ること
- **エディタ**（`vim`, `nvim`, `emacs` ...）: `:!` / 設定ファイルから任意コマンド起動
- **ネットワークツール**（`curl`, `wget`, `ssh` ...）: 任意 I/O。`ssh` は `ProxyCommand` 経路でシェル実行
- **`git`**: 引数内 alias 定義（`-c 'alias.x=!cmd'`）で任意シェルが走る。`git push` 等をピンポイントで deny するより、「想定の sub-command パターンに match する prompt ルール」の方が安全
- **パッケージマネージャ**（`npm install`, `pip install`, `cargo install` ...）: post-install / build スクリプトによる任意コード実行
- **プロセス置換系**（`env`, `xargs`, `find -exec`, `rg --pre` 等）: 結局別のコマンドに橋渡しする構造なので arg 制約が必須

マッチ仕様と周辺の挙動:

- `argv0` には bare name（`git`）、絶対パス（`/usr/bin/git`）、相対パス（`./scripts/foo`）を指定できます
  - bare name: PATH 上のラッパーシンボリックリンクで委譲
  - 絶対パス・相対パス: `LD_PRELOAD` による `execve` インターセプトで委譲
- `argRegex` は引数をスペースで join した文字列に対してマッチします。そのためスペースを含む単一引数（例: `git commit -m "hello world"` の `"hello world"`）と複数引数の区別はできません。実用上、コマンド識別に使う先頭引数やフラグにスペースが含まれることは少ないため問題になることは多くないですが、引数の値そのものに依存するマッチパターンを書く場合は留意してください
- エージェント設定ディレクトリ（`~/.claude/` / `~/.copilot/` / `~/.codex/`）は存在すれば常にマウントされるため、これらに認証トークンが置かれている場合は hostexec を制限してもコンテナ内からアクセス可能です

### 常にマウントされるもの

- **エージェントの設定**: ホスト上に存在する場合のみ、Claude Code は `~/.claude/`、Copilot CLI は `~/.copilot/`、OpenAI Codex CLI は `~/.codex/` がコンテナに渡されます。
- **Nix（有効時）**: ホストの `/nix` ディレクトリと nix daemon ソケットがマウントされます。

### 推奨事項

- `.nas/config.pkl` ではまず最小限の設定から始め、必要に応じて機能を追加してください
- `docker.enable` は Docker-in-Docker が必要な場合のみ有効にしてください（DinD rootless サイドカーが起動されます）
- クラウド認証情報のマウントは、エージェントにクラウドリソースへのアクセスが必要な場合のみ有効にしてください

## 制約・注意事項

### エージェントバイナリ

- **npm でインストールされたエージェントは動作しません。** npm 版は `node_modules/` ツリー全体に依存するため、単一ファイルのバインドマウントでは起動できません。必ず公式のスタンドアロンインストーラーを使ってください。

### ファイル所有権

- コンテナ内のエージェントプロセスは、ホストユーザーと同じ UID/GID で実行されます。作成・変更されたファイルはホストユーザー所有になります。
- entrypoint は root で起動し（overlay セットアップ等）、エージェント起動前にホスト UID にドロップします。

### TTY

- インタラクティブモード（引数なしでエージェントを起動）には TTY が必要です。
- CI/スクリプトなど非 TTY 環境では `nas copilot -p "プロンプト"` のように profile 名の後ろへ直接引数を渡すか、デフォルトプロファイルを使う場合は `-- -p "プロンプト"` を使ってください。

### Docker

- `docker.enable = true` は `docker:dind-rootless` サイドカーを起動します。サイドカーは `--privileged` で起動されますが、エージェントコンテナは非特権のままです。Docker 操作はホストから隔離されます。
- ビルドキャッシュは Docker named volume (`nas-docker-cache`) に永続化されます。`docker volume rm nas-docker-cache` でクリアできます。

### Nix 固有

- ホストに nix がインストールされ、nix-daemon が動作している必要があります。
- ホストの `/nix` ディレクトリ全体がコンテナにマウントされます。

## UI daemon

UI daemon はセッション開始時に `setsid` で完全にデタッチされるため、nas プロセスの終了後も生存します。`idleTimeout` 経過後に自動停止します。

`nas ui` コマンドで手動起動することもできます:

```sh
nas ui                          # config のデフォルト設定で起動
nas ui --port 8080              # ポートを指定
nas ui --idle-timeout 0         # 自動停止しない
nas ui --no-open                # ブラウザを自動で開かない
nas ui stop                     # daemon を停止
nas ui stop --port 8080         # ポートを指定して停止
```

## 設定リファレンス

全フィールドの型・デフォルト値・説明は [`src/config/Schema.pkl`](src/config/Schema.pkl) を参照してください。
