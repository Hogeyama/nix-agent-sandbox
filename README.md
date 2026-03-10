# nas — Nix Agent Sandbox

Docker + Nix で AI エージェント（Claude Code / GitHub Copilot CLI）の隔離された作業環境を起動する CLI ツール。
[agent-workspace](https://github.com/hiragram/agent-workspace) にインスパイアされ、自分用に再設計したもの。

## 前提条件

- **Docker** (20.10+)
- **Deno** (2.x) — ビルドに必要
- **Nix** (multi-user インストール、nix-daemon 動作中) — `nix.enable` 使用時
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

### Docker イメージの再ビルド

Docker イメージを強制的に再ビルドしたい場合（Dockerfile を変更した後など）は `rebuild` サブコマンドを使います。

```sh
nas rebuild              # デフォルトプロファイルで再ビルドして起動
nas rebuild copilot-nix  # プロファイル指定
```

### Worktree 管理

`worktree` が設定されたプロファイルで `nas` を実行すると、ベースブランチから `nas/{profile}/{timestamp}` ブランチ付きの git worktree が自動作成されます。エージェント終了後は `cleanup` 設定に応じて自動削除されます。

溜まった worktree を手動で管理するには `worktree` サブコマンドを使います。

```sh
nas worktree list            # nas が作成した worktree を一覧表示
nas worktree clean           # すべて削除（確認プロンプトあり）
nas worktree clean --force   # 確認なしで削除
```

既存のイメージを削除してから再ビルドし、そのまま起動します。

`nas` のバージョンアップにより内蔵の Dockerfile/entrypoint が更新された場合、起動時に自動検知して `nas rebuild` の実行を促すメッセージが表示されます。

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

### グローバル設定

`~/.config/nas/agent-sandbox.yml` にグローバル設定を配置できます。ローカル（プロジェクト側）の設定とマージされ、同名プロファイルではローカルが優先されます。共通の環境変数やツール設定を一箇所にまとめたい場合に便利です。

```yaml
# .agent-sandbox.yml
default: copilot-nix

profiles:
  copilot-nix:
    agent: copilot          # "claude" | "copilot"
    nix:
      enable: auto          # true | false | "auto"（flake.nix の有無で判定）
      mount-socket: true    # ホストの nix daemon ソケット経由で nix を使用
    docker:
      mount-socket: false   # ホストの docker.sock をマウント
    gpg:
      forward-agent: true   # ホストの gpg-agent を転送（署名用）
    extra-mounts:           # 任意の追加マウント
      - src: ~/.cabal
        dst: ~/.cabal
        mode: ro            # "ro" | "rw"（省略時は "ro"）
    env:                    # 追加環境変数（固定値 or コマンド出力）
      - key: SOME_VAR
        val: value
      - key_cmd: "cat /path/to/key"
        val_cmd: "cat /path/to/value"

  claude-nix:
    agent: claude
    worktree:               # git worktree で隔離ブランチを作成
      base: origin/main
      on-create: "npm install"
      cleanup: auto         # "force" | "auto" | "keep"
    nix:
      enable: auto
      mount-socket: true
    docker:
      mount-socket: false
```

### プロファイル設定リファレンス

| キー | 型 | デフォルト | 説明 |
|------|------|-----------|------|
| `agent` | `"claude"` \| `"copilot"` | （必須） | 使用するエージェント |
| `worktree.base` | string | `"origin/main"` | worktree のベースブランチ |
| `worktree.on-create` | string | `""` | worktree 作成後に実行するコマンド |
| `worktree.cleanup` | `"force"` \| `"auto"` \| `"keep"` | `"auto"` | エージェント終了後の worktree 処理。`force`: 常に削除、`auto`: 未コミット変更がなければ削除、`keep`: 常に残す |
| `nix.enable` | bool \| `"auto"` | `"auto"` | Nix 統合。`auto` は `flake.nix` で判定 |
| `nix.mount-socket` | bool | `true` | ホストの nix daemon にソケット経由で接続 |
| `nix.extra-packages` | string[] | `[]` | `nix shell` で追加するパッケージ（`nix develop` 前に適用） |
| `docker.mount-socket` | bool | `false` | Docker socket をマウント |
| `gcloud.mount-config` | bool | `false` | gcloud 設定ディレクトリ（`~/.config/gcloud`）をマウント |
| `aws.mount-config` | bool | `false` | AWS 設定ディレクトリ（`~/.aws`）をマウント |
| `gpg.forward-agent` | bool | `false` | ホストの gpg-agent を転送（ソケット・公開鍵リング・信頼DB・設定ファイルをマウント） |
| `extra-mounts` | list | `[]` | 追加マウント。`[{ src, dst, mode? }]`（`mode` は `"ro"`/`"rw"`、省略時 `"ro"`） |
| `env` | list | `[]` | `[{ key, val }]` または `[{ key_cmd, val_cmd }]` 形式で環境変数を追加 |

`extra-mounts` の `src` が存在しない場合、そのエントリは警告を出してスキップされます。

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

- **ベースイメージ**: `ubuntu:24.04`
- **プリインストール**: git, curl, bash, ca-certificates, docker CLI, docker compose plugin, gh, ripgrep, fd, Python 3（`python`/`python3`）, Node.js, Google Cloud CLI（`gcloud`）, AWS CLI v2（`aws`）
- **エージェントバイナリ**: ホストからバインドマウント（`/usr/local/bin/` に配置）

### 認証の引き継ぎ

| エージェント | 方法 |
|-------------|------|
| Claude Code | `~/.claude/` をマウント |
| Copilot CLI | `~/.config/.copilot/` をマウント + `GITHUB_TOKEN` を環境変数で渡す |

### Nix 統合（`nix.enable: true` 時）

Docker の DooD（Docker outside of Docker）と同じパターンで、ホストの nix daemon にソケット経由で接続します。
プロジェクトに `flake.nix` がある場合、コンテナ内で `nix develop` を経由してエージェントを起動します。ホストの `/nix` をマウントし、`NIX_REMOTE=daemon` でホストの nix daemon を利用します。コンテナ内に nix をインストールする必要はありません。
`nix.extra-packages` が設定されている場合は `nix shell` を挟みます。`flake.nix` がある場合は `nix shell <packages...> --command nix develop ...`、`flake.nix` がない場合は `nix shell <packages...> --command <agent>` で起動します。

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

- ホストに nix がインストールされ、nix-daemon が動作している必要があります。
- ホストの `/nix` ディレクトリ全体がコンテナにマウントされます。

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
    ├── embed_hash_test.ts
    ├── merge_test.ts
    ├── mount_stage_test.ts
    └── pipeline_test.ts
```
