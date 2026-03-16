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

[Releases · openai/codex](https://github.com/openai/codex/releases) からインストールしてください。

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

### Sidecar コンテナの掃除

`docker.shared: true` や `network.allowlist` / `network.prompt.enable` を使っていると、`dind` / `envoy` 関連の runtime が残ることがあります。未使用のものだけを止めて削除したい場合は `container clean` と `network gc` を使います。

```sh
nas container clean
```

このコマンドは nas が管理する `dind` / `proxy` コンテナのうち、現在どの agent コンテナからも使われていないものだけを対象に `stop` + `rm` します。削除後に空になった nas 管理 network と DinD 用 tmp volume もあわせて回収します。`nas-sandbox` 本体は対象に含みません。

### Network 承認キューの確認と操作

`network.allowlist` だけでなく `network.prompt.enable: true` を使うと、allowlist 外通信は session ごとの承認キューに入り、`nas network` から確認・承認・拒否できます。

```sh
nas network pending
nas network approve <session-id> <request-id> --scope [once|host-port|host]
nas network deny <session-id> <request-id>
nas network gc
```

- `pending` は `session_id request_id target state created_at` を 1 行ずつ表示します
- approve / deny は DBus デスクトップ通知のデフォルトアクション / dissmissからも呼び出されます。approveのscopeはhost-portになります。
- `gc` は stale session registry / pending dir / broker socket / auth-router pid/socket を掃除します

### HostExec 承認キューの確認と操作

`hostexec` を設定すると、コンテナ内の wrapper から host 側 broker にコマンド実行を委譲できます。`approval: prompt` のルールは session ごとの承認キューに入り、`nas hostexec` から確認・承認・拒否できます。

```sh
nas hostexec pending
nas hostexec approve <session-id> <request-id>
nas hostexec deny <session-id> <request-id>
```

- `pending` は `session_id request_id rule_id cwd argv...` を 1 行ずつ表示します
- approve / deny は DBus デスクトップ通知のデフォルトアクション / dissmissからも呼び出されます。

### エージェントに引数を渡す

プロフィール名の後ろには `--` なしでエージェント固有の引数を渡せます。デフォルトプロファイルを使う場合や明示的に区切りたい場合は、`--` も使えます。

```sh
# profile を明示したら、その後ろはそのまま agent 引数
nas copilot -p "このリポジトリの概要を教えて"
nas copilot --resume=2b2155c8-e59b-4c76-b1df-7f9d14aeecfb

# 非インタラクティブ（スクリプティング）
nas -- -p "このリポジトリの概要を教えて"

# Copilot CLI で全権限付与
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
      allowlist:           # 即時許可するドメインのリスト
        - api.anthropic.com
        - github.com
      prompt:
        enable: true       # allowlist 外通信を pending にして手動承認する
        timeout-seconds: 300
        default-scope: host-port   # once | host-port | host
        notify: auto       # auto | off
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
    secrets:                # コンテナへ直接渡さない host 側 secret
      github_token:
        from: env:GITHUB_TOKEN      # env: / file: / dotenv: / keyring:
        required: true
    hostexec:
      prompt:
        enable: true
        timeout-seconds: 300
        default-scope: capability
        notify: auto
      rules:
        - id: git-readonly
          match:
            argv0: git
            subcommands: [pull, fetch]
          cwd:
            mode: workspace-or-session-tmp
          env:
            GITHUB_TOKEN: secret:github_token
          inherit-env:
            mode: minimal
            keys: [SSH_AUTH_SOCK]
          approval: prompt        # allow | prompt | deny
          fallback: container     # container | deny
        - id: git-log
          match:
            argv0: git
            subcommands: [log]
          cwd:
            mode: workspace-or-session-tmp
          approval: allow
          fallback: container
        - id: gh-pr
          match:
            argv0: gh
            subcommands: [pr, api]
          cwd:
            mode: workspace-or-session-tmp
          env:
            GITHUB_TOKEN: secret:github_token
          approval: prompt
          fallback: container

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
| `network.allowlist` | string[] | `[]` | 即時許可する外部ドメインのリスト。allowlist 外通信は `network.prompt.enable` が無効なら拒否、有効なら pending になる |
| `network.prompt.enable` | bool | `false` | allowlist 外通信を session ごとの承認キューに入れる |
| `network.prompt.timeout-seconds` | number | `300` | pending 承認の待機秒数。タイムアウト時は deny |
| `network.prompt.default-scope` | `"once"` \| `"host-port"` \| `"host"` | `"host-port"` | `nas network approve` の既定 scope |
| `network.prompt.notify` | `"auto"` \| `"off"` | `"auto"` | pending 発生時の通知 backend。`auto` は tmux popup → `notify-send` → no-op の順で試行 |
| `gcloud.mount-config` | bool | `false` | gcloud 設定ディレクトリ（`~/.config/gcloud`）をマウント |
| `aws.mount-config` | bool | `false` | AWS 設定ディレクトリ（`~/.aws`）をマウント |
| `gpg.forward-agent` | bool | `false` | ホストの gpg-agent を転送（ソケット・公開鍵リング・信頼DB・設定ファイルをマウント） |
| `extra-mounts` | list | `[]` | 追加マウント。`[{ src, dst, mode? }]`（`mode` は `"ro"`/`"rw"`、省略時 `"ro"`） |
| `env` | list | `[]` | `[{ key, val }]` または `[{ key_cmd, val_cmd }]` 形式で環境変数を追加 |
| `secrets.<name>.from` | string | （必須） | secret の取得元。`env:VAR_NAME` / `file:/absolute/path` / `dotenv:/absolute/path#KEY` / `keyring:service/account` |
| `secrets.<name>.required` | bool | `true` | secret が取得できない場合にエラーにするか |
| `hostexec.prompt.enable` | bool | `true` | `approval: prompt` の hostexec 実行を承認キューに入れる |
| `hostexec.prompt.timeout-seconds` | number | `300` | hostexec 承認の待機秒数。タイムアウト時は deny |
| `hostexec.prompt.default-scope` | `"capability"` | `"capability"` | hostexec 承認再利用の単位 |
| `hostexec.prompt.notify` | `"auto"` \| `"tmux"` \| `"desktop"` \| `"off"` | `"auto"` | pending 発生時の通知 backend。`auto` は `notify-send` → tmux popup → no-op の順で試行 |
| `hostexec.rules[].id` | string | （必須） | 監査・承認 fingerprint に使う安定 ID |
| `hostexec.rules[].match.argv0` | string | （必須） | host 実行へ委譲するコマンド名 |
| `hostexec.rules[].match.subcommands` | string[] | 省略可 | ツール別正規化後にマッチするサブコマンド。省略時はその `argv0` に対する任意のサブコマンドにマッチ。空配列 `[]` は不可 |
| `hostexec.rules[].cwd.mode` | enum | `"workspace-or-session-tmp"` | `workspace-only` / `workspace-or-session-tmp` / `allowlist` / `any` |
| `hostexec.rules[].cwd.allow` | string[] | `[]` | `cwd.mode: allowlist` 用。絶対パスまたは `workspace:` / `session_tmp:` プレフィクス |
| `hostexec.rules[].env` | object | `{}` | `ENV_NAME: secret:<name>` 形式で host 実行時だけ secret を注入 |
| `hostexec.rules[].inherit-env.mode` | enum | `"minimal"` | `minimal` / `unsafe-inherit-all` |
| `hostexec.rules[].inherit-env.keys` | string[] | `[]` | `minimal` に追加で継承する host 環境変数 |
| `hostexec.rules[].approval` | enum | `"prompt"` | `allow` / `prompt` / `deny` |
| `hostexec.rules[].fallback` | enum | `"container"` | ルール不一致や不許可時にコンテナ実行へ戻すか即拒否するか |

`extra-mounts` の `src` が存在しない場合、そのエントリは警告を出してスキップされます。

## 仕組み

### コンテナの中身

- **ベースイメージ**: `ubuntu:24.04`
- **プリインストール**: git, curl, bash, ca-certificates, docker CLI, docker compose plugin, gh, ripgrep, fd, Python 3（`python`/`python3`）, Node.js, Google Cloud CLI（`gcloud`）, AWS CLI v2（`aws`）
- **エージェントバイナリ**: ホストからバインドマウント（Claude Code は `~/.local/bin/`、Copilot/Codex は `/usr/local/bin/` に配置）

### HostExec / Secret Broker

`hostexec` は、secret をコンテナへ直接見せずに host 側 broker が保持し、許可済みコマンドだけ host で実行する仕組みです。

```
agent container
├── wrapper (git / gh / ...)
├── UDS: hostexec broker socket
└── pending approval via `nas hostexec`

host
├── SecretStore (env / file / dotenv / keyring)
└── HostExecBroker
```

- broker は host 側で UDS (Unix Domain Socket) を listen し、そのソケットをコンテナへ bind mount します
- コンテナには secret 値を環境変数として渡さず、broker が host 実行時だけ注入します
- 未一致ルールは `fallback: container` ならコンテナ内の実バイナリへ戻ります
- `subcommands` は `git -C /path log` のような前置オプションを正規化して判定します
- `subcommands` を省略すると、その `argv0` に対する任意のサブコマンドにマッチします
- `approval: prompt` の再利用は capability fingerprint 単位で、より強い secret や広い env 継承へ化けないようにしています

例:

```sh
# argv0: git / subcommands: [log] にマッチ
git -C /path/to/repo log --oneline

# argv0: gh / subcommands: [pr] にマッチ
gh pr list

# argv0: gh / subcommands: [api] にマッチ
gh api repos/owner/repo/pulls
```

- `git -C /path/to/repo log` は `-C` を前置オプションとして飛ばした上で `log` をサブコマンドとして判定します
- `gh pr list` は `pr` にマッチし、`gh api ...` は `api` にマッチします

### Nix 統合（`nix.enable: true` 時）

ホストの nix daemon にソケット経由で接続します。
プロジェクトに `flake.nix` がある場合、コンテナ内で `nix develop` を経由してエージェントを起動します。ホストの `/nix` をマウントし、`NIX_REMOTE=daemon` でホストの nix daemon を利用します。コンテナ内に nix をインストールする必要はありません。
`nix.extra-packages` が設定されている場合は `nix shell` を挟みます。`flake.nix` がある場合は `nix shell <packages...> --command nix develop ...`、`flake.nix` がない場合は `nix shell <packages...> --command <agent>` で起動します。

## セキュリティについて

nas はコンテナ内のファイルシステム変更をホストから隔離しますが、**設定次第ではホストの認証情報やデーモンへのアクセスを許可します**。各機能のリスクを理解した上で有効化してください。

### デフォルトで隔離されるもの

- **ファイルシステム**: コンテナ内の変更は overlay で隔離され、ホストの作業ディレクトリには影響しません（worktree 使用時はworktree 内に限定）
- **プロセス・ネットワーク**: Docker コンテナの標準的な隔離が適用されます

### ネットワーク制御（`network.allowlist` / `network.prompt`）

nas は shared Envoy forward proxy、host 上の auth-router、session ごとの broker を使って、エージェントコンテナの外部通信を制御します。`network.allowlist` に一致する通信は即時許可され、allowlist 外通信は `network.prompt.enable: true` のときだけ pending になります。

```
session network
├── Agent container   (http_proxy / https_proxy → nas-envoy:15001)
├── shared Envoy      (dynamic forward proxy + ext_authz)
├── auth-router       (host daemon, UDS)
└── DinD sidecar      (有効時のみ同じ session network に attach)
```

- エージェントは資格情報付き proxy URL を通じて Envoy に接続し、`Proxy-Authorization` は auth-router で検証された後に upstream へは除去されます
- `localhost` / loopback / RFC1918 / link-local / ULA / `metadata.google.internal` など deny-by-default 宛先は broker 前で拒否されます
- `network.prompt.enable: true` のとき、allowlist 外通信は `nas network pending` に現れ、`approve` / `deny` で制御できます
- DinD 有効時は shared DinD 本体はそのまま、session ごとの attach/detach だけが追加されます

### 設定により隔離が緩和されるもの

以下の設定は明示的な opt-in です。有効にするとコンテナからホストリソースへのアクセスが可能になります。

| 設定 | リスク |
|------|--------|
| `docker.enable: true` | `docker:dind-rootless` サイドカーが `--privileged` で起動される（user namespace セットアップに必要）。エージェントコンテナ自体は非特権のまま。Docker 操作はサイドカー内に隔離され、ホストの Docker デーモンにはアクセスできない |
| `gcloud.mount-config: true` | GCP の認証情報（`~/.config/gcloud`）がコンテナに公開される |
| `aws.mount-config: true` | AWS の認証情報（`~/.aws`）がコンテナに公開される |
| `gpg.forward-agent: true` | ホストの GPG 署名鍵がコンテナから利用可能になる |
| `extra-mounts` | 指定したホストディレクトリがコンテナにマウントされる（`mode: rw` の場合は書き込みも可能） |
| `hostexec.rules[].inherit-env.mode: unsafe-inherit-all` | host の環境変数が広く継承されるため、secret 漏えい面が大きくなる |

### HostExec の注意点

- `hostexec` は「任意コマンドを host 実行できる機能」ではなく、構造化ルールで限定委譲する仕組みです
- `bash -lc` / `sh -c` / `python -c` のような任意コード実行に繋がるルールは設定者の責任で避けてください
- `unsafe-inherit-all` は互換性用の escape hatch であり、通常は `minimal` + `inherit-env.keys` を推奨します
- agent 設定ディレクトリ（例: `~/.codex` / `~/.copilot`）の mount は引き続き別の認証面として残ります

### 常にマウントされるもの

- **エージェントの設定**: Claude Code の場合は `~/.claude/`、Copilot CLI の場合は `~/.copilot/`、OpenAI Codex CLI の場合は `~/.codex/` がコンテナに渡されます。これはエージェントの動作に必須です。
- **Nix（有効時）**: ホストの `/nix` ディレクトリと nix daemon ソケットがマウントされます。

### 推奨事項

- `.agent-sandbox.yml` ではまず最小限の設定から始め、必要に応じて機能を追加してください
- `docker.enable` は Docker-in-Docker が必要な場合のみ有効にしてください（DinD rootless サイドカーが起動されます）
- クラウド認証情報のマウントは、エージェントにクラウドリソースへのアクセスが必要な場合のみ有効にしてください

## 制約・注意事項

### エージェントバイナリ

- **npm でインストールされたエージェントは動作しません。** npm 版は `node_modules/` ツリー全体に依存するため、単一ファイルのバインドマウントでは起動できません。必ず公式のスタンドアロンインストーラーを使ってください。
- エージェントバイナリは ELF 形式であることが前提です。

### ファイル所有権

- コンテナ内のエージェントプロセスは、ホストユーザーと同じ UID/GID で実行されます。作成・変更されたファイルはホストユーザー所有になります。
- entrypoint は root で起動し（overlay セットアップ等）、エージェント起動前にホスト UID にドロップします。

### TTY

- インタラクティブモード（引数なしでエージェントを起動）には TTY が必要です。
- CI/スクリプトなど非 TTY 環境では `nas copilot -p "プロンプト"` のように profile 名の後ろへ直接引数を渡すか、デフォルトプロファイルを使う場合は `-- -p "プロンプト"` を使ってください。

### Docker

- `docker.enable: true` は `docker:dind-rootless` サイドカーを起動します。サイドカーは `--privileged` で起動されますが、エージェントコンテナは非特権のままです。Docker 操作はホストから隔離されます。
- ビルドキャッシュは Docker named volume (`nas-docker-cache`) に永続化されます。`docker volume rm nas-docker-cache` でクリアできます。

### Nix固有

- ホストに nix がインストールされ、nix-daemon が動作している必要があります。
- ホストの `/nix` ディレクトリ全体がコンテナにマウントされます。
