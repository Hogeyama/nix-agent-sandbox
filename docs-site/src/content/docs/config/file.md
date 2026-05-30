---
title: 設定ファイル
description: .nas/ ディレクトリと config.pkl の構造
---

`nas config init` を実行すると、プロジェクトルートに `.nas/` ディレクトリが作られます。設定は [Pkl](https://pkl-lang.org/index.html) 形式で、`config.pkl` だけを手で編集すればよく、スキーマやプロジェクト定義は CLI が自動で管理します。ユーザー共通の設定はホームの設定ディレクトリ側に置けます。

```
$XDG_CONFIG_HOME/nas/
├── Schema.pkl          # 型付きスキーマ（CLI が自動管理）
└── global.pkl          # グローバル設定 (amends "Schema.pkl")

.nas/
├── PklProject          # Pkl プロジェクト定義（CLI が自動管理）
├── Schema.pkl          # 型付きスキーマ（CLI が自動管理）
└── config.pkl          # プロジェクトローカル設定 ← これを編集する
```

雛形の `config.pkl` は冒頭が `amends "modulepath:/global.pkl"` になっており、[グローバル設定をベースにプロジェクト設定を上書き](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl)する形でマージされます。プロジェクトごとに独立させたい（グローバル設定を無視したい）場合は、この行を `amends "Schema.pkl"` に書き換えてください。

各フィールドの型・デフォルト値・説明は [`src/config/Schema.pkl`](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) を参照してください。Pkl IDE 拡張（pkl-lsp）を使えば補完・型チェックも効きます。

## 主要フィールド全部入り config.pkl サンプル

```pkl
// .nas/config.pkl
amends "modulepath:/global.pkl"

default = "claude"

ui {
  enable = true
  port = 3939
  idleTimeout = 300
}

observability {
  enable = true
}

profiles {
  ["claude"] {
    agent = "copilot"
    agentArgs = new Listing { "--dangerously-skip-permissions" }
    nix {
      enable = "auto"
      mountSocket = true
    }
    docker {
      enable = true # DinDサイドカーを使う
      shared = true # DinDサイドカーを複数コンテナで共有する
    }
    network {
      proxy {
        forwardPorts = new Listing { 8080; 5432 }
      }
      allowlist = new Listing {
        "api.anthropic.com"
      }
      # allowlist に載っていない通信があったときに承認を求めるプロンプトの設定
      prompt {
        enable = true
        timeoutSeconds = 300
        defaultScope = "host-port"
        notify = "auto"
        denyList = new Listing {
          "www.google.com"
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
      prompt {
        enable = true
        timeoutSeconds = 300
        notify = "auto"
      }
      rules = new Listing {
        new {
          // git commit/tag -S が呼ぶ形 `gpg --status-fd=2 -bsau <keyid>`
          id = "gpg-git-sign"
          match {
            argv0 = "gpg"
            argRegex = "^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$"
          }
          cwd {
            mode = "workspace-or-session-tmp"
          }
          approval = "allow"
          fallback = "container"
        }
      }
    }
  }
}
```
