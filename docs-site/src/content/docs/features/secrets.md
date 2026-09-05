---
title: シークレット・認証情報
description: 秘密値の取得元、マスク、認証情報の共有
---

API トークンなどの値は、設定に直接書かず `secrets` に取得元を登録します。ホストで値を取得し、ファイル表示やコマンド出力のマスク、HTTP 認証ヘッダーへの注入に使えます。

通常の `env` に値を書くと、そのままコンテナに渡ります。ファイル表示とコマンド出力をマスクするには、`secrets` に加えて `mask` の設定が必要です。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

`.env` の値を秘密値として登録し、ファイル表示とコマンド出力で隠します。

```pkl
secrets {
  ["api-token"] { from = "dotenv:.env#API_TOKEN"; required = true }
}

mask = new MaskConfig {
  maskfs = true
  proxy = true
  filter = true
  apply = new Listing { "api-token" }
  writePolicy = "readonly"
}
```

起動後、エージェントがファイルを読むと、登録したトークンと一致する値は同じ長さの `*` に見えます。コマンド出力もマスクの対象です。名前を登録しただけでは、通信先への認証ヘッダーやホスト実行の環境変数には入りません。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `secrets["name"].from` | — | `env:`、`file:`、`dotenv:`、`keyring:`、`lines:`、`cmd:` から取得する。値の直接記入は非対応。 |
| `secrets["name"].required` | `true` | 取得できなければ起動を中止。 |
| `mask` | `null` | 省略するとファイル表示とコマンド出力のマスクは無効。 |
| `mask.maskfs` | `true`（`MaskConfig` 内） | 作業フォルダーのファイル表示をマスクする。 |
| `mask.proxy` | `true`（`MaskConfig` 内） | プロキシ経由の URL、ヘッダー、ボディのマスクを有効にする。 |
| `mask.filter` | `true`（`MaskConfig` 内） | コマンドの stdout / stderr をマスクする。 |
| `mask.apply` | 全 `secrets`（`MaskConfig` 内） | maskfs と出力フィルターに使う名前を限定する。 |
| `mask.writePolicy` | `"readonly"`（`MaskConfig` 内） | マスク対象ファイルへの変更を拒否する。 |

`mask` を省略した場合、ファイル表示とコマンド出力のマスクは無効ですが、プロキシのマスクは既定で有効です。プロキシのマスクを無効にするには `mask.proxy = false` を指定し、ネットワーク側の秘密の扱いも変更する必要があります。

## ファイル表示と編集の制約

ファイルのマスクは別コピーの作成ではなく、読み取り時の表示変更です。Git 上では未変更のファイルも差分に見える場合があります。`mask.maskfs = false` で無効にすると、ファイル内の秘密値も見えるようになります。

既定の `writePolicy = "readonly"` はマスク対象ファイルの変更を拒否します。`"passthrough"` にすると、エージェントが表示された `*` を実ファイルへ書き戻して壊す場合があります。

## 取得元の制約

`lines:` はファイルの非空行をそれぞれ別の秘密値として扱うため、ヘッダー注入には使えません。

`cmd:` はホストで `sh -c` を実行し、標準出力の最初の行を秘密値にします。エージェントが変更できる文字列やスクリプトを使わないでください。

## 注意点

- `mask.proxy = false` にするなら、通信に適用される秘密値の扱いに `"mask"` または `"forbid"` を残せません。既定は `network.defaults.secrets["*"] = "mask"` なので、プロキシマスクを切る構成では `"ignore"` を明示する必要があります。
- プロキシにおける各秘密の扱いはネットワークの scope / ルール側で `"inject"`、`"mask"`、`"forbid"`、`"ignore"` を選びます。`mask.apply` はネットワーク用の選択ではありません。
- HostExec へ値を渡す例外は、該当ルールの `env { ["NAME"] = "secret:name" }` です。その値はそのホスト実行だけに注入されます。

## クラウド設定と GPG エージェント

`gcloud.mountConfig` や `aws.mountConfig` は認証設定ディレクトリを読み書き可能で共有します。エージェントは認証情報を読むだけでなくホストの認証・設定を変更・削除できます。必要なプロファイルだけで有効にしてください。`gpg.forwardAgent` は gpg-agent ソケットと関連設定を共有し、署名・復号を可能にします。

到達する認証情報の範囲は、[クラウド認証設定](/nix-agent-sandbox/security/risks/#cloud-config-mounts)と[GPG エージェント](/nix-agent-sandbox/security/risks/#gpg-agent)のリスクを確認してください。

## 関連ページ

- [ネットワーク制御](/nix-agent-sandbox/features/network/) — scope ごとの秘密値の扱いとヘッダー注入
- [HostExec](/nix-agent-sandbox/features/hostexec/) — ルールごとの環境変数注入
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `SecretConfig` と `MaskConfig` の全定義
