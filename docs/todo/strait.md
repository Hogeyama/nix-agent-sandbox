strait の未解決の課題です。2026-09-30 に strait の中で sumi v0.3.0 をリリースしようとして、途中でホストへ作業を渡すことになった。その時に詰まったものを並べる。

**WebSocket が使えない**

srt 0.0.77 は、TLS 終端したコネクションでの upgrade 要求を `filterRequest` より前に拒否する（`tls-terminate-proxy.js` の `inner.on('upgrade', ...)`、コメントは "WebSocket / non-HTTP over TLS — out of scope for now"）。WebSocket は許可にも承認待ちにも出ずに失敗する。2026-09-30 に strait の中から Artifact を publish したとき、publish は通ったが、そのあとの live watch は接続できなかった。通すには、srt にパッチを当てて upgrade 要求にも `filterRequest` をかけ、許可されたものだけを上流へ中継する必要がある。

**Remote Control が使えない**

`/remote-control` は、`CLAUDE_CODE_OAUTH_TOKEN` で渡された長期トークンを推論専用として扱い、送信前に拒否する。strait は本物のトークンをサンドボックスに入れないためにこの変数を使っているので、原理的に解けない。中で `claude auth login` するとフルスコープのトークンが中に残るので採らない。

**hostexec で独自のプロセスグループを作る子プロセスを止められない**

hostexec のコマンドは独自のプロセスグループで起動し、クライアントの切断時と strait の終了時にグループごと止める。daemon や `setsid` のように独自のセッションやプロセスグループを作る子プロセスはこの外に出るので、止められずにホストに残る。閉じ込めるには cgroup が要る。
