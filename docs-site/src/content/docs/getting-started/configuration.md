---
title: 設定の基本
description: profile、グローバル設定、プロジェクト設定の関係
---

nas の設定は Pkl 形式です。`nas config init` を実行すると、ユーザー共通の設定とプロジェクト固有の設定が生成されます。通常は `.nas/config.pkl` を編集します。

## 生成されるファイル

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

## profile と継承

`global.pkl` は `Schema.pkl` を継承し、既定の profile を定義します。生成される `.nas/config.pkl` は次のようにグローバル設定を継承し、同名 profile に変更を重ねます。

```pkl
amends "modulepath:/global.pkl"

profiles {
  ["claude"] = extendProfile(super["claude"])
  ["codex"] = extendProfile(super["codex"])
}
```

`amends "modulepath:/global.pkl"` は `PklProject` が設定する module path からグローバル設定を読み、共通の profile をプロジェクトで拡張します。`env`、`extraMounts`、`hostexec.rules`、`network.proxy.forwardPorts` のリストは追加され、`network.scopes` と `secrets` のマッピングはキーごとにマージされます。

プロジェクトをグローバル設定から独立させたい場合は、先頭を `amends "Schema.pkl"` に変えます。この場合はスキーマだけを継承するため、必要な `default` と `profiles` をそのプロジェクトの `config.pkl` で定義します。

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

`NAS_CONFIG_TRUST_ALL=1` は trust gate を完全に bypass します。通常の project や共有環境では使わず、設定が渡せる host capability は[信頼境界](/nix-agent-sandbox/security/model/#repository-trust)で確認してください。

全フィールド、型、既定値はリポジトリの [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) を参照してください。
