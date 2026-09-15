# `nas claude` を `srt claude` で近似する

`global.pkl` の `claude` プロファイルを、Anthropic の sandbox-runtime (`srt`,
`@anthropic-ai/sandbox-runtime`) の設定へ写したものです。srt には nas の中核である
「人が承認する」経路が無いので、同じ設定にはなりません。そのため近似を 2 通り用意し、
どちらでも失われるものと、片方だけで失われるものを分けて記載します。

対象は srt 0.0.76 (2026-09-15 時点の `main`、commit `9c6d356c`) の Linux 実装です。
設定 JSON は同バージョンの zod スキーマで検証し、Debian 12 のホスト上で `probe.sh` を
両設定のサンドボックス内で実行して挙動を確認しました。結果は末尾に載せています。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `srt-settings.open.json` | 開く側の近似。nas が `review` にしている箇所を `allow` として写す |
| `srt-settings.close.json` | 閉じる側の近似。nas が `review` にしている箇所を `deny` として写す |
| `srt-claude.sh` | 起動ラッパー。`global.pkl` の `env` と `secrets` に相当する部分を組み立てて `srt -c "claude ..."` を呼ぶ |
| `probe.sh` | サンドボックス内で実行する検査。可視性、書き込み可否、HTTP の到達性、socket の到達性を値を出さずに表示する |

```bash
# Claude Code と同じ要領で、作業ディレクトリに cd してから
docs/migration/srt/srt-claude.sh open
docs/migration/srt/srt-claude.sh close

# srt を入れていないホストでは npx 経由で起動できる
SRT="npx -y @anthropic-ai/sandbox-runtime@0.0.76" docs/migration/srt/srt-claude.sh close

# 設定を変えたときの確認
npx -y @anthropic-ai/sandbox-runtime@0.0.76 \
  --settings docs/migration/srt/srt-settings.close.json -c "bash docs/migration/srt/probe.sh"
```

前提として、ホストに `bwrap`、`socat`、`rg` が必要です。close では home 全体を隠すので、
srt 自身の置き場所がサンドボックス内から読めなければなりません。npx は
`~/.npm/_npx` 配下に展開するため、close の `allowRead` に `~/.npm` を入れています。
`/usr` や `/nix/store` にインストールした場合はこの項目は要りません。

`~/.claude/settings.json` に入っている `nas hook ...` の hook は、nas のブローカーが
無い環境では失敗するので、srt で使う間は外すか、`--settings` で上書きする必要があります。

## 近似の方針

nas の判定は `allow` / `review` / `deny` の 3 値で、`review` は人が UI で承認するまで
リクエストを止める意味です。srt の判定はホスト名単位の `allow` / `deny` の 2 値で、
承認待ちに相当するものはありません。そこで `review` を機械的に置き換えます。

- 開く側では、`review` を含むスコープのホストを `allowedDomains` に入れます。
  nas なら人が止められたものが、srt では無条件に通ります。
- 閉じる側では、`review` を含むスコープのホストを `deniedDomains` に入れます。
  nas なら人が通せたものが、srt では通りません。同じスコープ内で nas が無条件に
  `allow` していたパス (Redmine の GET、`asahi-net` 配下の GitHub) も一緒に閉じます。
  srt にはパスの概念が無く、ホスト単位で片方に寄せる以外に手が無いからです。

ホスト名の一致規則は両者で揃っています。`*.example.com` は真部分ドメインだけに一致し
apex には一致しません。ポートを書かなければ全ポートに一致します。したがって `allowed`
スコープの一覧はそのまま写せます。

## 対応表

### ネットワーク

| nas (`global.pkl`) | srt での写し方 | 失われるもの |
| --- | --- | --- |
| 最上位 `fallback = "review"` | 写せない。`allowedDomains` に `*` は書けないので、未列挙ホストは両近似とも `deny` になる | 未知ホストへの初回アクセスを人が判断する経路。作業中に新しいホストを開ける手段が無い |
| `anthropic` スコープの path/method 規則 (`/v1/messages` allow、event log と `/api/eval/*` deny、bootstrap は EmptyBody) | 写せない。`api.anthropic.com` をホスト単位で allow する | event log と eval の遮断。ボディの `UnionShape` / `JsonRoot` 検査。パスで分けた `onMatch` |
| `requestBodyAudit` | 無い | リクエストボディの監査 DB |
| `telemetry` / `google-phone-home` (deny) | `deniedDomains` にそのまま | なし |
| `redmine` (GET allow、他は review、API キーをプロキシが注入) | open: allow。close: deny | open では POST/PUT/DELETE が無承認で通る。close では Redmine が読めない |
| `github-api` (`/repos/asahi-net/**` allow、他は review) | open: allow。close: deny | open では他 org への API が無承認で通る。close では `gh` が使えない |
| `github-git` (asahi-net の git transport allow、他 owner は review) | open: allow。close: deny | open では他 owner への push/fetch が無承認で通る。close では git over HTTPS が使えない |
| `openai-ws` の `webSocket = "allow"` と、他スコープの既定 deny | srt に WebSocket の制御は無い。HTTPS 内の WebSocket は CONNECT トンネルとして通る。`tlsTerminate` を使う open では終端対象ホストの WebSocket が切られるので、`api.openai.com` と `chatgpt.com` を `excludeDomains` に入れて通す | スコープ単位の WebSocket 許可。open では終端していないホストすべてで WebSocket が通る |
| 非 HTTP TCP の遮断 (`tcp_start` で kill) | `deniedDomains` に `*:22` を追加。それ以外のポートへの CONNECT は許可ホストなら通る | 22 番以外の生 TCP の遮断 |
| 内向き IP への解決を拒否する `ip_policy` | `deniedResolvedAddresses` に RFC1918、CGNAT、ULA を列挙。ループバック、リンクローカル、メタデータ IP は srt の既定で拒否 | なし |
| プロキシ CA による TLS 傍受 | open は `tlsTerminate` (実験的機能) を使い、Java 系と OpenAI 系のホストは除外。close は使わない | 後述のシークレット注入以外に傍受の用途が無いので、close では傍受をしない |
| コンテナ内 DNS 無し、プロキシ側で解決 | srt も同じ構造 (`--unshare-net`、ホスト側プロキシで解決) | なし |

### ファイルシステム

nas はコンテナに新しい home を作り、`global.pkl` に列挙したパスだけを bind mount します。
srt はホストのルート全体を読み取り専用で見せるのが起点で、隠したい場所を `denyRead`
で tmpfs に置き換える方式です。方向が逆なので、写し方は近似ごとに変わります。

| nas | open | close |
| --- | --- | --- |
| workspace (`$PWD`) rw | `allowWrite: "."` | 同じ |
| `~/repo` rw、`~/.m2` rw | `allowWrite` | 同じ |
| `~/.gradle.for-agents` を `~/.gradle` に見せる | パスの付け替えは無いので `allowWrite: ~/.gradle.for-agents` とし、ラッパーが `GRADLE_USER_HOME` を向ける | 同じ |
| `~/.claude` rw、`~/.claude.json` rw | `allowWrite` | 同じ |
| ro の extraMounts (`~/nix-config`、`~/.config/nvim` など 8 件) | ルートが ro なので何も書かない | `denyRead: /home` で home 全体を隠し、その 8 件と `~/.nix-profile` のリンク先 (`~/.local/state/nix`)、srt の置き場所 (`~/.npm`) を `allowRead` で戻す |
| それ以外の home は見えない | `denyRead` で鍵の在処だけ隠す (`~/.ssh`、`~/.config/gh`、`~/.password-store`、`~/.config/nas`、`~/.local/share/nas`、`~/.aws`、`~/.config/gcloud`、`~/.netrc`、`~/.docker`、`~/.kube`、`~/.gnupg/private-keys-v1.d`) | home 全体が tmpfs になる。tmpfs は書けるので、キャッシュ類は nas の使い捨て home と同じくセッション限りになる |
| ホストの `/etc`、`/usr`、`/var` などは見えない | 見える | `/root`、`/mnt`、`/media`、`/srv`、`/opt`、`/var/lib`、`/var/log`、`/var/backups`、`/var/mail`、`/var/spool`、`/run/user`、`/etc/ssh`、`/boot` を隠す。`/etc` の残りと `/usr` は隠せない |
| `/nix` rw + daemon socket | ルート経由で ro。daemon socket は `allowAllUnixSockets = true` で到達可 | ro。socket に届かない |
| `.nas/*.pkl` を ro で重ねる | 該当なし | 該当なし |
| `.git/config` は書ける | `allowGitConfig: true` | `false` |

srt には nas に無い必須の書き込み拒否があります。cwd 配下の `.git/hooks`、`.bashrc`
などの rc ファイル、`.mcp.json`、`.vscode`、`.idea`、`.claude/commands`、`.claude/agents`
は、どちらの近似でも書けません。逆に `/tmp/claude`、`~/.npm/_logs`、`~/.claude/debug`
は常に書けます。

### シークレット

| nas | srt での写し方 | 失われるもの |
| --- | --- | --- |
| `github-token` / `redmine-api-key` をホストで解決し、プロキシがヘッダーを注入。コンテナには `injected-by-proxy` の placeholder だけ | open: ラッパーが実値を環境変数に載せ、`credentials.envVars` の `mode: "mask"` でサンドボックス内はセンチネルになる。プロキシが `injectHosts` 宛のヘッダーとボディでセンチネルを実値に置換する。close: 宛先を閉じているので渡さない | `gh` と Redmine スクリプトは環境変数をそのまま送るので open では機能する。ただし git over HTTPS は Basic 認証の base64 の中にセンチネルが入るため置換されず、認証に失敗する (srt の `body-substitution.ts` が明記)。nas の `github-basic` に相当するものは作れない |
| `lines:~/.config/nas/secrets.txt` (`asahi`) を送信ボディでマスク、`forbid` で拒否 | 無い。srt の credentials は「サンドボックスが送るセンチネル」を置換する方向だけで、任意の値を送信から除く方向は無い | リポジトリ内に書かれた既知の秘密値が API リクエストに載ることの防止 |
| `mask.filter = true` (bash の stdout/stderr から秘密値を消す) | 無い | 出力側のマスク。同じ目的の Claude Code hook 版が `proposal/` にあり、srt と併用はできる |
| `mask.proxy = true` | 上記のとおり方向が逆なので無い | 同上 |
| `mask.maskfs = false` | 元から無効 | なし |

### 環境変数

`global.pkl` の `env` は `srt-claude.sh` に写しました。srt は起動元の環境をそのまま
サンドボックスへ継承するので、ラッパーは `env -i` で一度空にしてから必要なものだけを
渡します。差分は次のとおりです。

- `GIT_CONFIG_COUNT` 系で `gpg.program = gpg` を渡す経路は使えません。srt が
  `git.safeDirectories` を同じ変数群で注入し、上書きするからです。必要なら
  `~/.config/git/config` に書きます。
- `GRADLE_OPTS` / `ANT_OPTS` のプロキシ指定は外しました。srt はプロキシへ認証が要るので、
  Java のシステムプロパティで向けても 407 になります。srt が `JAVA_TOOL_OPTIONS` に
  javaagent を入れて処理する前提です。
- `PATH` の suffix は静的に展開して書きました。`valCmd` は bash の式に置き換えました。

### ホストコマンド実行 (`hostexec`)

srt にはサンドボックスからホストへ処理を依頼する経路がありません。`hostexec` 一式が
そのまま失われます。

| nas の規則 | 帰結 |
| --- | --- |
| `hostexec <任意>` を承認付きで実行 | 無い |
| `gpg --status-fd=2 -bsau <keyid>` を無承認でホスト実行 (commit 署名) | open: `allowAllUnixSockets = true` なら gpg がホストの gpg-agent socket に届き、サンドボックス内で署名できる。`~/.gnupg` は読めるが `private-keys-v1.d` は隠している。close: 署名できない |
| `gcloud` を承認付きでホスト実行 | 無い。`~/.config/gcloud` も隠しているので `gcloud` は使えない |
| `nas hook` による通知 | 無い |

### Docker と Nix

| nas | open | close |
| --- | --- | --- |
| セッション専用の rootless DinD sidecar。ネットワークはプロキシ経由 | `allowAllUnixSockets = true` なので `/var/run/docker.sock` に届き、ホストの Docker daemon を使う。コンテナはホストのネットワークで動き、srt のプロキシを通らない。ホスト daemon への到達はホスト root 相当の権限に等しい | AF_UNIX の `socket()` が seccomp で EPERM になるので `docker` は使えない。TCP の `DOCKER_HOST` も無い |
| `/nix` rw と daemon socket。ビルドはホストの daemon が行う | daemon socket に届くので `nix` は動く。daemon が行うダウンロードはホスト側の通信であり、srt の allowlist を通らない | daemon に届かないので `nix build` / `nix develop` は使えない。既にある store path の実行だけができる |

`allowAllUnixSockets = true` は、nas が分離していた socket 全部 (Docker、gpg-agent、
ssh-agent、D-Bus session、X11) に手が届くという意味です。open で Nix と Docker と
gpg 署名を残すための代償として置いています。

### セッション、UI、記録

| nas | 帰結 |
| --- | --- |
| `session.multiplex` (dtach でデタッチ可能) | 無い。必要なら `dtach` や `tmux` の中で `srt-claude.sh` を起動する |
| `ui` (承認、セッション一覧、端末、ポート、監査、履歴) | 無い。srt の出力は `--debug` の stderr だけ |
| `observability` (OTLP 受信、`history.db`) | 無い |
| `guide` (制約を説明する skill を `--add-dir` で注入) | 無い。ホスト名で拒否されたときの見え方 (名前解決失敗) は同じなので、必要なら CLAUDE.md に一文書く |
| `direnv` (コンテナ内で `.envrc` を評価、未 allow なら起動拒否) | 無い。`direnv exec "$PWD" srt ...` とすればホスト側で評価した環境が入るが、その場合 `env -i` の遮断と両立しない |
| `display.sandbox = "none"` | 同じ。`DISPLAY` を渡していないので X は見えない |
| `--dangerously-skip-permissions` | 同じ。ラッパーで渡す |
| ユーザー名と uid をホストに合わせる | bwrap の `--unshare-user` で所有者が nobody に見える。`git.safeDirectories = ["*"]` で git の dubious ownership を抑える |

## 失われるものの要約

両近似で共通して失われるものは次の 6 つです。

1. 人が承認する経路。未知ホスト、Redmine の書き込み、asahi-net 以外の GitHub、
   `hostexec` の全部がここに含まれます。
2. パス、メソッド、ボディに基づく規則。event log と eval の遮断、content block の
   タグ検査、bootstrap の空ボディ確認が無くなります。
3. リポジトリ内の既知の秘密値に対するマスク (送信側と出力側の両方) と監査 DB。
4. hostexec 経由のホスト実行 (`gcloud`、任意コマンド、通知 hook)。
5. git over HTTPS の Basic 認証へのトークン注入。
6. UI、observability、guide、direnv、多重化。

開く側だけで緩むものは次のとおりです。

- Redmine、api.github.com、github.com への全リクエストが無承認で通ります。
- ホストの Docker daemon、gpg-agent、ssh-agent、D-Bus、X11 の socket に届きます。
  Docker と Nix daemon 経由の通信は srt のプロキシを通りません。
- ホストのルートと home の大半が読めます。隠すのは鍵の在処だけです。
- `tlsTerminate` は実験的機能で、ALPN は `http/1.1` だけです。除外していないホストで
  HTTP/2 前提のクライアントや WebSocket が失敗する可能性があります。

閉じる側だけで失うものは次のとおりです。

- Redmine、`gh`、GitHub への git over HTTPS が一切使えません。
- Docker、`nix build` / `nix develop`、commit 署名が使えません。
- `.git/config` が書けません。

## 実測結果

Debian 12 のホストで、`npx -y @anthropic-ai/sandbox-runtime@0.0.76` を使い、各設定の
サンドボックス内で `probe.sh` を実行した結果です。open はラッパーと同じく
`GITHUB_TOKEN` と `REDMINE_API_KEY` の実値を環境に載せて実行しました。

| 検査 | open | close |
| --- | --- | --- |
| `ls ~` | ホスト home の全項目 | `.cache .claude .claude.json .config .gradle.for-agents .local .m2 nix-config .nix-profile .npm .playwright repo` のみ |
| `ls /home` / `ls /opt` | 他ユーザーも見える / 見える | 自分だけ / 空 |
| `~/.ssh`、`~/.config/gh`、`~/.password-store`、`~/.config/nas` の項目数 | 0 (tmpfs) | 0 |
| `~/.gnupg` / その `private-keys-v1.d` の項目数 | 164 / 0 | 0 / 0 |
| `~/.claude.json` への追記、`~/.claude` への作成 | 可 | 可 |
| `~/.nix-profile/bin/bwrap` (シンボリックリンク先) | 見える | 見える |
| cwd、`/tmp` への書き込み | 可 | 可 |
| `.git/config` への追記 | 可 | 不可 |
| `git status` (safe.directory) | 成功 | 成功 |
| `https://api.anthropic.com/` | 404 (到達) | 404 |
| `https://raw.githubusercontent.com/` (open は TLS 終端対象) | 301 | 301 |
| `https://github.com/`、`https://api.github.com/` | 200 | 403 (拒否) |
| `https://project.asahinet.com/` | 302 | 403 |
| `https://example.com/` (未列挙)、datadog (deny) | 403 | 403 |
| CONNECT `github.com:22` / `:443` | 403 / トンネル成立 | 403 / 403 |
| `nix store ping` | 成功 | 失敗 |
| `docker version` | ホスト daemon 29.6.1 | 失敗 |
| `gpg-connect-agent /bye` | 成功 | 失敗 |
| サンドボックス内の `GITHUB_TOKEN` | `fake_val...` のセンチネル | 未設定 |
| `gh api user` | 成功 (ヘッダーの置換が効いた) | 対象外 |
| `X-Redmine-API-Key: $REDMINE_API_KEY` で `users/current.json` | 200 (ヘッダーの置換が効いた) | 対象外 |

このうち `~/.ssh` などを `ls` すると成功して空に見える点には注意が要ります。srt の
`denyRead` は tmpfs を重ねる方式なので、「無い」ではなく「空」に見えます。

## 未検証の事項

- git over HTTPS の Basic 認証が失敗すること。srt の `body-substitution.ts` が base64 化された
  センチネルを置換しないと明記しているので、設計上は失敗しますが、実測はしていません。
- srt の Java agent が Gradle / Maven のプロキシ認証を実際に処理すること。
- Claude Code 本体を open / close の下で起動して一往復させること。ネットワークとファイル
  の到達性は上表で確認済みですが、Claude Code の起動そのものは試していません。
- Claude Code が event log を送らなくなる環境変数があるか。あるなら open / close とも
  ラッパーに足すことで、nas の deny 規則に近づけられます。
