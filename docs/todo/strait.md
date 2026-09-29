strait の未解決の課題です。2026-09-30 に strait の中で sumi v0.3.0 をリリースしようとして、途中でホストへ作業を渡すことになった。その時に詰まったものを並べる。

**Artifacts が推論専用トークンで通るか未確認**

Artifacts は `api.anthropic.com` の `/v1/code/agent-proxy/frame/...` に送られ、strait の許可リストにないので承認待ちになる（2026-09-30 に拒否された時の応答は 403 `GET /v1/code/agent-proxy/frame/frames is not a Claude Code endpoint`）。送り先は Claude Code 2.1.284 のバイナリから読み取った。`/api/frame/...` を `/v1/code/agent-proxy/frame/...` に書き換えて送っている。承認して通したときに、推論専用のトークン（`CLAUDE_CODE_OAUTH_TOKEN`）で受け付けられるかは未確認。受け付けられるなら、承認を 1 件ずつ求めずに済むよう、許可リストへ入れるかを決める。

**ホストでしか動かないコマンドを呼べない**

今回ホストに渡したもの:

- `nix build .#sumi`。`.gitmodules` が開けず（`/dev/null` に置き換えられている）、`path:` 指定では nix daemon のソケットを作れず、clone したものは `~/.cache/nix/fetcher-cache-v4.sqlite` が読み取り専用で失敗した。
- `bun run test:sumi`、`python3 docs-site/editorial/check-pkl.py`。サンドボックスに `zig` と `pkl` がない。

nas の hostexec は PATH 上のラッパーから Unix ソケットでブローカーに繋いでいる。strait ではこの形をそのまま使えない。srt は Linux では seccomp で AF_UNIX を塞いでおり、パスごとの許可（`allowUnixSockets`）は macOS 専用で、Linux では無視される。残る選択肢の `allowAllUnixSockets` は、サンドボックスから見えるすべての Unix ソケットを開けてしまう。

hostexec を MCP として srt の `mitmProxy` に相乗りさせる案は成り立たない。srt 0.0.77 は `tlsTerminate` と `mitmProxy` を同時に指定すると初期化で拒否する（`sandbox-runtime/dist/sandbox/sandbox-manager.js` の `network.tlsTerminate and network.mitmProxy are mutually exclusive`）。strait は TLS 終端を常に有効にしているので、`mitmProxy` は使えない。

残る経路の候補と、それぞれの代償:

- `filterRequest` が自分で作った応答を返せるよう srt に 3 つ目のパッチを当て、`hostexec.strait.invalid` のような架空のホストへの要求を strait が受けて答える。出口は `filterRequest` の 1 か所のままで、サンドボックス内からは curl だけのラッパーで呼べるので、MCP に限らずスクリプトからも使える。代わりに信頼するコードが増え、`selfcheck.ts` にこのパッチを確かめる検査を足す必要がある。
- プロキシを通さない経路。たとえばワークスペース内の要求ディレクトリを strait が監視する。ディレクトリはサンドボックス側が書けるので、ホスト側の読み書きはすべて symlink の差し替えに耐える必要がある。

どちらにしても、作る前に決めること:

- 設定で明示的に有効にしたときだけ動かすか（`strait.json` のキーを増やす）。
- 毎回人が承認するか、nas の hostexec のように規則で自動許可するものを作るか。承認はホスト側の `strait-review` で行う。サンドボックス内のどのプロセスからでも要求を出せるので、Claude Code の permission prompt は境界にならない。
- ホストで動くコマンドにどの環境変数を渡すか。strait 自身の環境には本物の `GH_TOKEN` や OAuth トークンがある。
- 作業ディレクトリ、出力の大きさ、実行時間の上限。

MCP として出す場合は、MCP を話すエージェントからしか使えない。`bun run test` の中から `nix` を呼ぶような、スクリプト経由の透過的な実行はできない。今回ホストに渡したのはどれもエージェントが直接打つ単発のコマンドだったので、それで足りる見込みはある。

**Remote Control が使えない**

`/remote-control` は、`CLAUDE_CODE_OAUTH_TOKEN` で渡された長期トークンを推論専用として扱い、送信前に拒否する。strait は本物のトークンをサンドボックスに入れないためにこの変数を使っているので、原理的に解けない。中で `claude auth login` するとフルスコープのトークンが中に残るので採らない。
