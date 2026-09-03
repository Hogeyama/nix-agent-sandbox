# nas — Nix Agent Sandbox

`nas` は、AI コーディングエージェントを Docker サンドボックス内で実行する Linux 向け CLI です。
Claude Code、GitHub Copilot CLI、OpenAI Codex CLI の公式スタンドアロンバイナリを使えます。

ワークスペースと選択したエージェントの既存 state / 認証 directory は、既定で読み書き可能に
mount されます。既存の `~/.config/git` は読み取り専用です。

Nix の自動検出は `/nix`、daemon socket、Nix cache を読み書き可能に mount できます。
不要な profile では `nix.enable = false` を明示してください。

ネットワーク、`extraMounts`、HostExec は policy-controlled な capability です。許可を広げる前に
[信頼境界](https://hogeyama.github.io/nix-agent-sandbox/security/model/)を確認してください。

## ユーザーガイド

詳細な設定、機能、レシピ、運用とセキュリティの情報は
[nas ユーザーガイド](https://hogeyama.github.io/nix-agent-sandbox/)を参照してください。

最初に使う場合は、次の順で進めます。

1. [インストール](https://hogeyama.github.io/nix-agent-sandbox/getting-started/installation/)
2. [設定を作る](https://hogeyama.github.io/nix-agent-sandbox/getting-started/configuration/)
3. [サンドボックスを起動する](https://hogeyama.github.io/nix-agent-sandbox/getting-started/quick-start/)

## 前提条件

- Linux
- Docker 20.10 以降
- 使用するエージェントの公式スタンドアロンバイナリ

npm 版ではなく、Claude Code、GitHub Copilot CLI、または OpenAI Codex CLI の
公式配布バイナリを導入してください。

GitHub Releases の導入例には GitHub CLI (`gh`) と、`PATH` に含まれる
`~/.local/bin` が必要です。

## インストール

### GitHub Releases

ビルド済みバイナリは x86_64-linux と aarch64-linux 向けに公開しています。
aarch64-linux は動作未確認です。

```sh
# x86_64-linux
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
nas
```

```sh
# aarch64-linux
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_aarch64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
nas
```

### Nix

Nix が使える環境では、リポジトリから直接 profile に追加できます。

```sh
nix profile install github:Hogeyama/nix-agent-sandbox
```

## 最小のクイックスタート

作業するリポジトリのルートで設定を生成します。

```sh
cd /path/to/your-project
nas config init
```

`nas config init` は `.nas/` とユーザー共通設定を作成します。最小の独立した
profile にする場合は、`.nas/config.pkl` を次の内容にします。

```pkl
amends "Schema.pkl"

default = "claude"

profiles {
  ["claude"] { agent = "claude" }
}
```

設定を確認してから、プロジェクトのルートで起動します。

```sh
nas
```

別の profile を使うときは名前を指定します。

```sh
nas claude
```

追加のネットワーク、マウント、HostExec は隔離境界を変えます。追加前に
[設定の基本](https://hogeyama.github.io/nix-agent-sandbox/getting-started/configuration/)と
[信頼境界](https://hogeyama.github.io/nix-agent-sandbox/security/model/)を確認してください。

## 主な機能

- [ファイル隔離・マウント](https://hogeyama.github.io/nix-agent-sandbox/features/filesystem/)
- [ネットワーク制御](https://hogeyama.github.io/nix-agent-sandbox/features/network/)
- [localhost ポート転送](https://hogeyama.github.io/nix-agent-sandbox/features/port-forwarding/)
- [HostExec](https://hogeyama.github.io/nix-agent-sandbox/features/hostexec/)
- [シークレット・認証情報](https://hogeyama.github.io/nix-agent-sandbox/features/secrets/)
- [Nix 統合](https://hogeyama.github.io/nix-agent-sandbox/features/nix/)
- [Docker in Docker](https://hogeyama.github.io/nix-agent-sandbox/features/docker/)
- [Worktree](https://hogeyama.github.io/nix-agent-sandbox/features/worktree/)
- [セッション・通知](https://hogeyama.github.io/nix-agent-sandbox/features/sessions/)
- [X11 / xpra](https://hogeyama.github.io/nix-agent-sandbox/features/display/)
- [UI daemon](https://hogeyama.github.io/nix-agent-sandbox/features/ui/)
- [Observability](https://hogeyama.github.io/nix-agent-sandbox/features/observability/)

日常の操作は[運用ガイド](https://hogeyama.github.io/nix-agent-sandbox/operations/maintenance/)を、
よく使う構成は[レシピ](https://hogeyama.github.io/nix-agent-sandbox/recipes/mask-env/)を参照してください。

## ライセンスと着想

nas は [MIT License](LICENSE) で提供されます。

設計は [agent-workspace](https://github.com/hiragram/agent-workspace) に着想を得ています。
