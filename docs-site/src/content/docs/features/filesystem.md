---
title: ファイル隔離・マウント
description: ワークスペースのマスク済みビューと追加マウントを安全に扱う
---

## どんな機能？

nas はワークスペースをコンテナへマウントして作業させます。秘密のマスクを有効にすると、元のワークスペースの代わりに FUSE によるマスク済みビューをマウントします。これは別コピーではなく、秘密値に一致したバイトを同じ長さの `*` の並びへ置き換えて見せるためのビューです。

`extraMounts` では、必要なホスト上のファイルやディレクトリだけを追加できます。依存キャッシュを読む、またはエージェントから `.env` を隠す、といった用途に使います。

ワークスペースは常に作業用にマウントされます。一方、追加マウントと gcloud / AWS の設定ディレクトリ、GPG agent socket は対応する設定とホスト側の存在条件を満たしたときだけマウントされます。nas が次回起動で読む `.nas/config.pkl` は、ワークスペース内でも読み取り専用で保護されます。

既存の `~/.config/git` は設定の有無を検出して自動で読み取り専用に mount されます。Nix が有効と解決され、`nix.mountSocket = true` かつ host Nix が検出された場合は、`/nix` と、`$XDG_CACHE_HOME`（未設定なら `~/.cache`）配下の `nas` / `nix` cache が読み書き可能に mount されます。後者は host の Nix state を変え得るため、Nix を使わない profile では有効にしません。

## いつ使う？

追加マウントは、コンテナ内に必要なものだけが既にある場合には不要です。ホストの設定、認証情報、ソースを広く `rw` で公開する前に、読み取り専用の単一ファイルまたは小さなディレクトリで足りないか確認してください。

## 主要な設定項目

| 設定 | 既定 | 用途 |
| --- | --- | --- |
| `extraMounts[].src` | — | ホスト側の元。絶対パス、`~`、または `workDir` 基準の相対パス。 |
| `extraMounts[].dst` | — | コンテナ側の先。相対パスはコンテナの作業ディレクトリ基準。 |
| `extraMounts[].mode` | `"ro"` | `"ro"` は読むだけ、`"rw"` はホスト側の実体へ書き込める。 |
| `mask.maskfs` | `true` | 名前付き秘密があるとき、マスク済みワークスペースビューを有効にする。 |
| `mask.writePolicy` | `"readonly"` | マスク対象ファイルへの書き込み、削除、名前変更を拒否する。 |

## 最小の設定例

profile の中に、読み取り専用のキャッシュと `.env` を隠すマウントを追加します。

```pkl
extraMounts {
  new { src = "~/.cache/my-tool"; dst = "~/.cache/my-tool"; mode = "ro" }
  new { src = "/dev/null"; dst = ".env"; mode = "ro" }
}
```

`dst = ".env"` は作業ディレクトリの `.env` を指します。存在しない `src` は警告してスキップされるため、必要な入力を見落とさないよう起動ログも確認してください。

## 注意点・セキュリティへの影響

- `rw` はコンテナ内のエージェントにホスト実体の変更を許します。キャッシュでも、実行ファイルや設定を含むなら後続のホスト実行へ影響し得ます。
- 選択した agent に対応する既存の `~/.claude` と `~/.claude.json`、`~/.codex`、または `~/.copilot` は、存在すると自動で読み書き可能な bind mount になります。これらには認証情報や session state があり得るため、信頼できないプロジェクトや agent を起動する前に内容と影響を確認してください。
- maskfs は秘密を読ませないための表示層です。マスクされた内容は Git の index と一致しなくなり、秘密をコミット済みのリポジトリでは常に dirty に見えることがあります。その場合は `mask.maskfs = false` を検討します。
- `writePolicy = "passthrough"` は、エージェントが読んだ `*` の並びを同じまま書き戻して実ファイルを壊す危険を受け入れます。通常は既定の `"readonly"` のままにします。
- コンテナ自身の書き込みはコンテナ layer にあり、session が終われば保持されません。対して writable bind mount の変更はホストに残ります。コンテナ内プロセスはホスト UID/GID に合わせて実行されるため、その mount への書き込みはホストユーザーの所有権・権限で永続します。
- `.nas/config.pkl` は nas が読み込む設定なので、ワークスペースが `rw` でも nas が読み取り専用で保護します。これに頼らず、HostExec が読むスクリプトや設定も `ro` に絞ってください。

追加 mount と自動 mount が広げる範囲は、[追加マウントのリスク](/nix-agent-sandbox/security/risks/#extra-mounts)と[Nix socket のリスク](/nix-agent-sandbox/security/risks/#nix-socket)を参照してください。

## 関連ページ

- [シークレット・認証情報](/nix-agent-sandbox/features/secrets/) — maskfs が使う名前付き秘密
- [HostExec](/nix-agent-sandbox/features/hostexec/) — ホスト実行に使うファイルを変更可能にしないための注意
- [Schema.pkl](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/src/config/Schema.pkl) — `ExtraMountConfig` と `MaskConfig` の全定義
