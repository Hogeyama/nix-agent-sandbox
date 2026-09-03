---
title: Nix 統合
description: ホストの Nix daemon を使って sandbox 内の開発環境を用意する
---

## どんな機能？

Nix 統合は、agent コンテナからホストの Nix store と daemon を使い、プロジェクトの `flake.nix` の devShell や追加パッケージを利用できるようにします。Nix を使わないプロジェクトに必須の機能ではありません。

既定の `nix.enable = "auto"` は、ホストに `/nix` があるかだけを検出します。見つかれば有効、見つからなければ無効です。ホストに Nix があってもこの経路を使いたくなければ、`false` を明示します。

## いつ使う？

Nix flake の devShell で agent を動かす、または host Nix から `gh` などを一時的に加えたいときに使います。Nix が不要な profile、または agent に host の Nix daemon を委ねられない場合は `enable = false` にしてください。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `nix.enable` | `"auto"` | `/nix` の有無で有効化するか、`true` / `false` を明示する。 |
| `nix.mountSocket` | `true` | `/nix` を渡して host daemon を使う。`false` なら Nix 用の mount と runtime 設定を作らない。 |
| `nix.extraPackages` | 空 | `nix shell` で加え、続けて `nix develop` を起動するパッケージ。 |

## 最小の設定例

この profile では Nix を明示的に有効化し、flake の開発環境に加えて `gh` と `jq` を使います。

```pkl
nix = new NixConfig {
  enable = true
  mountSocket = true
  extraPackages = new Listing { "nixpkgs#gh"; "nixpkgs#jq" }
}
```

`flake.nix` に既定の devShell がなければ、extra package がある場合だけ `nix shell` を使います。extra package もない場合は agent を通常どおり起動します。

## 注意点・セキュリティへの影響

`mountSocket = true` は `/nix` を通じて host Nix daemon を使う高信頼の opt-in です。Nix store、daemon socket、nas の dev-environment cache と Nix cache がコンテナから利用可能になります。信頼していない agent や repository に必要がないなら、`enable = false` にします。

`enable = true` でも host に `/nix` がなければ mount は作られません。逆に auto detection は Nix をインストールする機能ではなく、host の状態を検出するだけです。

条件付き既定値も含めて、[Nix socket のリスク](/nix-agent-sandbox/security/risks/#nix-socket)を確認してください。

## 関連ページ

- [ファイル隔離・マウント](/nix-agent-sandbox/features/filesystem/) — host のパスを渡すときの基本
- [設定の基本](/nix-agent-sandbox/getting-started/configuration/) — profile を安全に変更して信頼する手順
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `NixConfig` の全定義
