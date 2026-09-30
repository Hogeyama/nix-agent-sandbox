strait の未解決の課題です。2026-09-30 に strait の中で sumi v0.3.0 をリリースしようとして、途中でホストへ作業を渡すことになった。その時に詰まったものを並べる。

**Artifacts を読めない**

2026-10-01 に strait の中から、既存の Artifact の read と publish（更新）を試した。

- Claude Code はまず `api.anthropic.com` の `GET /api/frame/read/<id>` と `GET /api/frame/<id>?via=model_read&...` を送る。許可リストにないので承認待ちになり、承認すると推論専用のトークン（`CLAUDE_CODE_OAUTH_TOKEN`）で通った。ツールは "the permission check passed" と返した。2026-09-30 に拒否された `/v1/code/agent-proxy/frame/...` は、このときは出なかった。
- その次に中身を `<id>.frame.claudeusercontent.com` から取る。strait の許可ホストにないので、承認待ちにもならずに拒否される。publish（更新）は、publish 前の読み込みでこれに当たって拒否された。新しい Artifact の publish は 2026-09-30 に通っている。

通すには `*.frame.claudeusercontent.com` を許可ホストに加える必要がある。サブドメインに任意の文字列を載せられるので、そこが外へ送れる経路になる点を判断する。ただし送り先は Anthropic で、`/v1/messages` でも既に任意の内容を Anthropic に送れる。あわせて `/api/frame/...` を許可リストに入れて、承認を 1 件ずつ求めないようにするかも決める。

**WebSocket が使えない**

srt 0.0.77 は、TLS 終端したコネクションでの upgrade 要求を `filterRequest` より前に拒否する（`tls-terminate-proxy.js` の `inner.on('upgrade', ...)`、コメントは "WebSocket / non-HTTP over TLS — out of scope for now"）。WebSocket は許可にも承認待ちにも出ずに失敗する。2026-09-30 に strait の中から Artifact を publish したとき、publish は通ったが、そのあとの live watch は接続できなかった。通すには、srt にパッチを当てて upgrade 要求にも `filterRequest` をかけ、許可されたものだけを上流へ中継する必要がある。

**Remote Control が使えない**

`/remote-control` は、`CLAUDE_CODE_OAUTH_TOKEN` で渡された長期トークンを推論専用として扱い、送信前に拒否する。strait は本物のトークンをサンドボックスに入れないためにこの変数を使っているので、原理的に解けない。中で `claude auth login` するとフルスコープのトークンが中に残るので採らない。
