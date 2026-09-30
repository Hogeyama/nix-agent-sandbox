strait の未解決の課題です。2026-09-30 に strait の中で sumi v0.3.0 をリリースしようとして、途中でホストへ作業を渡すことになった。その時に詰まったものを並べる。

**Artifacts が推論専用トークンで通るか未確認**

Artifacts は `api.anthropic.com` の `/v1/code/agent-proxy/frame/...` に送られ、strait の許可リストにないので承認待ちになる（2026-09-30 に拒否された時の応答は 403 `GET /v1/code/agent-proxy/frame/frames is not a Claude Code endpoint`）。送り先は Claude Code 2.1.284 のバイナリから読み取った。`/api/frame/...` を `/v1/code/agent-proxy/frame/...` に書き換えて送っている。承認して通したときに、推論専用のトークン（`CLAUDE_CODE_OAUTH_TOKEN`）で受け付けられるかは未確認。受け付けられるなら、承認を 1 件ずつ求めずに済むよう、許可リストへ入れるかを決める。

**WebSocket が使えない**

srt 0.0.77 は、TLS 終端したコネクションでの upgrade 要求を `filterRequest` より前に拒否する（`tls-terminate-proxy.js` の `inner.on('upgrade', ...)`、コメントは "WebSocket / non-HTTP over TLS — out of scope for now"）。WebSocket は許可にも承認待ちにも出ずに失敗する。2026-09-30 に strait の中から Artifact を publish したとき、publish は通ったが、そのあとの live watch は接続できなかった。通すには、srt にパッチを当てて upgrade 要求にも `filterRequest` をかけ、許可されたものだけを上流へ中継する必要がある。

**Remote Control が使えない**

`/remote-control` は、`CLAUDE_CODE_OAUTH_TOKEN` で渡された長期トークンを推論専用として扱い、送信前に拒否する。strait は本物のトークンをサンドボックスに入れないためにこの変数を使っているので、原理的に解けない。中で `claude auth login` するとフルスコープのトークンが中に残るので採らない。
