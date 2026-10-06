# nono と Claude Code を REST 制限付きで使う条件

**Claude 用の配布プロファイルを選び、GitHub の `endpoint_policy` を追加するだけでは、通信全体を許可した REST API に限定できない。** 0.79.0 には Claude の組み込み実行プロファイルがなく、別配布の Claude pack 0.1.4 は既定でネットワークを制限しない。credential route の HTTPS 検査とは別に、一般 forward proxy・別ポート・Unix socket を評価する必要がある。

このページは 2026-10-06 の読取り監査である。[先の実験](README.md)で確認した「同一 HTTPS origin の未許可 REST path を拒否できた」という結果を、Claude の実行環境全体に拡張できるかを調べた。Claude 本体や LLM API は起動していない。

## 監査対象と実行した確認

| 対象 | 固定した版・確認方法 |
| --- | --- |
| nono | 0.79.0、[同版ソース](https://github.com/nolabs-ai/nono/tree/v0.79.0)。binary は先の実験と同じ SHA-256 `e60f06945aba27bef1d8039ef1e24f30603ac5cf2af074111954b6d607b1c7d0` |
| Claude pack | 公開レジストリの `nolabs-ai/claude` 0.1.4。取得した [policy.json](https://registry.nono.sh/api/v1/packages/nolabs-ai/claude/versions/0.1.4/artifacts/policy.json) の SHA-256 は `7605ee6226e4c452587c3663b6b00b9b0609fa2c27ceb961abd7d3a7ed4ab8a0` |
| pack の識別 | [package.json](https://registry.nono.sh/api/v1/packages/nolabs-ai/claude/versions/0.1.4/artifacts/package.json) の SHA-256 は `bc9d925d7e9f6b91564b490ccc8fd531a5802a0ca942795e683644aacf2e5171`。`min_nono_version: 0.63.0`、短縮名 `claude`、別名 `claude-code` |
| 構文・継承 | 取得済み policy ファイルに対する `nono profile validate` と `profile show` は成功。Linux 用の group を含む 28 group の参照が有効 |
| 内蔵 profile | 独立 XDG 環境で `profile list` は 9 件。Claude はなく、`profile show claude-code` は exit 1 / `Profile not found` |

公開 artifact は HTTPS で取得し、レジストリの digest と照合した。署名 bundle の暗号学的検証や pack のインストールはしていない。各 nono コマンドには `PATH`、元の `HOME`、`USER`、`LANG` と一時 XDG ディレクトリだけを渡し、移行を無効にした。親の token・proxy 環境変数は継承せず、秘密ファイルを読んでいない。

pack に付属する初期化スクリプトはホスト権限で Claude のディレクトリを作る。インストーラも既存 `~/.claude` の plugin・設定を書き換えるため、今回はファイルの取得と表示だけに留めた。[初期化スクリプト](https://registry.nono.sh/api/v1/packages/nolabs-ai/claude/versions/0.1.4/artifacts/bin/ensure-dirs.sh)、[インストール先の定義](https://registry.nono.sh/api/v1/packages/nolabs-ai/claude/versions/0.1.4/artifacts/package.json)を参照。

## Claude pack の既定権限

実行プロファイルと、同名のネットワーク設定を区別する。Claude 実行プロファイルの内蔵版は v0.43.0 に削除された。[builtin.rs:24–29](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/profile/builtin.rs#L24-L29)

取得した pack の `network` は `{"block": false}` だけで、`network_profile`、`allow_domain`、`credentials`、`custom_credentials` を指定しない。継承元 `default` もネットワーク制限を追加しない。**この pack 単体には、GitHub の相手 repo・REST path・HTTP method の境界がない。** [pack policy の55行目](https://registry.nono.sh/api/v1/packages/nolabs-ai/claude/versions/0.1.4/artifacts/policy.json)、[default 定義](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/data/policy.json#L669-L711)

一方、明示的に `network.network_profile: "claude-code"` を選ぶと、内蔵のネットワーク設定が適用される。こちらは LLM API、package registry、GitHub、GitLab、Sigstore、ドキュメントサイトのホストを許す。GitHub group には `api.github.com` のほか `github.com`、`raw.githubusercontent.com`、`codeload.github.com`、`ghcr.io` などが含まれる。これらのホスト許可は、一つの repo の REST 許可にはならない。credential はこのネットワーク設定だけでは有効にならない。[network-policy.json:7–87,143–152](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/data/network-policy.json#L7-L152)

Linux の filesystem 許可も、秘密を持たない最小環境とは異なる。

| 範囲 | pack と継承元が宣言する権限 |
| --- | --- |
| 作業ディレクトリ | `workdir.access: readwrite`。実際の共有は `--allow-cwd` 等の起動指定も確認する |
| Claude 状態 | `~/.claude`、`~/.local/state/claude/locks`、`~/.cache/claude`、`.claude.json` と lock ファイル、`/tmp/claude-$UID` などへ読書き |
| Claude 配布・保存先 | `~/.local/share/claude` は group 経由で読取り |
| エディタ | `~/.vscode`、`~/.config/Code` へ読書き |
| runtime・設定 | `/nix/store`、Node/Python/Rust runtime、git 設定などを読取り |
| 一時領域 | 継承した `system_write_linux` が `/tmp`、`$TMPDIR` への書込みを許す |
| socket | `/run/systemd/userdb` の socket 接続、`$XDG_RUNTIME_DIR/cc-socks` の bind 許可。pathname socket の明示 mediation は既定 off |

[pack policy](https://registry.nono.sh/api/v1/packages/nolabs-ai/claude/versions/0.1.4/artifacts/policy.json)、[Linux group 定義](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/data/policy.json#L311-L582)、[Unix socket mediation の既定値](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/profile/mod.rs#L2130-L2151)。表は設定宣言の監査結果であり、各パスの実効アクセスを試した結果ではない。必須 deny group、存在しないパスの扱い、追加の起動引数も実効権限に影響する。

## REST policy と一般通信の合成

`custom_credentials` は route の定義であり、定義しただけでは有効にならない。`network.credentials` に route 名を指定する必要がある。同名なら custom 定義が内蔵 credential 定義に優先する。[network_policy.rs:177–251](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/network_policy.rs#L177-L251)

その route に `endpoint_policy.default.decision: deny` と許可 method/path を設定すると、route に対応する HTTPS 通信で policy が評価される。しかし、次の理由から通信全体の deny-by-default とは同義にならない。

1. **一般許可先が空なら、通常の session proxy は allow-all。** credential だけ追加する構成でも、空リストを「その他を拒否」とは解釈しない。[server.rs:1179–1192](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/server.rs#L1179-L1192)
2. **一般許可リストを有効にすると、credential upstream のホストも自動追加する。** `api.github.com:443` に加えて裸の `api.github.com` まで追加するため、一般 filter からその origin を除いたつもりの設定にも穴が残る。無関係のホスト一つを許す方法でも同じ処理を通る。[proxy_runtime.rs:2440–2482](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/proxy_runtime.rs#L2440-L2482)
3. **通常の `allow_domain` の port 指定は制限にならない。** `api.github.com:443` と書いても port を取り除く。TLS route の照合はホストと port で行うため、一般 filter と照合範囲が異なる。[network_policy.rs:395–404](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/network_policy.rs#L395-L404)、[TLS route 照合](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/tls_intercept/handle.rs#L405-L414)
4. **plain HTTP の forward 処理は別経路。** credential route の method/path 評価を一般 HTTP 転送へ自動適用する構造ではない。[handle_forward_http](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/server.rs#L1987)
5. **Unix socket は TCP proxy と別境界。** proxy-only にしても、既定の AF_UNIX mediation off では supervisor が AF_UNIX 操作を通す。`linux.af_unix_mediation: "pathname"` で明示 socket 許可を評価する設計になっている。[supervisor_linux.rs:713–738](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/exec_strategy/supervisor_linux.rs#L713-L738)

通常の profile schema に `network.strict_filter` や `network.proxy.strict_filter` はない。内部の `ProxyConfig.strict_filter` をそのまま JSON に書くことはできない。また `network.block: true` と session credential の併用は起動時に矛盾として拒否する。[NetworkConfig](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/profile/mod.rs#L1777-L1884)、[起動検証](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/sandbox_prepare.rs#L917-L969)

`deny_domain` は `host:port` を保持するので、既知の別ポートを個別に拒否できる。ただし一般 filter と credential 用 filter の両方に同じ deny を適用するため、ホスト全体を deny して credential route だけ例外にする設定にはならない。調べた設定には「この host の443番以外をすべて拒否する」という表現がなく、少数の追加設定で前記の経路をすべて閉じる方法は確認できなかった。[deny の展開](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/network_policy.rs#L352-L375)、[両 filter への適用](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/server.rs#L1179-L1192)

継承にも注意が要る。`network_profile: null` は継承した名前を消せるが、`allow_domain: []` は親の許可先を消さない。domain と endpoint rule は追加合成される。`credentials: []` は親の credential を消す一方、空でない配列は親と合成する。最小権限が目的なら、継承先の設定だけで判断せず、解決後の profile を確認する。[merge_profiles](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/profile/mod.rs#L3800-L3852)、[merge_allow_domain](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/profile/mod.rs#L4003-L4046)

## 採用候補にするための構成

現時点で「これを貼れば安全」とする session profile は提示できない。次の条件を満たす構成を候補とし、正常系と迂回経路を同時に再検証する。

- **Claude の API 通信と業務 API を分ける。** Claude が利用する認証方式に必要な LLM API origin と、GitHub の限定 REST route を別に定義する。GitHub だけを許可しても Claude は推論できない。逆に広い LLM・GitHub group を選ぶと許可先が増える。Claude の API key/OAuth credential が子に読める構成か、proxy 側だけに保持する構成かも独立に決める。
- **GitHub route は default deny と完全な method/path 許可で作る。** `https://api.github.com` を upstream とし、必要な `/repos/Hogeyama/nix-agent-sandbox/...` だけを許可する。`POST /graphql` は許さない。ただし、この route 設定だけでは前節の一般通信を閉じられない。
- **アプリ用 credential は管理側に置く。** 子の環境変数は明示 allowlist にし、token 値や credential ファイルを filesystem 許可に含めない。`~/.claude` に対する pack の読書き許可を、その中の認証情報が隠される保証と解釈しない。`environment.allow_vars` が未指定なら親の環境変数を既定で継承する。[環境設定の定義](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/profile/mod.rs#L2327-L2358)
- **session 全体の一般 proxy と、業務 credential を分離する候補を試す。** command sandbox の専用 proxy は `allowed_hosts` を command の `network.allow_domain` で置き換え、`strict_filter: true` にする。空なら一般通信を拒否し、credential route の到達性は別 filter で扱う。通常 session proxy の upstream 自動追加をそのまま引き継がない。[command proxy 構築](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/proxy_runtime.rs#L3194-L3240)、[route filter](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/server.rs#L1188-L1192)
- **filesystem と IPC も専用化する。** pack の broad な状態・エディタ・一時領域を必要性に応じて見直し、pathname socket mediation を有効にする。Claude の通常実行、OAuth 更新、TLS trust、streaming、MCP 等との互換性は、この監査では確認していない。

command sandbox の業務 proxy を狭くしても、Claude 本体や他の子が持つ session proxy の権限までは消えない。どのプロセスも任意コードを実行しうる脅威モデルでは、外側の一般通信にも同じ迂回検証が必要である。

## command sandbox の起動失敗

先の実験の `cannot open / for Refer grant` は、業務 API の拒否ではなく、子の起動前の失敗である。ソースでは command launcher が sandbox を適用した後、実行ファイル制限の Landlock layer を追加し、その中で `PathFd::new("/")` を呼ぶ。[launcher:924–942](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/tool-sandbox/platform/linux.rs#L924-L942)、[失敗箇所:1463–1475](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono/src/sandbox/linux.rs#L1463-L1475)

**musl 向け binary の `O_PATH` の扱いが原因の有力候補である。** nono 本体は別の Landlock grant 作成箇所で、musl の `OpenOptions::custom_flags` が `O_PATH` を落として通常の read open にする問題を明記し、直接 `open` を使って回避している。一方、この失敗箇所が使う landlock 0.4.7 の `PathFd::new` はその `OpenOptions` を使っている。[nono の回避実装:684–691](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono/src/sandbox/linux.rs#L684-L691)、[landlock 0.4.7:524–534](https://docs.rs/landlock/0.4.7/src/landlock/fs.rs.html#524-534)、[Linux release target](https://github.com/nolabs-ai/nono/blob/v0.79.0/.github/workflows/release.yml#L50)

この原因はソースからの推論で、syscall trace や別ビルドによる確定・修正確認はしていない。`/` 全体の読取り許可で起動だけ通すと filesystem 保護を広げるため、採用候補の解決策には数えない。command sandbox を成立させた上での REST-only 検証は引き続き必要である。

今回は資料と設定の監査のみで、nas の実行コードや設定を変更していない。nas のテストスイートは実行していない。
