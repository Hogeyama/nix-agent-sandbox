---
title: 概要
description: nas が何をするツールなのか
---

**nas** (Nix Agent Sandbox) は Bun 製の CLI ツールです。AI コーディングエージェント（Claude Code / GitHub Copilot CLI / OpenAI Codex CLI）を、ホストから隔離された Docker サンドボックスの中で動かします。

起動した時点ではファイルシステムもネットワークもホストから切り離されており、エージェントが触れてよいものは設定で 1 つずつ opt-in して穴を開けていく、という考え方で作られています。**「まず全部塞ぐ。必要な分だけ開ける」が一貫した方針です。**

[agent-workspace](https://github.com/hiragram/agent-workspace) にインスパイアされました。

:::note[名前について]
当初は Nix 統合を主目的として *nix-agent-sandbox* と命名しました。
その後、ネットワーク制御・コマンド移譲・Worktree 管理など様々な機能が追加された結果、
Nix 統合は数ある機能のひとつに過ぎなくなっています。
この機能が不要な場合は、実行環境に Nix がインストールされている必要もありません。
:::

## ドキュメントの構成

- **はじめに** — [インストール](/nix-agent-sandbox/install/)・[クイックスタート](/nix-agent-sandbox/quickstart/)
- **[機能ガイド](/nix-agent-sandbox/guide/nix/)** — opt-in できる主な機能をひととおり紹介します
- **設定** — [設定ファイル](/nix-agent-sandbox/config/file/)の構造と、[設定パターン](/nix-agent-sandbox/config/patterns/)（実運用で頻出するレシピ集）
- **運用** — [運用コマンド](/nix-agent-sandbox/operations/commands/)・[UI daemon](/nix-agent-sandbox/operations/ui/)
- **[セキュリティについて](/nix-agent-sandbox/security/)** — 各機能のリスクと信頼境界
