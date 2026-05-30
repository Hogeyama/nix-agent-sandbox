---
title: セキュリティについて
description: 各機能のリスク・信頼境界・hostexec ルール設計の指針
---

nas はコンテナ内のファイルシステム変更をホストから隔離しますが、**設定次第ではホストの認証情報やデーモンへのアクセスを許可します**。各機能のリスクを理解した上で有効化してください。

## 機能とリスクの早見表

| 機能 | 概要 | デフォルト | 設定キー | リスク |
|---|---|---|---|---|
| ファイル隔離 | overlay でホスト FS から隔離 | ✅ 常時ON | (なし) | — |
| ネットワーク制御 | allowlist + approve/deny | ✅ 常時制御 | `network.allowlist` / `network.prompt` | 低 |
| Nix 統合 | host nix-daemon を socket 経由で利用 | opt-in | `nix.enable` / `nix.mountSocket` | [🔴 高](#設定により隔離が緩和されるもの) |
| Docker in Docker | 隔離 Docker 環境 | opt-in | `docker.enable` | [🟡 中](#設定により隔離が緩和されるもの) |
| localhost ポート転送 | host loopback ポートへ到達 | opt-in | `network.proxy.forwardPorts` | [🟡 中](#設定により隔離が緩和されるもの) |
| コマンド移譲 (hostexec) | コマンドをホスト実行 | opt-in | `hostexec.rules` | [🔴 高](#設定により隔離が緩和されるもの) |
| X11/xpra 転送 | サンドボックス X server | opt-in | `display.sandbox` | [🟡 中](#設定により隔離が緩和されるもの) |
| DBus 転送 | 許可 service へ到達 | opt-in | `dbus.session.enable` | [🟡 中](#設定により隔離が緩和されるもの) |
| GPG agent 転送 | 署名/復号 | opt-in | `gpg.forwardAgent` | [🔴 高](#設定により隔離が緩和されるもの) |
| 追加マウント | 任意ホストパス | opt-in | `extraMounts` | [🟡 中](#設定により隔離が緩和されるもの) |
| セッション多重化 | dtach で複数 attach | opt-in | `session.multiplex` | — |
| Worktree 管理 | 自動 git worktree | CLI フラグ | `--worktree` | — |
| Web UI daemon | approve / コンテナ操作 UI | opt-in | `ui.enable` | [🟡 中](#設定により隔離が緩和されるもの) |

## デフォルトで隔離されるもの

- **ファイルシステム**: マウントされたディレクトリ／ファイルを除き、コンテナ内の変更は overlay で隔離され、ホストには影響しません
- **プロセス・ネットワーク**: Docker コンテナの標準的な隔離が適用されます

## ネットワーク制御の仕組み

`network.allowlist` / `network.prompt` の動作です。

nas は shared Envoy forward proxy、host 上の auth-router、session ごとの broker を使って、エージェントコンテナの外部通信を常に制御します。`network.allowlist` に一致する通信は即時許可され、allowlist 外通信は `network.prompt.enable = true` のときだけ pending になり、無効時は deny されます。

```
session network
├── Agent container   (http_proxy / https_proxy → nas-envoy:15001)
├── shared Envoy      (dynamic forward proxy + ext_authz)
├── auth-router       (host daemon, UDS)
└── DinD sidecar      (有効時のみ同じ session network に attach)
```

- エージェントは資格情報付き proxy URL を通じて Envoy に接続し、`Proxy-Authorization` は auth-router で検証された後に upstream へは除去されます
- `localhost` / loopback / RFC1918 / link-local / ULA など deny-by-default 宛先は broker 前で拒否されます
- `network.prompt.enable = true` のとき、allowlist 外通信は `nas network pending` に現れ、`approve` / `deny` で制御できます
- DinD 有効時、`docker.shared = true` なら既存の共有 DinD サイドカーに session network を attach するだけで、サイドカー自体は再作成されません

## 設定により隔離が緩和されるもの

以下の設定は明示的な opt-in です。有効にするとコンテナからホストリソースへのアクセスが可能になります。

| 設定 | リスク |
|------|--------|
| `nix.mountSocket = true` | ホストの nix-daemon ソケットをコンテナに渡す。nix-daemon 経由で任意のビルド実行・`/nix/store` への書き込み・後続の nix 操作への影響などが可能で、実質的にホストユーザーと同等の権限をコンテナに与えることになる。信頼できないプロジェクト／エージェントで有効化しない |
| `docker.enable = true` | `docker:dind-rootless` サイドカーが `--privileged` で起動される（user namespace セットアップに必要）。エージェントコンテナ自体は非特権のまま。Docker 操作はサイドカー内に隔離され、ホストの Docker デーモンにはアクセスできない |
| `network.proxy.forwardPorts` | 指定した各ポートについて、ホスト `127.0.0.1:<port>` に bind しているサービスへコンテナから直接到達できるようになる（per-port UDS をコンテナへ bind-mount し、コンテナ内の `127.0.0.1:<port>` をホストの同ポートに pipe する）。ホスト側を `0.0.0.0` に晒す必要はないが、認証なしで動かしている開発用 DB・管理 UI・デーモンがあれば、コンテナ内のエージェントがそのままフルアクセスできる点に注意 |
| `dbus.session.enable = true` | 許可した DBus service に対して host 側資産へ到達できる。session bus 全体の露出は減るが、許可先 service の権限そのものは残る |
| `gpg.forwardAgent = true` | ホストの gpg-agent ソケットと公開鍵リング・信頼 DB・設定ファイルがコンテナにマウントされる。agent が unlock されている間はコンテナから任意の署名・復号が可能 |
| `extraMounts` | 指定したホストディレクトリがコンテナにマウントされる（`mode = "rw"` の場合は書き込みも可能） |
| `display.sandbox = "xpra"` | ホスト上に xpra の detached X server (Xvfb backing) を 1 つ起動し、その Xvfb ソケット + per-session cookie のみコンテナへ渡す。nas プロセスが seamless モードの `xpra attach :N` を同時に自動起動するため、エージェントが描画したウィンドウはユーザのデスクトップに通常のウィンドウとして出る。エージェントはこの仮想 X server **内**のアプリに対しては X11 client として全権を持つ（同 server 内のキー入力・画面取得・キー注入は可能）。auto-attach された viewer ウィンドウにフォーカスを当てている間は、ユーザのキー入力やクリップボード内容が viewer 経由でエージェント側のアプリに流れる（X11 アプリを操作する以上避けられない仕様）ため、この仮想 server に別の信頼アプリを同時に attach しないこと。ホスト本体の X server へは到達不可で、そこへのキーロガー・画面キャプチャ・キー注入・クリップボード窃取は構造的に不可能。xpra の control socket は xpra デフォルト (`$XDG_RUNTIME_DIR/xpra/`) に置かれる（ユーザ自身が再 attach/stop に使うだけで機微情報ではない）。xpra/Xvfb 自体に脆弱性があった場合のみホスト権限まで escape する余地あり |
| `hostexec.rules[].inheritEnv.mode = "unsafe-inherit-all"` | host の環境変数が広く継承されるため、secret 漏えい面が大きくなる |

## HostExec の注意点

hostexec ルールで許可したコマンドはホスト側で実行されるため、そのコマンドが持つ能力（任意コード実行経路、任意ファイル I/O、ネットワーク、鍵アクセス等）はそのままエージェントの能力になります。ルールを追加する際は「意図した機能」だけでなく「そのコマンドで他に何ができてしまうか」（全オプション、設定ファイル依存、任意コード実行パス）を把握した上で追加してください。特に `approval = "allow"` は恒久的な貫通口になるため、必要最小限に留めてください。

### ルール設計時の指針

- hostexec の入力となるパス（`argv0`、ホスト側 `PATH` に含まれるディレクトリ、委譲先コマンドが参照する設定ファイル 等）は、コンテナから書き込み不能に保たれる必要があります。これが崩れるとエージェントによる書き換えが直ちにホスト任意コード実行に繋がります
  - 相対パス `argv0`（例: `./scripts/foo`）→ 対応する `extraMounts` を `mode = "ro"` に
  - bare name `argv0`（例: `git`）→ ホスト側 `PATH` 上のディレクトリ（`~/.local/bin`, `~/.nix-profile/bin` 等）を `extraMounts` で rw マウントしない
  - 設定ファイルを読むコマンド（`deno task` / `npm run` / `make` 等）→ 当該設定ファイルを `ro` マウントする
- `"allow"` はできる限り避け、`approval = "prompt"` + 絞り込んだ `argRegex` を既定とする
- `bash -lc` / `sh -c` / `python -c` のような任意コード実行に直結する委譲はルール化しない
- `"unsafe-inherit-all"` は互換性用の escape hatch。通常は `"minimal"` + `inheritEnv.keys` を使う

### 特に注意すべきコマンドカテゴリ

- **テスト・ビルドランナー**（`bun test`, `npm test`, `make`, `cargo` ...）: 定義上、テスト・ビルドファイル経由で任意コード実行
- **言語ランタイム**（`python`, `node`, `ruby`, `deno` ...）: `-c` / スクリプト引数で任意コード実行
- **ローカルに HTTP サーバを立てるツール**（静的ファイルサーバ / live-reload プレビュー / API モック 等）: `--bind` で非-loopback、あるいは `--port` を `network.proxy.forwardPorts` と衝突させると、コンテナからホスト任意ファイルが読める経路になる
- **`gpg`**: `--output` 系オプションでホスト任意パスへの書き込みが可能。`argRegex` で意図した最小フォーマット（例: git の署名だけ許すなら `^--status-fd=2 -bsau [0-9A-Fa-f]{8,40}$`）に絞ること
- **エディタ**（`vim`, `nvim`, `emacs` ...）: `:!` / 設定ファイルから任意コマンド起動
- **ネットワークツール**（`curl`, `wget`, `ssh` ...）: 任意 I/O。`ssh` は `ProxyCommand` 経路でシェル実行
- **`git`**: 引数内 alias 定義（`-c 'alias.x=!cmd'`）で任意シェルが走る。`git push` 等をピンポイントで deny するより、「想定の sub-command パターンに match する prompt ルール」の方が安全
- **パッケージマネージャ**（`npm install`, `pip install`, `cargo install` ...）: post-install / build スクリプトによる任意コード実行
- **プロセス置換系**（`env`, `xargs`, `find -exec`, `rg --pre` 等）: 結局別のコマンドに橋渡しする構造なので arg 制約が必須

### マッチ仕様と周辺の挙動

- `argv0` には bare name（`git`）、絶対パス（`/usr/bin/git`）、相対パス（`./scripts/foo`）を指定できます
  - bare name: PATH 上のラッパーシンボリックリンクで委譲
  - 絶対パス・相対パス: `LD_PRELOAD` による `execve` インターセプトで委譲
- `argRegex` は引数をスペースで join した文字列に対してマッチします。そのためスペースを含む単一引数（例: `git commit -m "hello world"` の `"hello world"`）と複数引数の区別はできません。実用上、コマンド識別に使う先頭引数やフラグにスペースが含まれることは少ないため問題になることは多くないですが、引数の値そのものに依存するマッチパターンを書く場合は留意してください
- エージェント設定ディレクトリ（`~/.claude/` / `~/.copilot/` / `~/.codex/`）は存在すれば常にマウントされるため、これらに認証トークンが置かれている場合は hostexec を制限してもコンテナ内からアクセス可能です

## 常にマウントされるもの

- **エージェントの設定**: ホスト上に存在する場合のみ、Claude Code は `~/.claude/`、Copilot CLI は `~/.copilot/`、OpenAI Codex CLI は `~/.codex/` がコンテナに渡されます。

## 推奨事項

- `.nas/config.pkl` ではまず最小限の設定から始め、必要に応じて機能を追加してください
- `docker.enable` は Docker-in-Docker が必要な場合のみ有効にしてください（DinD rootless サイドカーが起動されます）
- クラウド認証情報のマウントは、エージェントにクラウドリソースへのアクセスが必要な場合のみ有効にしてください
