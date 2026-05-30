---
title: クイックスタート
description: 最小構成で nas を起動するまで
---

```sh
cd /path/to/your-project
nas config init                 # .nas/ ディレクトリと設定ファイルを生成
vim .nas/config.pkl             # 設定を編集

nas                             # デフォルトプロファイルで起動
nas copilot-nix                 # プロファイルを指定して起動
nas copilot-nix -p "blah"       # オプションをエージェントに渡して起動
```

`config.pkl` は [Pkl](https://pkl-lang.org/index.html) 形式で、`profiles` の下に用途別の起動設定（プロファイル）を並べる構造です。最小構成なら、使うエージェントと通信を許可するドメインを書く程度で動きます。

```pkl
// .nas/config.pkl
amends "modulepath:/global.pkl"

default = "copilot-nix"

profiles {
  ["copilot-nix"] {
    agent = "copilot"
    network {
      allowlist = new Listing {
        "api.anthropic.com"
        "github.com:443"
        "*.githubusercontent.com:443"
      }
    }
  }
}
```

全フィールドは[設定ファイル](/nix-agent-sandbox/config/file/)を参照してください。
