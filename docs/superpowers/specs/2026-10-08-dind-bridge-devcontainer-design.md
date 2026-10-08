# nas を使わない Dev Container で DinD bridge を使う

## 利用者ができること

nas を使わずに Dev Container で Claude Code を動かす利用者が、Claude Code の Bash sandbox の中から rootless DinD の Docker を使える。Docker API の操作と、起動したコンテナの公開 TCP ポートへの接続が動く。nas の DinD bridge を汎用化し、`contrib/dind-bridge` として単体で配布する。Dockerfile は sumi と同じく release asset を取得して使う。

## 前提にする構成

- agent コンテナと rootless DinD の sidecar は別のコンテナにする。sidecar は internal network にだけ接続する。
- sidecar の Docker socket を volume で共有し、agent 側では read-only でマウントする。
- sidecar の dockerd は UNIX socket だけで待ち受ける。command を `dockerd` から書き、image の entrypoint が足す TCP の待ち受けを付けない。
- Claude Code の sandbox は `allowAllUnixSockets` を有効にする。sandbox の中では、許可された場所以外に file を書けない。

agent と sidecar で netns を共有する nas の構成は採らない。nas では、共有する netns から外に出る経路が mitmproxy の container だけなので、共有しても新しい外向き経路は生まれない。Dev Container では、agent の netns に Claude Code 本体のための直接の外向き経路がある。sidecar がその netns に入ると、inner container が sandbox の proxy を通らずにその経路を使えるようになる。agent の user と sidecar の rootless user はどちらも uid 1000 なので、iptables の owner match でも区別できない。

## 構成

nas の bridge の gateway、relay、ensure をそのまま使い、次の点を設定できるようにする。nas から使うときの既定値は今の動作と同じにする。

- gateway の Docker 接続先として、`tcp://127.0.0.1:PORT` に加えて `unix:///PATH` を受け付ける。
- gateway が公開ポートに接続する先を `--publish-host` で指定できるようにする。Dev Container では sidecar の hostname を渡す。
- relay が `/containers/json` から公開ポートを選ぶときのアドレスを `--publish-ip` で指定できるようにする。nas では gateway の接続先と同じ値だが、Dev Container では dockerd が報告する `0.0.0.0` と sidecar の hostname が別の値になる。
- relay が Docker API を `--api tcp://127.0.0.1:PORT` で提供できるようにする。nas の relay は `/tmp` の下に directory と UNIX socket を作るが、Dev Container の sandbox はそこへの書き込みを許さない。TCP なら file を書かずに済み、`DOCKER_HOST` を compose に固定で書ける。namespace の loopback には、その namespace の中からしか接続できない。

`dind-bridge.mjs` は entry だけにし、gateway と引数の処理を別の module に移す。1 file に bundle すると、全 module の `import.meta.url` が bundle 自身を指す。そのため、entry かどうかを `import.meta.url` で判定している今の作りでは、nas の entry が bundle の中でも起動してしまう。

`contrib/dind-bridge` の CLI は nas の bridge の CLI に次を足す。

- `--version`: `dind-bridge X.Y.Z` を出力する。
- `bash-env`: `BASH_ENV` で読む snippet を出力する。snippet は、serve が記録した namespace と現在の namespace が違い、relay の abstract socket の名前が `/proc/self/net/unix` に無いときだけ `ensure` を呼ぶ。`ensure` が失敗したら警告を出し、コマンドは続ける。Dockerfile で一度だけ生成し、引数はその時点の値を snippet に書き込む。`--api` を必須にする。
- `serve` の前処理: socket ごとの abstract lock で多重起動を防ぐ。lock を取れたら、前回の serve が残した socket を消し、自分の namespace を socket と同じ directory の `base-netns` に書く。container を再起動すると process は消えるが、`/run` の file は残ることがある。

## 配布

`bun build --target=node` で 1 file に bundle し、shebang 付きの `dind-bridge` として配る。bundle は約 23 KB で、Node.js 22 以上で動かす。Claude Code を npm で入れる Dev Container の image には Node.js が入っている。`bun build --compile` の binary は 80 MB を超え、relay を起動し直すときの argv の扱いも変わるので採らない。

release は sumi と同じ形にする。`dind-bridge-vX.Y.Z` の tag で workflow が起動し、VERSION と CHANGELOG と tag の一致を検査する。`--latest=false` で作成し、rolling の `dind-bridge-latest` も更新する。asset には sha256 の file を添え、README の Dockerfile の例では tag を固定して sha256 を検証する。

## 境界

- gateway は `--publish-host` の任意のポートに接続する。認可の前提は、その host で待ち受けるのがコンテナの公開ポートだけであることにある。dockerd が TCP で待ち受けるとこの前提が成り立たないので、README の構成では待ち受けを無くす。agent 側の firewall で 2375 と 2376 を DROP するのは二重の防御として勧める。
- `allowAllUnixSockets` を有効にすると、sandbox の中のコマンドはコンテナの中の全ての UNIX socket に接続できる。VS Code が作る socket もその対象に含まれる。README にこの帰結を書く。
- DinD の外向き通信は bridge の責務にしない。internal network の sidecar には image を取得する経路がないので、ホストで `docker save` した tar を起動時に `docker load` する手順を README に示す。
- nas の bash wrapper に埋め込まれた hook は `bash-env` と共通化しない。wrapper はマスクと一体で動いており、変更すると nas の既存の挙動を壊す危険がある。
- この repository には、特定の利用者の repository や組織の名前を残さない。

## 検証

nas の bridge の unit test に、UNIX socket の Docker 接続先、公開 IP と接続先を分けたときのポートの再現、TCP の API、未知の引数の拒否を足す。既存の test は既定値のまま通す。

`contrib/dind-bridge` の unit test で、`--version`、`bash-env` の snippet の分岐（marker が無い、同じ namespace、relay が生存、`ensure` の失敗、`set -u` の shell）、serve の多重起動防止と残った socket の扱いを確かめる。bundle を Node.js で動かし、serve と ensure を通す test も置く。nix の devShell に Node.js を足し、この test が黙って skip しないようにする。

integration test では、internal network の rootless DinD と、socket を volume で共有した別の agent コンテナを立てる。bwrap で作った namespace から、公開ポートへの接続と停止後の切断を確かめる。

最後に、README の構成の Dev Container をホストで立て、Claude Code の sandbox の中から `docker run -p` と Testcontainers が動くこと、コマンドが終わると relay が終わること、container を再起動しても serve が起動することを確かめる。
