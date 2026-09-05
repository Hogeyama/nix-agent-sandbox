---
title: 設定の基本
description: 設定の適用範囲、プロファイルの選択、設定例の追加方法
---

機能ページの設定例を自分の設定に追加するための説明です。設定ファイルがまだない場合は、[クイックスタート](../quick-start/)で作成と最初の起動を済ませてください。

## 設定の適用範囲

設定を使いたい範囲に応じて、編集するファイルを選びます。

| 適用範囲 | 編集するファイル |
| --- | --- |
| このプロジェクトだけ | プロジェクト内の `.nas/config.pkl` |
| 複数のプロジェクトで共通 | `~/.config/nas/global.pkl` |

`XDG_CONFIG_HOME` を指定している場合、共通設定の場所は `$XDG_CONFIG_HOME/nas/global.pkl` です。

設定ファイルは Pkl 形式です。生成された `.nas/config.pkl` の先頭にある `amends "modulepath:/global.pkl"` は、共通設定を引き継ぐ指定です。プロジェクト側には、その設定から変えたい部分を書きます。共通設定のファイル自体は変更されません。

## プロファイルと起動コマンド

同じプロジェクトでも、使うエージェントや許可する機能を切り替えられます。この設定の組み合わせに名前を付けたものが「プロファイル」です。

`profiles` の中の `["codex"]` はプロファイル名です。`nas codex` と起動すると、この名前の設定が選ばれます。一方、その中の `agent = "codex"` は、実行するエージェントの種類を指定します。プロファイル名は `dev` など別の名前にもできます。

生成される共通設定には `claude` と `codex` があります。以下では `codex` に設定を追加します。Claude Code を使っている場合は、`claude` を編集してください。

## プロファイルの編集

例として、ホストのキャッシュフォルダーを、このプロジェクトの Codex から読み取れるようにします。`~/.cache/my-tool` は、共有したい既存のフォルダーに置き換えてください。

### 初期生成ファイル

`nas config init` が生成した `.nas/config.pkl` では、末尾の `profiles` が次の形になっています。

```pkl
profiles {
  ["claude"] = extendProfile(super["claude"])
  ["codex"] = extendProfile(super["codex"])
}
```

`super["codex"]` は共通設定の `codex` を指します。`extendProfile` は、そのファイル内で定義されている関数です。この関数の中に書いた設定は、関数を呼び出している `claude` と `codex` の両方に適用されます。

Codex にだけ追加する場合は、`codex` の行を次のように変更します。ファイル上部の `amends` と `extendProfile` の定義は残してください。

```pkl
profiles {
  ["claude"] = extendProfile(super["claude"])
  ["codex"] = (extendProfile(super["codex"])) {
    extraMounts {
      new { src = "~/.cache/my-tool"; dst = "~/.cache/my-tool"; mode = "ro" }
    }
  }
}
```

`(extendProfile(super["codex"]))` で既存の設定を受け取り、その直後の `{ ... }` で今回の共有フォルダーを追加しています。共通設定や関数内に書かれた通信許可などは引き継ぎます。

### 編集済みのファイル

クイックスタートの例では、`claude` はすでに `["claude"] = (super["claude"]) { ... }` の形になっています。この場合は、その波括弧の内側に、`network` と並べて次の `extraMounts` を追加します。既存の `network` は残してください。

```pkl
extraMounts {
  new { src = "~/.cache/my-tool"; dst = "~/.cache/my-tool"; mode = "ro" }
}
```

すでに `extraMounts` がある場合は、ブロックをもう一つ作らず、その中へ `new { ... }` の行を追加します。他の機能でも、同じ設定項目がすでにあるかを確認してから編集してください。

## プロファイルの追加

既存の設定を残して別の組み合わせを使う場合は、`profiles` の中に別名の項目を追加します。次は、共通設定の `codex` を引き継ぎ、Docker を有効にする `dev` の例です。

```pkl
["dev"] = (super["codex"]) {
  docker { enable = true }
}
```

この設定は `nas dev` で選びます。エージェントの種類と通信許可は共通設定の `codex` から引き継ぎます。プロジェクト側の `codex` にだけ追加した設定は引き継がないため、必要な通信設定をどちらに書いたか確認してください。

プロファイル名を省略して `nas` で起動する場合は、ファイルの最上位にある `default` が選択する名前を決めます。初期設定は `default = "claude"` です。`dev` を既定にするには、`profiles` の外に `default = "dev"` と書きます。

## プロファイル外の設定

`ui` と `observability` はプロファイルごとに指定する項目ではありません。機能ページの例を、`profiles` の波括弧の外に追加してください。

```pkl
ui { port = 3939 }

profiles {
  ["claude"] = super["claude"]
  ["codex"] = super["codex"]
}
```

これは配置を示す例です。編集済みの `profiles` はそのまま残し、`ui` がすでにあれば既存のブロックを編集します。

## 変更の反映

プロジェクト設定はホストのファイル共有やコマンド実行にも影響するため、変更後には内容を確認して信頼し直します。ホストのターミナルで、プロジェクトのルートから実行してください。

```sh
nas config trust
nas codex
```

`claude` や `dev` を編集した場合は、起動コマンドもその名前に変えます。設定は次に起動するセッションで使われます。

キャッシュ共有の例では、起動したエージェントに指定フォルダーの内容を一覧させ、ホストと同じファイルが見えることを確認します。

`.nas/` 内のユーザー作成 `.pkl` ファイルを変更すると、再び信頼確認が必要です。信頼を取り消すコマンドは `nas config untrust` です。設定がホストに与える影響は[プロジェクト設定の信頼](/nix-agent-sandbox/security/model/#repository-trust)を参照してください。

設定項目の型と既定値は [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) にあります。生成された `Schema.pkl` と `PklProject` は nas が管理するため、設定変更には使いません。
