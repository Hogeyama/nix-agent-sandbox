# nas — Nix Agent Sandbox

Docker + Nix で AI エージェント（Claude Code / GitHub Copilot CLI）の隔離された作業環境を起動する CLI ツール。
[agent-workspace](https://github.com/hiragram/agent-workspace) にインスパイアされ、自分用に再設計したもの。

## 前提条件

- **Docker** (20.10+)
- **Deno** (2.x) — ビルドに必要
- **エージェントバイナリ** — ホスト側にスタンドアロンバイナリとしてインストール済みであること

### エージェントのインストール（重要）

エージェントは **npm ではなく、公式のスタンドアロンバイナリ** をインストールしてください。
（npm 版は Node.js + node\_modules ツリー全体が必要になり、コンテナ内へのマウントが困難なため）

**Claude Code:**

```sh
# 公式インストーラー（推奨）
curl -fsSL https://claude.ai/install.sh | bash
```

**GitHub Copilot CLI:**

```sh
# 公式インストーラー（推奨）
curl -fsSL https://copilot.github.com/install.sh | bash
```

いずれも `~/.local/bin/` 等にシングルバイナリが配置されます。`which claude` / `which copilot` でパスが解決できれば OK です。

## セットアップ

```sh
deno task compile    # ./nas バイナリが生成される

# PATH の通った場所に配置
cp nas ~/.local/bin/
```

## 使い方

### 基本

```sh
# リポジトリのルートで実行（.agent-sandbox.yml がある場所）
cd /path/to/your-project
nas                  # デフォルトプロファイルでインタラクティブ起動
nas copilot-nix      # プロファイル指定
```

### エージェントに引数を渡す

`--` の後にエージェント固有の引数を渡せます。

```sh
# 非インタラクティブ（スクリプティング）
nas -- -p "このリポジトリの概要を教えて"

# Copilot CLI で全権限付与（サンドボックス内なので安全）
nas -- -p "テストを書いて" --yolo
```

## 設定ファイル

プロジェクトルートに `.agent-sandbox.yml` を配置します。カレントディレクトリから上位に向かって自動検索されます。

```yaml
# .agent-sandbox.yml
default: copilot-nix

profiles:
  copilot-nix:
    agent: copilot          # "claude" | "copilot"
    nix:
      enable: auto          # true | false | "auto"（flake.nix の有無で判定）
      mount-host-store: true  # ホストの /nix/store をマウント（nix develop 用）
    docker:
      mount-socket: false   # ホストの docker.sock をマウント
    env:                    # コンテナに渡す追加環境変数
      SOME_VAR: value

  claude-nix:
    agent: claude
    worktree:               # git worktree で隔離ブランチを作成
      base: origin/main
      on-create: "npm install"
    nix:
      enable: auto
      mount-host-store: true
    docker:
      mount-socket: false
```

### プロファイル設定リファレンス

| キー | 型 | デフォルト | 説明 |
|------|------|-----------|------|
| `agent` | `"claude"` \| `"copilot"` | （必須） | 使用するエージェント |
| `worktree.base` | string | `"origin/main"` | worktree のベースブランチ |
| `worktree.on-create` | string | `""` | worktree 作成後に実行するコマンド |
| `nix.enable` | bool \| `"auto"` | `"auto"` | Nix 統合。`auto` は `flake.nix` で判定 |
| `nix.mount-host-store` | bool | `true` | ホストの `/nix/store` をマウント |
| `nix.extra-packages` | string[] | `[]` | 追加 Nix パッケージ |
| `docker.mount-socket` | bool | `false` | Docker socket をマウント |
| `env` | map | `{}` | 追加環境変数 |

## 仕組み

### パイプライン

```
nas [profile-name] [-- agent-args...]
  │
  ├─ WorktreeStage     git worktree 作成（設定時のみ）
  ├─ DockerBuildStage  Docker イメージのビルド（キャッシュあり）
  ├─ NixDetectStage    flake.nix の有無を検出
  ├─ MountStage        マウント構成の組み立て
  └─ LaunchStage       コンテナ起動 → エージェント実行
```

### コンテナの中身

- **ベースイメージ**: `nixos/nix:latest`
- **プリインストール**: git, curl, cacert, bash, fuse-overlayfs, docker-client
- **標準ライブラリ**: glibc, libstdc++ を `/usr/local/lib` にシンボリックリンク（スタンドアロン ELF バイナリ用）
- **エージェントバイナリ**: ホストからバインドマウント（`/usr/local/bin/` に配置）

### 認証の引き継ぎ

| エージェント | 方法 |
|-------------|------|
| Claude Code | `~/.claude/` をマウント |
| Copilot CLI | `~/.config/.copilot/` をマウント + `GITHUB_TOKEN` を環境変数で渡す |

### Nix 統合（`nix.enable: true` 時）

プロジェクトに `flake.nix` がある場合、コンテナ内で `nix develop` を経由してエージェントを起動します。ホストの `/nix/store` を fuse-overlayfs で overlay マウントし、ホストのビルドキャッシュを活用しつつコンテナ内でも `nix build` が可能です。

## 制約・注意事項

### エージェントバイナリ

- **npm でインストールされたエージェントは動作しません。** npm 版は `node_modules/` ツリー全体に依存するため、単一ファイルのバインドマウントでは起動できません。必ず公式のスタンドアロンインストーラーを使ってください。
- エージェントバイナリは ELF 形式（Linux x86\_64）であることが前提です。

### ファイル所有権

- コンテナ内のエージェントプロセスは、ホストユーザーと同じ UID/GID で実行されます。作成・変更されたファイルはホストユーザー所有になります。
- entrypoint は root で起動し（overlay セットアップ等）、エージェント起動前にホスト UID にドロップします。

### TTY

- インタラクティブモード（引数なしでエージェントを起動）には TTY が必要です。
- CI/スクリプトなど非 TTY 環境では `-- -p "プロンプト"` で非インタラクティブモードを使用してください。

### Copilot CLI のパーミッション

- Copilot CLI は非インタラクティブモード（`-p`）でシェルコマンドの実行に許可を求めます。
- サンドボックス内で全操作を許可する場合は `--yolo` を渡してください: `nas -- -p "..." --yolo`

### Docker

- Docker socket マウント（`docker.mount-socket: true`）を有効にすると、コンテナからホストの Docker を操作できてしまいます。必要な場合のみ有効にしてください。

### Nix固有

- ホストの `/nix/store` が大きい場合（数十万エントリ）、Nix overlay 有効時の初回 Docker ビルドに時間がかかります（コンテナの store バックアップのため）。2回目以降はキャッシュが効きます。
- fuse-overlayfs は `--device /dev/fuse` と `--cap-add SYS_ADMIN` を使用します（`--privileged` は不要）。

## 開発

```sh
deno task dev         # 開発実行
deno task test        # テスト
deno task lint        # リント
deno task fmt         # フォーマット
deno task check       # 型チェック
deno task compile     # バイナリビルド
```

## ディレクトリ構成

```
.
├── deno.json
├── main.ts
├── src/
│   ├── cli.ts              # CLI エントリポイント
│   ├── config/
│   │   ├── types.ts        # 型定義
│   │   ├── load.ts         # YAML 読み込み
│   │   └── validate.ts     # バリデーション
│   ├── pipeline/
│   │   ├── context.ts      # ExecutionContext
│   │   └── pipeline.ts     # Stage インターフェース & 実行
│   ├── stages/
│   │   ├── worktree.ts     # git worktree 作成
│   │   ├── nix_detect.ts   # flake.nix 検出
│   │   ├── mount.ts        # マウント構成の組み立て
│   │   └── launch.ts       # Docker ビルド & コンテナ起動
│   ├── docker/
│   │   ├── client.ts       # Docker CLI ラッパー
│   │   └── embed/
│   │       ├── Dockerfile
│   │       └── entrypoint.sh
│   └── agents/
│       ├── claude.ts       # Claude Code 固有設定
│       └── copilot.ts      # Copilot CLI 固有設定
└── tests/
    ├── config_test.ts
    └── pipeline_test.ts
```
