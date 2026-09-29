strait の未解決の課題です。2026-09-30 に strait の中で sumi v0.3.0 をリリースしようとして、途中でホストへ作業を渡すことになった。その時に詰まったものを並べる。

**承認の経路がない**

strait は許可リストにないリクエストをすべて拒否し、人が通す手段がない（[README](../../contrib/strait/README.md) の Limits「Deny only」）。今回拒否されたもの:

| 操作 | 拒否した箇所 | 応答 |
|---|---|---|
| `git push` | `github.com` の `git-receive-pack` | 403 |
| `gh release view`（GraphQL） | `api.github.com` の `POST /graphql` | 403 |
| Artifacts | `api.anthropic.com` の `/v1/code/agent-proxy/frame/...` | 403 `GET /v1/code/agent-proxy/frame/frames is not a Claude Code endpoint` |

Artifacts の送り先は Claude Code 2.1.284 のバイナリから読み取った。`/api/frame/...` を `/v1/code/agent-proxy/frame/...` に書き換えて送っている。このパスを許可したときに、推論専用のトークン（`CLAUDE_CODE_OAUTH_TOKEN`）で通るかどうかは未確認。

案: 拒否したリクエストをホスト側で保留し、承認されたら通す。nas のネットワーク承認と同じ形。push と GraphQL はこれで足り、hostexec は要らない。認証情報はプロキシが持ったままにできる。

**ホストでしか動かないコマンドを呼べない**

今回ホストに渡したもの:

- `nix build .#sumi`。`.gitmodules` が開けず（`/dev/null` に置き換えられている）、`path:` 指定では nix daemon のソケットを作れず、clone したものは `~/.cache/nix/fetcher-cache-v4.sqlite` が読み取り専用で失敗した。
- `bun run test:sumi`、`python3 docs-site/editorial/check-pkl.py`。サンドボックスに `zig` と `pkl` がない。

nas の hostexec は PATH 上のラッパーから Unix ソケットでブローカーに繋いでいる。strait ではこの形をそのまま使えない。srt は Linux では seccomp で AF_UNIX を塞いでおり、パスごとの許可（`allowUnixSockets`）は macOS 専用で、Linux では無視される。残る選択肢の `allowAllUnixSockets` は、サンドボックスから見えるすべての Unix ソケットを開けてしまう。

hostexec を MCP として出す案:

- 経路は既存のプロキシに相乗りさせる。srt の `mitmProxy`（指定したドメインをホスト側の Unix ソケットのプロキシへ回す）で、`hostexec.strait` のような架空のホストをホスト側の MCP サーバーへ回せる可能性がある。そうなれば出口は `filterRequest` の 1 か所のままになる。ただし strait は「設定で外部プロキシを足せない」ことを売りにしているので、コードで固定する必要がある。strait の TLS 終端との組み合わせも未確認。
- 承認は MCP とは別にホスト側で行う。サンドボックス内のどのプロセスからでも MCP サーバーを叩けるので、Claude Code の permission prompt は境界にならない。
- MCP を話すエージェントからしか使えない。`bun run test` の中から `nix` を呼ぶような、スクリプト経由の透過的な実行はできない。今回ホストに渡したのはどれもエージェントが直接打つ単発のコマンドだったので、足りる見込み。

**Remote Control が使えない**

`/remote-control` は、`CLAUDE_CODE_OAUTH_TOKEN` で渡された長期トークンを推論専用として扱い、送信前に拒否する。strait は本物のトークンをサンドボックスに入れないためにこの変数を使っているので、原理的に解けない。中で `claude auth login` するとフルスコープのトークンが中に残るので採らない。
