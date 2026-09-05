---
title: Nix 統合
description: Nix の開発環境と追加パッケージ
---

プロジェクトの `flake.nix` にある devShell や、Nix パッケージをエージェントの実行環境で利用できます。ホストに `/nix` があると自動で有効になり、既定では Nix store、Nix daemon、関連キャッシュを共有します。不要な場合は `nix.enable = false` を指定してください。

## 設定例

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。

このプロファイルでは Nix を明示的に有効化し、flake の開発環境に加えて `gh` と `jq` を使います。

```pkl
nix = new NixConfig {
  enable = true
  mountSocket = true
  extraPackages = new Listing { "nixpkgs#gh"; "nixpkgs#jq" }
}
```

`flake.nix` に既定の devShell がなければ、追加パッケージがある場合だけ `nix shell` を使います。追加パッケージもない場合はエージェントを通常どおり起動します。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `nix.enable` | `"auto"` | `/nix` の有無で有効化するか、`true` / `false` を明示する。 |
| `nix.mountSocket` | `true` | `/nix` を渡してホスト daemon を使う。`false` なら Nix 用のマウントと実行環境設定を作らない。 |
| `nix.extraPackages` | 空 | `nix shell` で加え、続けて `nix develop` を起動するパッケージ。 |

## 注意点

`mountSocket = true` では、ホストの `/nix` と Nix daemon、Nix / nas のキャッシュを利用できます。エージェントの操作がホストの Nix の状態にも影響するため、不要なプロファイルでは `enable = false` を指定してください。

`enable = true` でもホストに `/nix` がなければマウントしません。nas が Nix をインストールするわけではありません。詳細は [Nix のリスク](/nix-agent-sandbox/security/risks/#nix-socket)を参照してください。

## 関連ページ

- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) — ホストのパスを渡すときの基本
- [設定の基本](/nix-agent-sandbox/getting-started/configuration/) — プロファイルを安全に変更して信頼する手順
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `NixConfig` の全定義
