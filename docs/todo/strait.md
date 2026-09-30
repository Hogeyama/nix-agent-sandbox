strait の未解決の課題です。2026-09-30 に strait の中で sumi v0.3.0 をリリースしようとして、途中でホストへ作業を渡すことになった。その時に詰まったものを並べる。

**Artifacts が推論専用トークンで通るか未確認**

Artifacts は `api.anthropic.com` の `/v1/code/agent-proxy/frame/...` に送られ、strait の許可リストにないので承認待ちになる（2026-09-30 に拒否された時の応答は 403 `GET /v1/code/agent-proxy/frame/frames is not a Claude Code endpoint`）。送り先は Claude Code 2.1.284 のバイナリから読み取った。`/api/frame/...` を `/v1/code/agent-proxy/frame/...` に書き換えて送っている。承認して通したときに、推論専用のトークン（`CLAUDE_CODE_OAUTH_TOKEN`）で受け付けられるかは未確認。受け付けられるなら、承認を 1 件ずつ求めずに済むよう、許可リストへ入れるかを決める。

**hostexec を実際のサンドボックスの中で試していない**

`hostExec`（[README](../../contrib/strait/README.md) の「Running commands on the host」）は、bwrap を使えないコンテナの中で、bwrap 抜きに srt のプロキシ、承認、ホストでの実行、応答までを通して確かめただけ。Linux のホストで、次の 2 つを確かめる。

- `strait-hostexec`（bun と curl で動く）が bwrap の中で起動するか。既定の `denyRead` には `/tmp` が入っている。
- 2026-09-30 にホストへ渡した `nix build .#sumi`、`bun run test:sumi`、`python3 docs-site/editorial/check-pkl.py` がこれで通るか。

**Remote Control が使えない**

`/remote-control` は、`CLAUDE_CODE_OAUTH_TOKEN` で渡された長期トークンを推論専用として扱い、送信前に拒否する。strait は本物のトークンをサンドボックスに入れないためにこの変数を使っているので、原理的に解けない。中で `claude auth login` するとフルスコープのトークンが中に残るので採らない。
