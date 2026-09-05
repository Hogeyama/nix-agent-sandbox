---
title: インストール
description: 対応環境、前提ツール、GitHub Releases と Nix からの導入
---

## 前提条件

- Linux
- 使用するエージェントのスタンドアロンバイナリ。npm 版ではなく、Claude Code、GitHub Copilot CLI、または OpenAI Codex CLI の公式配布バイナリを導入してください。
- Docker 20.10 以降。nas を実行するユーザーで `docker info` が成功すること。

以下の GitHub Releases の例では、GitHub CLI (`gh`) と `~/.local/bin` が `PATH` に含まれていることも必要です。

## GitHub Releases

ビルド済みバイナリは x86_64-linux と aarch64-linux 向けに公開しています。aarch64-linux は現在も動作未確認です。

`~/.local/bin` がなければ、先に `mkdir -p ~/.local/bin` で作成してください。

```sh
# x86_64-linux
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
```

```sh
# aarch64-linux
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_aarch64-linux.tar.gz' -O - | tar xz -C ~/.local/bin
```

## Nix

Nix が使える環境では、リポジトリから直接プロファイルに追加できます。

```sh
nix profile install github:Hogeyama/nix-agent-sandbox
```

## 導入の確認

`nas --version` でバージョンが表示されれば導入完了です。[クイックスタート](../quick-start/)で最初のセッションを起動します。

## 起動時間の短縮

配布バイナリは `nix-bundle-elf` により実行時に自己展開するため、最初の起動には少し時間がかかります。頻繁に起動する環境では、`--extract` で一度展開できます。

```sh
gh release download --repo Hogeyama/nix-agent-sandbox \
  --pattern 'nas-*_x86_64-linux.tar.gz' -O - | tar xz -C /tmp/
mkdir -p ~/.local/lib ~/.local/bin
/tmp/nas --extract ~/.local/lib/nas
```

以後は `~/.local/lib/nas/bin/nas` で起動できます。通常の `nas` コマンドとして使う場合は、既存の `~/.local/bin/nas` を確認してから、この実行ファイルへのシンボリックリンクに置き換えてください。
