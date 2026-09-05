---
title: 設定の基本
description: 設定ファイルの編集先、プロファイル、共通設定の継承
---

nas の設定は Pkl 形式です。`nas config init` を実行すると、ユーザー共通の設定とプロジェクト固有の設定が生成されます。通常は `.nas/config.pkl` を編集します。

## プロファイルの編集

プロファイルは、エージェントとその実行設定をまとめたものです。たとえば `.nas/config.pkl` の `codex` に設定を追加すると、`nas codex` でその設定を使います。

各機能ページの設定例は、対象プロファイルの `{ ... }` 内に追加します。`ui` と `observability` だけはトップレベルに指定します。次は、共通設定の `codex` に読み取り専用マウントを追加する例です。

```pkl
amends "modulepath:/global.pkl"

profiles {
  ["claude"] = super["claude"]
  ["codex"] = (super["codex"]) {
    extraMounts {
      new { src = "~/.cache/my-tool"; dst = "~/.cache/my-tool"; mode = "ro" }
    }
  }
}
```

編集後は内容を確認して `nas config trust` を実行し、`nas codex` で起動します。

## 共通設定と継承

ユーザー共通の設定は `~/.config/nas/global.pkl` にあります。`XDG_CONFIG_HOME` の指定があれば、その配下の `nas/global.pkl` を使います。プロジェクトの `.nas/config.pkl` は、同名プロファイルに変更を重ねます。

`amends "modulepath:/global.pkl"` が共通設定を読み込みます。`env`、`extraMounts`、`hostexec.rules`、`network.proxy.forwardPorts` のリストは追加され、`network.scopes` と `secrets` のマッピングはキーごとにマージされます。

プロジェクトをグローバル設定から独立させたい場合は、先頭を `amends "Schema.pkl"` に変えます。この場合はスキーマだけを継承するため、使用する `profiles` と、必要なら既定のプロファイルを選ぶ `default` をそのプロジェクトの `config.pkl` で定義します。

```pkl
amends "Schema.pkl"

default = "claude"

profiles {
  ["claude"] { agent = "claude" }
}
```

## 信頼の確認

プロジェクトの `.nas/config.pkl` はホスト側のコマンド実行、マウント、ネットワーク設定に影響できます。そのため nas は、内容が変わったプロジェクト設定を自動では信頼しません。内容を確認してから、プロジェクトのルートで次を実行してください。

```sh
nas config trust
```

信頼は `.nas/` 内のユーザー作成 `.pkl` ファイルの内容に結び付き、変更すると再承認が必要です。信頼を取り消すには `nas config untrust` を使います。

`NAS_CONFIG_TRUST_ALL=1` は設定の信頼確認を完全に無効化します。設定によるホストへの影響は[プロジェクト設定の信頼](/nix-agent-sandbox/security/model/#repository-trust)で確認してください。

全フィールド、型、既定値はリポジトリの [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) を参照してください。

## 設定ファイルの一覧

```text
$XDG_CONFIG_HOME/nas/
├── Schema.pkl          # 型付きスキーマ。CLI が更新を管理する
└── global.pkl          # ユーザー共通の設定

.nas/
├── .gitignore          # .nas/ 配下を Git 管理から除外する
├── PklProject          # Pkl の module path 定義。CLI が管理する
├── Schema.pkl          # 型付きスキーマ。CLI が毎回更新する
└── config.pkl          # プロジェクト固有の設定。通常はこれを編集する
```

`XDG_CONFIG_HOME` が未設定の場合、グローバル設定の場所は `~/.config/nas/` です。
