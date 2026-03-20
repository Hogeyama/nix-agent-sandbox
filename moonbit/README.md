# nas-moonbit

nas (Nix Agent Sandbox) の MoonBit 実装。言語探索目的の最小限CLI。

## 前提

- Nix (flakes 有効)
- Docker

## セットアップ

```bash
# MoonBit ツールチェーンのインストール + devShell 起動
nix develop .#moonbit

# 依存パッケージの取得（初回のみ）
cd moonbit
moon update
```

`moon update` は git を使うため、ホスト環境で実行すること（nas 内では hostexec の制約で失敗する場合がある）。

## ビルド

```bash
cd moonbit

# デバッグビルド
moon build --target native

# リリースビルド
moon build --target native --release

# 型チェックのみ
moon check --target native
```

生成バイナリ:
- デバッグ: `_build/native/debug/build/src/main/main.exe`
- リリース: `_build/native/release/build/src/main/main.exe`

## 実行

```bash
# devShell 内で moon run を使う
moon run --target native src/main

# プロファイル指定
moon run --target native src/main -- claude

# エージェントに追加引数を渡す
moon run --target native src/main -- claude -- --help

# ヘルプ
moon run --target native src/main -- --help

# ビルド済みバイナリを直接実行（devShell 内）
./_build/native/release/build/src/main/main.exe claude
```

## テスト

```bash
moon test --target native
```

## 実装済み機能

- `.agent-sandbox.nix` の読み込み（`nix eval --json` 経由）
- CLI 引数パース（プロファイル名、`--help`、`--version`、`--quiet`）
- パイプラインフレームワーク（Stage trait + run_pipeline）
- DockerBuildStage（イメージ存在チェック + ビルド）
- LaunchStage（docker run でコンテナ起動）
- Claude エージェント設定（~/.claude マウント、バイナリ解決）

## 未実装（スコープ外）

- YAML 設定サポート
- WorktreeStage / NixDetectStage / MountStage / DindStage / ProxyStage
- Copilot / Codex エージェント設定
- network / hostexec サブコマンド
- シグナルフォワーディング

## プロジェクト構造

```
moonbit/
  moon.mod.json                     # モジュール定義
  src/
    main/main.mbt                   # CLI エントリポイント
    config/types.mbt                # Config / Profile 型定義
    config/load.mbt                 # .nix 設定読み込み + JSON パース
    pipeline/context.mbt            # ExecutionContext
    pipeline/pipeline.mbt           # Stage trait + run_pipeline
    process/process.mbt             # サブプロセス実行 API
    process/process_native.mbt      # C FFI 宣言
    process/process_native.c        # popen / system ラッパー
    stages/docker_build.mbt         # DockerBuildStage
    stages/launch.mbt               # LaunchStage
    docker/client.mbt               # Docker CLI ラッパー
    agents/claude.mbt               # Claude Code 設定
```
