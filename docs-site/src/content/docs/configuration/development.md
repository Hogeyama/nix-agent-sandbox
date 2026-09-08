---
title: 開発ツールと Docker
description: Nix の開発環境・追加パッケージ、テスト用 Docker、イメージの再構築
---

エージェントに必要なツールがない場合は、プロジェクトの Nix 開発環境や追加パッケージを利用できます。テスト用コンテナや Compose が必要な場合は、セッション専用の Docker を有効にします。

[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)に必要な設定を追加し、再信頼して新しいセッションで確認します。GUI の画面が必要な場合は[GUI アプリの表示](/nix-agent-sandbox/configuration/gui/)を参照してください。

## Nix の開発環境

ホストに `/nix` があると Nix は自動で有効になり、プロジェクトの flake.nix にある既定の devShell を使えます。既定では Nix store、Nix daemon、関連キャッシュも共有します。ホストの Nix の状態にも操作が及ぶため、不要なプロファイルでは `nix.enable = false` を指定します。

flake の環境に加えて gh と jq を使う例です。

```pkl
nix = new NixConfig {
  enable = true
  mountSocket = true
  extraPackages = new Listing { "nixpkgs#gh"; "nixpkgs#jq" }
}
```

起動後、エージェントから追加したコマンドが使えることを確認します。既定の devShell がなければ、追加パッケージがある場合だけ nix shell を使い、両方なければ通常どおり起動します。

`nix.enable` の既定は auto です。true にしてもホストに /nix がなければ共有されず、nas が Nix を導入するわけではありません。`mountSocket = false` では Nix 用のマウントと実行環境設定を作りません。

## テスト用 Docker

ホストの Docker ソケットを渡す代わりに、セッション専用の daemon を補助コンテナで起動します。**daemon は rootless ですが、補助コンテナには privileged 権限が必要です。** エージェントのコンテナ自体にはその権限を渡しません。

```pkl
docker = new DockerConfig {
  enable = true
}
```

docker.enable の既定は false です。古い設定の `docker.shared = true` との併用はエラーなので削除します。

起動後、エージェント側で Docker を使えることを確認し、必要なイメージを取得してテストします。取得先は[外部への通信許可](/nix-agent-sandbox/configuration/network/)も必要です。拒否されると 403 Forbidden で取得に失敗します。

### データと取得キャッシュ

| 対象 | セッション終了後 |
| --- | --- |
| daemon、作成したイメージ・コンテナ・作業用ボリューム | 通常の終了処理で削除 |
| セッション専用 registry-mirror | 通常の終了処理で削除 |
| 公開 Docker Hub の取得キャッシュ nas-registry-cache | 次のセッションでも再利用 |

非公開レジストリのイメージや Docker の作業データは、セッション間で共有しません。キャッシュから取得した場合は新たな外部通信・承認がないので、承認の有無だけで取得イメージを確認しないでください。必要に応じてイメージの digest を固定します。

ミラーを起動できない場合は、同じセッションのプロキシを経由して直接取得します。終了処理で残ったコンテナは[作業後の片付け](/nix-agent-sandbox/work/finish/#未使用の補助コンテナ)で回収できます。取得キャッシュは nas container clean でも保持されます。

## nas のイメージ再構築

nas が使う既存の Docker イメージを削除して再ビルドする場合は、ホストで次を実行します。

```sh
nas rebuild
```

`nas rebuild --force` は参照中のコンテナがあってもイメージを強制削除する指定です。使う前に該当セッションを終了してください。セッションを停止するためのコマンドではありません。
