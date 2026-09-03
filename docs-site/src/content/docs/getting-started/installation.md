---
title: インストール
description: 対応環境、前提ツール、GitHub Releases と Nix からの導入
---

## 前提条件

- Linux
- 使用するエージェントのスタンドアロンバイナリ。npm 版ではなく、Claude Code、GitHub Copilot CLI、または OpenAI Codex CLI の公式配布バイナリを導入してください。
- Docker 20.10 以降

以下の GitHub Releases の例では、GitHub CLI (`gh`) と `~/.local/bin` が `PATH` に含まれていることも必要です。

## GitHub Releases から導入する

ビルド済みバイナリは x86_64-linux と aarch64-linux 向けに公開しています。aarch64-linux は現在も動作未確認です。

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

配布バイナリは `nix-bundle-elf` により実行時に自己展開するため、最初の起動には少し時間がかかります。頻繁に起動する環境では、`--extract` で一度展開できます。

```sh
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C /tmp/
/tmp/nas --extract /opt/nas
ln -s /opt/nas/bin/nas ~/.local/bin/
```

## Nix から導入する

Nix が使える環境では、リポジトリから直接 profile に追加できます。

```sh
nix profile install github:Hogeyama/nix-agent-sandbox
```

導入後は [クイックスタート](../quick-start/) に進んでください。
