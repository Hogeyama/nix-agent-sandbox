---
title: ファイル隔離・マウント
description: ファイルの追加共有、読み書き権限、秘密値のマスク
---

ホストのファイルを追加で共有するには `extraMounts` を使います。読み取り専用のキャッシュの共有や、`.env` を空のファイルで覆ってエージェントから隠す用途があります。

作業フォルダーは既定で読み書き可能です。変更はホストに残ります。

## ファイルの追加共有

[対象プロファイル](/nix-agent-sandbox/getting-started/configuration/#プロファイルの編集)に追加します。次は、ホストのキャッシュをコンテナから読み取るための設定です。

```pkl
extraMounts {
  new { src = "~/.cache/my-tool"; dst = "~/.cache/my-tool"; mode = "ro" }
}
```

`src` は実際に使うキャッシュのパスに置き換えます。書き込みも任せる場合だけ `mode = "rw"` に変更してください。

## ファイルの非公開

作業フォルダーの `.env` を空のファイルとして見せる例です。同じプロファイルの `extraMounts` に追加します。

```pkl
extraMounts {
  new { src = "/dev/null"; dst = ".env"; mode = "ro" }
}
```

`dst = ".env"` は作業ディレクトリの `.env` を指します。存在しない `src` は警告してスキップされるため、必要な入力を見落とさないよう起動ログも確認してください。

## 設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `extraMounts[].src` | — | ホスト側の共有元。絶対パス、`~`、または `workDir` 基準の相対パス。 |
| `extraMounts[].dst` | — | コンテナ側の共有先。相対パスはコンテナの作業ディレクトリ基準。 |
| `extraMounts[].mode` | `"ro"` | `"ro"` は読むだけ、`"rw"` はホスト側の実体へ書き込める。 |

## 注意点

- `rw` の変更はホストに残ります。実行ファイルや設定を含むキャッシュでは、後のホスト実行にも影響します。
- `.nas/config.pkl` は読み取り専用で保護されます。HostExec が読む他のスクリプト・設定は、必要に応じて自分で読み取り専用にしてください。

マスクの設定は[シークレット・認証情報](/nix-agent-sandbox/features/secrets/)、追加共有の権限は[機能別リスク](/nix-agent-sandbox/security/risks/#extra-mounts)を参照してください。

## 関連ページ

- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) — maskfs が使う名前付き秘密
- [HostExec](/nix-agent-sandbox/features/hostexec/) — ホスト実行に使うファイルを変更可能にしないための注意
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `ExtraMountConfig` と `MaskConfig` の全定義
