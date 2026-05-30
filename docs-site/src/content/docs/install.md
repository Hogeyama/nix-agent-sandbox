---
title: インストール
description: 前提条件と nas のインストール手順
---

## 前提条件

- Linux
- **エージェントバイナリ** — スタンドアロンバイナリとしてインストール済みであること（npm 版は不可。詳細は[制約・注意事項](/nix-agent-sandbox/reference/limitations/#エージェントバイナリ)を参照）
- **Docker** (20.10+)

### エージェントのインストール

エージェントは **npm ではなく、公式のスタンドアロンバイナリ** をインストールしてください。

**Claude Code:**

```sh
# 公式インストーラー
curl -fsSL https://claude.ai/install.sh | bash
```

**GitHub Copilot CLI:**

公式のインストール手順に従ってスタンドアロンバイナリを導入してください。

**OpenAI Codex CLI:**

[Releases · openai/codex](https://github.com/openai/codex/releases) からインストールしてください。

## GitHub Releases からインストール

ビルド済みバイナリを GitHub Releases から取得できます。
x86_64-linux と aarch64-linux を用意していますが、aarch64 は動作未確認です。

```sh
# x86_64-linux
gh release download --repo Hogeyama/nix-agent-sandbox --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
nas

# aarch64-linux
gh release download --repo Hogeyama/nix-agent-sandbox --pattern 'nas-*_aarch64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
nas
```

このバイナリは [nix-bundle-elf](https://github.com/Hogeyama/nix-bundle-elf) を使ってビルドされています。
これは実行するたびに自己解凍を行うため、起動に少し時間がかかります。気になる場合は `--extract` オプションで一度展開すると高速化できます。

```sh
gh release download --repo Hogeyama/nix-agent-sandbox --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C /tmp/
/tmp/nas --extract /opt/nas
ln -s /opt/nas/bin/nas ~/.local/bin/
```

## ローカルでビルドしてインストール

Nix が使える環境なら、リポジトリから直接インストールもできます。

```sh
nix profile install github:Hogeyama/nix-agent-sandbox
```
