---
title: シークレット・認証情報
description: 名前付き秘密の解決、マスク、限定的な注入を設定する
---

## どんな機能？

`secrets` は秘密の取得元を名前で登録するレジストリです。設定ファイルに値そのものは書きません。解決はホスト側で行われ、レジストリの生値はエージェントコンテナへファイルとしてマウントされません。表示・送信・出力をマスクするには、profile に `mask` を明示して有効にします。

## いつ使う？

ワークスペースにあるトークンを隠す、HTTP リクエストへ認証ヘッダーを加える、または特定の HostExec ルールだけに環境変数を渡すときに使います。コンテナの通常の `env` は別の明示的な環境変数設定であり、秘密レジストリの代わりではありません。値を直接 `env` に置けば、その値をコンテナへ渡すことになります。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `secrets["name"].from` | — | `env:`、`file:`、`dotenv:`、`keyring:`、`lines:`、`cmd:` から取得する。リテラル値は非対応。`cmd:` は host で payload を実行する。 |
| `secrets["name"].required` | `true` | 解決できないとき起動を失敗させる。 |
| `mask` | `null` | profile で省略すると maskfs / filter stage は動かない。 |
| `mask.maskfs` | `true`（`MaskConfig` 内） | ワークスペースのファイル表示をマスクする。 |
| `mask.proxy` | `true`（`MaskConfig` 内） | proxy 経由の URL、ヘッダー、ボディのマスクを有効にする。 |
| `mask.filter` | `true`（`MaskConfig` 内） | コマンドの stdout / stderr をマスクする。 |
| `mask.apply` | 全 `secrets`（`MaskConfig` 内） | maskfs と出力フィルターに使う名前を限定する。 |
| `mask.writePolicy` | `"readonly"`（`MaskConfig` 内） | マスク対象ファイルへの変更を拒否する。 |

`profile.mask = null` は層ごとに同じ意味ではありません。maskfs と stdout / stderr filter は stage ごと skip しますが、network proxy の masking は `mask?.proxy !== false` のため既定で有効のままです。proxy masking を明示的に切るのは `mask = new MaskConfig { proxy = false }` です。

## 最小の設定例

`.env` の値を名前付き秘密として登録し、ワークスペース表示とコマンド出力で隠します。

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

`lines:` はファイルの非空行をそれぞれ別の値として扱います。複数値へ展開されるため、ヘッダーなどへの注入には使えません。`required = true` の秘密を解決できない場合、nas はマスクなしで続行せず起動を止めます。

`cmd:` は trusted config に書かれた payload を host 側で `sh -c` として実行し、stdout の最初の行だけを秘密として使います。設定を信頼することは、この host command を信頼することでもあります。短い helper のためだけに使い、agent や repository が変更できる文字列を組み込まないでください。[repository を信頼する境界](/nix-agent-sandbox/security/model/#repository-trust)で、この host-command capability を許す trust gate も確認してください。

## 注意点・セキュリティへの影響

- `mask.proxy = false` にするなら、ネットワークの有効な秘密 disposition に `"mask"` または `"forbid"` を残せません。既定は `network.defaults.secrets["*"] = "mask"` なので、proxy マスクを切る構成では `"ignore"` を明示する必要があります。
- proxy における各秘密の扱いはネットワークの scope / rule 側で `"inject"`、`"mask"`、`"forbid"`、`"ignore"` を選びます。`mask.apply` はネットワーク用の選択ではありません。
- HostExec へ値を渡す例外は、該当ルールの `env { ["NAME"] = "secret:name" }` です。その値はそのホスト実行だけに注入されます。

## クラウド設定と GPG agent

`gcloud.mountConfig` や `aws.mountConfig` は認証設定ディレクトリを read/write でコンテナへマウントする高リスクな選択です。agent は credential を読むだけでなく host の認証・設定を変更・削除できます。必要な profile だけで有効にしてください。`gpg.forwardAgent` も agent socket と関連設定を渡すため、署名・復号を許す高リスクな設定です。

到達する credential の範囲は、[cloud config mounts](/nix-agent-sandbox/security/risks/#cloud-config-mounts)と[GPG agent](/nix-agent-sandbox/security/risks/#gpg-agent)のリスクを確認してください。

## 関連ページ

- [ネットワーク制御](/nix-agent-sandbox/features/network/) — scope ごとの disposition とヘッダー注入
- [HostExec](/nix-agent-sandbox/features/hostexec/) — rule-scoped な秘密環境変数
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `SecretConfig` と `MaskConfig` の全定義
