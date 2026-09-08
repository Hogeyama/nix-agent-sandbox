---
title: 開発ツールと Docker
description: direnv によるプロジェクト環境、Nix の共有、テスト用 Docker、イメージの再構築
---

エージェントに必要なツールは、プロジェクトの devShell や `.envrc` に定義し、direnv でセッションの起動時に読み込みます。テスト用コンテナや Compose も必要な場合は、セッション専用の Docker を有効にします。

## プロジェクトの開発環境

### 環境の定義

プロジェクトで使うツールを devShell や `.envrc` に定義します。flake の既定の devShell を使う場合は、プロジェクトの `.envrc` を次の内容にします。

```sh
# .envrc, when the project uses a flake devShell
use flake
```

必要なコマンドはプロジェクトの devShell に追加します。Nix を使わないプロジェクトでは、`.envrc` で PATH や環境変数を設定できます。

### direnv の有効化

[対象プロファイル](/nix-agent-sandbox/configuration/profiles/#プロファイルの編集)に次の設定を追加します。`direnv.enable` の既定は false なので、プロファイルごとに有効にします。

```pkl
direnv = new DirenvConfig {
  enable = true
}
```

設定の差分を確認し、[変更の反映と確認](/nix-agent-sandbox/configuration/profiles/#変更の反映と確認)の手順で `nas config trust` を実行します。これは nas の設定に対する信頼であり、次の `.envrc` の承認とは別です。

### ホストでの承認

ホストに direnv を導入し、実際に読み込む `.envrc` の絶対パスを承認します。

```sh
direnv allow /absolute/path/to/project/.envrc
nas
```

nas は `direnv allow` を実行しません。未承認、変更後、または拒否済みの `.envrc` が見つかった場合や、`.envrc` の評価に失敗した場合は、エージェントを起動せずにエラーを返します。`.envrc` が見つからない場合は、追加の環境を読み込まずに起動します。

ホストの direnv の承認データはコンテナへ読み取り専用で共有します。ホストの HOME や `direnvrc` は自動では共有しないため、独自の `direnvrc` 関数に依存する `.envrc` ではコンテナ内からもその定義を読めるように構成します。

nas が新しい worktree を作る場合、その worktree にある `.envrc` は元の作業フォルダーとは別のパスです。最初の起動が未承認エラーで止まったら、終了時に **2（Keep）** を選び、表示された `Worktree kept: <パス>` を残します。そのパスの `.envrc` をホストで `direnv allow` してからもう一度 nas を起動し、既存の worktree を再利用します。

### ツールの確認

新しいセッションで、devShell や `.envrc` に追加したコマンドを実行して確認します。起動中のセッションへの再接続では環境を読み直さないため、`.envrc` を変更して再承認した後も新しいセッションを起動します。

## Nix の共有

`.envrc` で `use flake` を使うには、コンテナから Nix を使える必要があります。`nix.enable` の既定は auto で、ホストに `/nix` があると Nix store、Nix daemon、関連キャッシュを共有します。ホストの Nix の状態にも操作が及ぶため、不要なプロファイルでは `nix.enable = false` を指定します。

`nix.enable = true` にしてもホストに `/nix` がなければ共有されず、nas が Nix を導入するわけではありません。`mountSocket = false` では Nix 用のマウントと実行環境設定を作りません。direnv の有効化と Nix の共有は別の設定です。

### 以前の Nix 設定からの移行

`nix.enable` だけでは、flake の devShell を自動で読み込まなくなりました。以前 `nix.extraPackages` に指定していたツールを削除して、プロジェクトの devShell または `.envrc` に定義します。

nas を更新した後、プロジェクトのルートで `nas config init` を実行して Schema.pkl を再生成します。対象プロファイルに `direnv.enable = true` を追加し、編集した設定を `nas config trust` で信頼し直してから、実際の `.envrc` をホストの `direnv allow` で承認します。

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
