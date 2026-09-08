---
title: 設定の変更と反映
description: 一時承認と設定変更の選択、編集先、プロファイル、変更の反映
---

Pending に届いた要求は、[UI の承認](/nix-agent-sandbox/work/approvals/)で一回だけ許可できます。設定で直接拒否された要求は Pending に届かないため、今回限りでも許可ルールの変更が必要です。UI での一時承認は別のセッションには引き継がれません。次の作業でも使う通信先やツール、共有ファイルを変える場合は、設定を編集して新しいセッションへ反映します。

## 設定ファイルの選択

| 変更を使う範囲 | 編集先 |
| --- | --- |
| このプロジェクトだけ | プロジェクトの `.nas/config.pkl` |
| 複数のプロジェクトで共通 | `~/.config/nas/global.pkl` |

`XDG_CONFIG_HOME` を指定している場合、共通設定は `$XDG_CONFIG_HOME/nas/global.pkl` です。設定ファイルがなければ[最初の作業](/nix-agent-sandbox/getting-started/quick-start/)で作成します。

プロジェクト設定の `amends "modulepath:/global.pkl"` は共通設定を引き継ぐ指定です。プロジェクトで変更した内容は、共通設定のファイルを書き換えません。生成された `Schema.pkl` と `PklProject` は nas が管理するため、編集先には使いません。

## プロファイルの選択

プロファイルは、使うエージェントと許可範囲などの設定の組み合わせです。`profiles` の `["codex"]` はその名前で、`nas codex` や UI の New Session → Profile で選びます。中の `agent = "codex"` はエージェントの種類を指し、プロファイル名は `dev` など別の名前でも構いません。

共通設定には `claude` と `codex` が生成されます。これから使うプロファイルを選んで変更します。**Claude 用プロファイルに追加した通信許可は Codex には適用されません。** 別のエージェントを使う場合も、そのプロファイルの[通信許可](/nix-agent-sandbox/configuration/network/)を設定します。

## プロファイルの編集

ホストのキャッシュを Codex に読み取り専用で渡す例で、追加位置を確認します。`~/.cache/my-tool` は実在する共有元に置き換えます。

### 初期生成したファイル

`nas config init` が生成したファイルの末尾には、次の `profiles` があります。

```pkl
profiles {
  ["claude"] = extendProfile(super["claude"])
  ["codex"] = extendProfile(super["codex"])
}
```

`super["codex"]` は共通設定の codex です。`extendProfile` は同じファイルの上部に定義された関数で、その中に追加した設定は関数を使う claude と codex の両方に適用されます。

Codex にだけ共有を追加する場合は、末尾を次の形に変更します。上部の `amends` と `extendProfile` の定義は残します。

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

既存の設定を受け取り、後ろの波括弧でキャッシュを追加しています。共通設定や関数内の通信許可も引き継ぎます。

### すでに編集したファイル

最初の作業で作った claude のように、`["claude"] = (super["claude"]) { ... }` になっている場合は、その内側へ追加します。既存の `network` は残し、その隣に置きます。

```pkl
extraMounts {
  new { src = "~/.cache/my-tool"; dst = "~/.cache/my-tool"; mode = "ro" }
}
```

同じファイルに `extraMounts` があれば、ブロックをもう一つ作らず、その中へ `new { ... }` を追加します。他の設定例も、既存項目の中に追加するのか、初めて項目を作るのかを確認して使ってください。

`extraMounts { ... }` は引き継いだ一覧へ追加する書き方です。`extraMounts = new Listing { ... }` は一覧を置き換えます。既存の共有やルールを残す場合は、新しい一覧で上書きしないでください。

## 別のプロファイル

別の組み合わせを残す場合は、`profiles` の中に別名で追加します。共通設定の codex を引き継ぎ、Docker を有効にする例です。

```pkl
["dev"] = (super["codex"]) {
  docker { enable = true }
}
```

`nas dev` または UI の Profile → dev で選びます。これは共通設定の codex を継承し、プロジェクト側の codex にだけ書いた変更は継承しません。必要な通信設定の置き場所も確認します。

プロファイル名を省略した `nas` の起動には、トップレベルの `default` が使われます。初期設定は `"claude"` です。変更する場合は `profiles` の外に `default = "dev"` のように指定します。

## UI の設定

UI は既定でエージェントとともに自動起動します。`ui` はプロファイルごとの項目ではなく、`profiles` の外側に置きます。

```pkl
ui { port = 3939 }

profiles {
  ["claude"] = super["claude"]
  ["codex"] = super["codex"]
}
```

これは配置の例です。編集中の profiles はそのまま残し、ui がすでにあれば既存のブロックを編集します。

| 設定 | 既定 | 動作 |
| --- | --- | --- |
| `ui.enable` | `true` | エージェント起動時に UI を自動起動。false は自動起動なし。 |
| `ui.port` | `3939` | UI の待ち受けポート。ブラウザで開く URL もこの番号に合わせる。 |
| `ui.idleTimeout` | `300` | セッションも承認待ちもない状態で自動停止するまでの秒数。0 は自動停止なし。 |

`observability` もトップレベルです。記録内容を変える場合は[記録と保存期間](/nix-agent-sandbox/configuration/recording/)を参照します。

## 変更の反映と確認

設定はホストのファイル共有やコマンド実行にも影響します。差分を確認し、プロジェクトのルートで信頼し直します。

```sh
nas config trust
```

その後、変更したプロファイルで新しいセッションを起動します。上の Codex の例なら `nas codex`、別名の例なら `nas dev` です。既存のセッションへ設定を追加する操作ではありません。

キャッシュ共有の例では、エージェントに指定フォルダーを一覧させ、ホストと同じファイルが見えることを確認します。通信を変えた場合は、対象の要求と UI の判定を確認します。

`.nas/` 直下のユーザー作成 `.pkl` ファイルを変更すると、再び信頼確認が必要です。信頼を取り消すコマンドは `nas config untrust` です。[設定がホストへ与える影響](/nix-agent-sandbox/security/isolation/#プロジェクト設定の信頼)も確認してください。

CI など非対話で起動する場合も、先に設定の内容を確認して信頼しておく必要があります。引数なしの対話起動には TTY が必要なため、スクリプトではエージェントにプロンプトなどの引数を渡します。

全設定の型と既定値は [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) にあります。
