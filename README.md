# nas — Nix Agent Sandbox

Docker + Nix で AI エージェント（Claude Code / GitHub Copilot CLI / OpenAI Codex CLI）の隔離された作業環境を起動する CLI ツール。
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

**OpenAI Codex CLI:**

公式ドキュメントに従ってスタンドアロンバイナリとしてインストールしてください。

いずれも `~/.local/bin/` 等にシングルバイナリが配置されます。`which claude` / `which copilot` / `which codex` でパスが解決できれば OK です。

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

CLI から一時的に worktree 動作を上書きできます。

- `nas <profile> -b <branch>` / `nas --worktree <branch>` で worktree を有効化し、ベースブランチを指定（`@` または `HEAD` で現在の HEAD を利用）
- `nas --no-worktree` でプロファイル設定に関わらず worktree を無効化

溜まった worktree を手動で管理するには `worktree` サブコマンドを使います。

```sh
nas worktree list            # nas が作成した worktree を一覧表示
nas worktree clean           # すべて削除（確認プロンプトあり）
nas worktree clean --force   # 確認なしで削除
```

既存のイメージを削除してから再ビルドし、そのまま起動します。

`nas` のバージョンアップにより内蔵の Dockerfile/entrypoint が更新された場合、起動時に自動検知して `nas rebuild` の実行を促すメッセージが表示されます。

### エージェントに引数を渡す

プロフィール名の後ろには `--` なしでエージェント固有の引数を渡せます。デフォルトプロファイルを使う場合や明示的に区切りたい場合は、従来どおり `--` も使えます。

```sh
# profile を明示したら、その後ろはそのまま agent 引数
nas copilot -p "このリポジトリの概要を教えて"
nas copilot --resume=2b2155c8-e59b-4c76-b1df-7f9d14aeecfb

# 非インタラクティブ（スクリプティング）
nas -- -p "このリポジトリの概要を教えて"

# Copilot CLI で全権限付与（サンドボックス内なので安全）
nas copilot -p "テストを書いて" --yolo
```

### デモ: Worktree による隔離作業 → cherry-pick で取り込み

`worktree` 設定のプロファイルで `nas` を実行し、エージェント終了後に成果物を cherry-pick で取り込む一連の流れです。

```
$ nas copilot-worktree
[nas] Running stage: WorktreeStage
[nas] Existing worktree(s) found for this profile:
  1. .../.git/nas-worktrees/nas-copilot-worktree-2026-03-10T12-37-30  [nas/copilot-worktree/2026-03-10T12-37-30]
  0. Create new worktree
[nas] Choose [0-1]: 1
[nas] Reusing worktree: .../.git/nas-worktrees/nas-copilot-worktree-2026-03-10T12-37-30
[nas] Running stage: DockerBuildStage
[nas] Docker image "nas-sandbox" already exists, skipping build
[nas] Running stage: NixDetectStage
[nas] Nix: auto-detected host nix → enabled
[nas] Running stage: MountStage
[nas] Running stage: LaunchStage
[nas] Launching container...
[nas]   Image: nas-sandbox
[nas]   Agent: copilot
[nas]   Command: copilot --yolo
[nas] Using cached nix dev environment.

  ... (エージェントが起動し、作業を行う) ...

[nas] Teardown: WorktreeStage
[nas] Worktree HEAD: 987004d
[nas] What to do with the worktree?
  1. Delete
  2. Keep
[nas] Choose [1/2]: 1
[nas] Recent commits on nas/copilot-worktree/2026-03-10T12-37-30:
  987004d chore: add deno fmt hooks for Copilot CLI and Claude Code
  96d7191 style: apply deno fmt to all source files
  245dbda chore: exclude markdown files from deno fmt
[nas] What to do with the branch?
  1. Delete
  2. Cherry-pick to base branch
  3. Rename and keep
[nas] Choose [1/2/3]: 2
[nas] Cherry-picking 3 commit(s) onto main...
[nas] Cherry-pick completed successfully.
[nas] Deleted branch: nas/copilot-worktree/2026-03-10T12-37-30
```

エージェントに隔離ブランチで自由に作業させ、成果物のコミットだけを安全にベースブランチへ取り込めます。

## 設定ファイル

プロジェクトルートに `.agent-sandbox.yml` を配置します。カレントディレクトリから上位に向かって自動検索されます。

### グローバル設定

`~/.config/nas/agent-sandbox.yml` にグローバル設定を配置できます。ローカル（プロジェクト側）の設定とマージされ、同名プロファイルではローカルが優先されます。共通の環境変数やツール設定を一箇所にまとめたい場合に便利です。

```yaml
# .agent-sandbox.yml
default: copilot-nix

profiles:
  copilot-nix:
    agent: copilot          # "claude" | "copilot" | "codex"
    nix:
      enable: auto          # true | false | "auto"（flake.nix の有無で判定）
      mount-socket: true    # ホストの nix daemon ソケット経由で nix を使用
    docker:
      enable: false        # DinD rootless サイドカーを起動して隔離された Docker 環境を提供
      shared: false        # true にするとサイドカーをセッション間で共有（起動が速い）
    network:
      allowlist:           # 許可するドメインのリスト（設定時は Squid proxy でフィルタリング）
        - api.anthropic.com
        - github.com
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
      enable: false
      shared: false
```

### プロファイル設定リファレンス

| キー | 型 | デフォルト | 説明 |
|------|------|-----------|------|
| `agent` | `"claude"` \| `"copilot"` \| `"codex"` | （必須） | 使用するエージェント |
| `worktree.base` | string | `"origin/main"` | worktree のベースブランチ |
| `worktree.on-create` | string | `""` | worktree 作成後に実行するコマンド |
| `worktree.cleanup` | `"force"` \| `"auto"` \| `"keep"` | `"auto"` | エージェント終了後の worktree 処理。`force`: 常に削除、`auto`: 未コミット変更がなければ削除、`keep`: 常に残す |
| `nix.enable` | bool \| `"auto"` | `"auto"` | Nix 統合。`auto` は `flake.nix` で判定 |
| `nix.mount-socket` | bool | `true` | ホストの nix daemon にソケット経由で接続 |
| `nix.extra-packages` | string[] | `[]` | `nix shell` で追加するパッケージ（`nix develop` 前に適用） |
| `docker.enable` | bool | `false` | DinD rootless サイドカーを起動して隔離された Docker 環境を提供 |
| `docker.shared` | bool | `false` | サイドカーをセッション間で共有（起動が速い。`false` ではセッションごとに起動・破棄） |
| `network.allowlist` | string[] | `[]` | 許可する外部ドメインのリスト。設定すると Squid forward proxy + internal ネットワークでエージェントの通信先を制限。サブドメインも許可される |
| `gcloud.mount-config` | bool | `false` | gcloud 設定ディレクトリ（`~/.config/gcloud`）をマウント |
| `aws.mount-config` | bool | `false` | AWS 設定ディレクトリ（`~/.aws`）をマウント |
| `gpg.forward-agent` | bool | `false` | ホストの gpg-agent を転送（ソケット・公開鍵リング・信頼DB・設定ファイルをマウント） |
| `extra-mounts` | list | `[]` | 追加マウント。`[{ src, dst, mode? }]`（`mode` は `"ro"`/`"rw"`、省略時 `"ro"`） |
| `env` | list | `[]` | `[{ key, val }]` または `[{ key_cmd, val_cmd }]` 形式で環境変数を追加 |

`extra-mounts` の `src` が存在しない場合、そのエントリは警告を出してスキップされます。

## 仕組み

### パイプライン

```
nas [options-before-profile] [profile-name] [agent-args...]
  │
  ├─ WorktreeStage     git worktree 作成（設定時のみ）
  ├─ DockerBuildStage  Docker イメージのビルド（キャッシュあり）
  ├─ NixDetectStage    flake.nix の有無を検出
  ├─ MountStage        マウント構成の組み立て
  ├─ DindStage         DinD rootless サイドカー起動（docker.enable 時のみ）
  ├─ ProxyStage        Forward proxy サイドカー起動（network.allowlist 設定時のみ）
  └─ LaunchStage       コンテナ起動 → エージェント実行
```

### コンテナの中身

- **ベースイメージ**: `ubuntu:24.04`
- **プリインストール**: git, curl, bash, ca-certificates, docker CLI, docker compose plugin, gh, ripgrep, fd, Python 3（`python`/`python3`）, Node.js, Google Cloud CLI（`gcloud`）, AWS CLI v2（`aws`）
- **エージェントバイナリ**: ホストからバインドマウント（Claude Code は `~/.local/bin/`、Copilot/Codex は `/usr/local/bin/` に配置）

### 認証の引き継ぎ

| エージェント | 方法 |
|-------------|------|
| Claude Code | `~/.claude/` をマウント |
| Copilot CLI | `~/.config/.copilot/` をマウント + `GITHUB_TOKEN` を環境変数で渡す |
| OpenAI Codex CLI | `~/.codex/` をマウント + `OPENAI_API_KEY` を環境変数で渡す（設定時） |

### Nix 統合（`nix.enable: true` 時）

ホストの nix daemon にソケット経由で接続します。
プロジェクトに `flake.nix` がある場合、コンテナ内で `nix develop` を経由してエージェントを起動します。ホストの `/nix` をマウントし、`NIX_REMOTE=daemon` でホストの nix daemon を利用します。コンテナ内に nix をインストールする必要はありません。
`nix.extra-packages` が設定されている場合は `nix shell` を挟みます。`flake.nix` がある場合は `nix shell <packages...> --command nix develop ...`、`flake.nix` がない場合は `nix shell <packages...> --command <agent>` で起動します。

## セキュリティについて

nas はコンテナ内のファイルシステム変更をホストから隔離しますが、**設定次第ではホストの認証情報やデーモンへのアクセスを許可します**。各機能のリスクを理解した上で有効化してください。

### デフォルトで隔離されるもの

- **ファイルシステム**: コンテナ内の変更は overlay で隔離され、ホストの作業ディレクトリには影響しません（worktree 使用時はworktree 内に限定）
- **プロセス・ネットワーク**: Docker コンテナの標準的な隔離が適用されます

### ネットワーク制御（`network.allowlist` 設定時）

`network.allowlist` を設定すると、Squid forward proxy サイドカーと Docker internal ネットワークにより、エージェントコンテナの外部通信がドメイン単位で制限されます。

```
internal network (--internal: 外部アクセス不可)
├── Agent container (http_proxy → proxy:3128)
├── Proxy container (bridge にも接続 → 外部アクセス可)
└── DinD sidecar  (bridge にも接続 → image pull 可、allowlist 有効時のみ)
```

- エージェントは internal ネットワークのみに所属し、proxy 経由でしか外部にアクセスできません
- 同じ allowlist を使うセッション間で proxy コンテナが自動的に共有されます
- DinD 有効時は DinD サイドカーも internal ネットワークに接続され、image pull は bridge 経由で直接外部にアクセスします

### 設定により隔離が緩和されるもの

以下の設定は明示的な opt-in です。有効にするとコンテナからホストリソースへのアクセスが可能になります。

| 設定 | リスク |
|------|--------|
| `docker.enable: true` | `docker:dind-rootless` サイドカーが `--privileged` で起動される（user namespace セットアップに必要）。エージェントコンテナ自体は非特権のまま。Docker 操作はサイドカー内に隔離され、ホストの Docker デーモンにはアクセスできない |
| `gcloud.mount-config: true` | GCP の認証情報（`~/.config/gcloud`）がコンテナに公開される |
| `aws.mount-config: true` | AWS の認証情報（`~/.aws`）がコンテナに公開される |
| `gpg.forward-agent: true` | ホストの GPG 署名鍵がコンテナから利用可能になる |
| `extra-mounts` | 指定したホストディレクトリがコンテナにマウントされる（`mode: rw` の場合は書き込みも可能） |

### 常にマウントされるもの

- **エージェントの認証情報**: Claude Code の場合は `~/.claude/`、Copilot CLI の場合は `~/.config/.copilot/` と `GITHUB_TOKEN`、OpenAI Codex CLI の場合は `~/.codex/` と `OPENAI_API_KEY`（設定時）がコンテナに渡されます。これはエージェントの動作に必須です。
- **Nix（有効時）**: ホストの `/nix` ディレクトリと nix daemon ソケットがマウントされます。

### 推奨事項

- `.agent-sandbox.yml` ではまず最小限の設定から始め、必要に応じて機能を追加してください
- `docker.enable` は Docker-in-Docker が必要な場合のみ有効にしてください（DinD rootless サイドカーが起動されます）
- クラウド認証情報のマウントは、エージェントにクラウドリソースへのアクセスが必要な場合のみ有効にしてください

## 制約・注意事項

### エージェントバイナリ

- **npm でインストールされたエージェントは動作しません。** npm 版は `node_modules/` ツリー全体に依存するため、単一ファイルのバインドマウントでは起動できません。必ず公式のスタンドアロンインストーラーを使ってください。
- エージェントバイナリは ELF 形式（Linux x86\_64）であることが前提です。

### ファイル所有権

- コンテナ内のエージェントプロセスは、ホストユーザーと同じ UID/GID で実行されます。作成・変更されたファイルはホストユーザー所有になります。
- entrypoint は root で起動し（overlay セットアップ等）、エージェント起動前にホスト UID にドロップします。

### TTY

- インタラクティブモード（引数なしでエージェントを起動）には TTY が必要です。
- CI/スクリプトなど非 TTY 環境では `copilot -p "プロンプト"` のように profile 名の後ろへ直接引数を渡すか、デフォルトプロファイルを使う場合は `-- -p "プロンプト"` を使ってください。

### Copilot CLI のパーミッション

- Copilot CLI は非インタラクティブモード（`-p`）でシェルコマンドの実行に許可を求めます。
- サンドボックス内で全操作を許可する場合は `--yolo` を渡してください: `nas copilot -p "..." --yolo`

### Docker

- `docker.enable: true` は `docker:dind-rootless` サイドカーを起動します。サイドカーは `--privileged` で起動されますが、エージェントコンテナは非特権のままです。Docker 操作はホストから隔離されます。
- ビルドキャッシュは Docker named volume (`nas-docker-cache`) に永続化されます。`docker volume rm nas-docker-cache` でクリアできます。

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
│   │   ├── dind.ts         # DinD rootless サイドカー管理
│   │   ├── proxy.ts        # Forward proxy サイドカー管理
│   │   └── launch.ts       # Docker ビルド & コンテナ起動
│   ├── docker/
│   │   ├── client.ts       # Docker CLI ラッパー
│   │   └── embed/
│   │       ├── Dockerfile
│   │       └── entrypoint.sh
│   └── agents/
│       ├── claude.ts       # Claude Code 固有設定
│       ├── copilot.ts      # Copilot CLI 固有設定
│       └── codex.ts        # OpenAI Codex CLI 固有設定
└── tests/
    ├── config_test.ts
    ├── embed_hash_test.ts
    ├── merge_test.ts
    ├── mount_stage_test.ts
    └── pipeline_test.ts
```
