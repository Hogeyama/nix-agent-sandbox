# dind-bridge

nas を使わずに Dev Container で Claude Code を動かすときに、Claude Code の Bash sandbox の中から rootless DinD の Docker を使えるようにする。Docker API の操作（`docker run` や `docker build`）と、起動したコンテナの公開 TCP ポート（`docker run -p`）への接続が sandbox の中で動く。Testcontainers のように、公開ポートへ `127.0.0.1` で接続するライブラリもそのまま動く。

nas の DinD bridge を単体で配布するもので、Node.js 22 以上で動く 1 ファイルの実行ファイルとして配る。

## 仕組み

Claude Code の sandbox は、Bash ツールのコマンドごとに新しい network namespace を作る。その中には loopback しかなく、外の Docker にも、コンテナの公開ポートにも TCP では届かない。届くのは UNIX socket だけである。

dind-bridge は次の 3 つの部品でこれをつなぐ。

- **serve**: agent コンテナで常駐する。DinD の Docker socket と、DinD の sidecar の公開ポートへの接続を、UNIX socket 越しに提供する（gateway）。agent コンテナ自身の namespace にも、Docker API を `127.0.0.1:2375` で提供する。
- **relay**: sandbox の namespace の中で動く。Docker API を `127.0.0.1:2375` で受け、公開ポートを同じ番号で `127.0.0.1` に再現し、どちらも serve の UNIX socket へ中継する。namespace に他のプロセスが残っていなければ自分で終わる。
- **env file**: Claude Code が Bash ツールのコマンドの直前に実行する snippet（`CLAUDE_ENV_FILE`）。sandbox の namespace で relay が動いていなければ起動する。sandbox の外では何もしない。

`DOCKER_HOST=tcp://127.0.0.1:2375` は sandbox の中でも外でも同じ値で動く。

## 前提にする構成

- agent コンテナと rootless DinD の sidecar は別のコンテナにし、sidecar は internal network にだけ接続する。
- sidecar の Docker socket を volume で共有し、agent 側では read-only でマウントする。
- sidecar の dockerd は UNIX socket だけで待ち受ける。
- Claude Code の sandbox で `allowAllUnixSockets` を有効にする。無いと sandbox の中で Node.js 自体が起動しない。

agent と sidecar の network namespace は共有しない。Dev Container では、agent の namespace に Claude Code 本体のための外向きの経路がある。sidecar をそこに入れると、DinD のコンテナが sandbox の proxy を通らずにその経路を使えてしまう。

## 設定例

以下は構成の例で、名前やパスは環境に合わせて変える。

### `.devcontainer/compose.yaml`

```yaml
services:
  agent:
    build: .
    command: sleep infinity
    environment:
      DOCKER_HOST: tcp://127.0.0.1:2375
    volumes:
      - ..:/workspace
      - dind-run:/var/run/dind:ro
    networks: [default, dind]
    depends_on: [dind]

  dind:
    image: docker:dind-rootless
    privileged: true
    # entrypoint が足す TCP の待ち受けを付けないよう、command を dockerd から書く。
    command: ["dockerd", "--host=unix:///run/user/1000/docker.sock"]
    volumes:
      - dind-run:/run/user/1000
      - dind-data:/home/rootless/.local/share/docker
    networks: [dind]

networks:
  dind:
    internal: true

volumes:
  dind-run:
  dind-data:
```

agent からは `/var/run/dind/docker.sock` が sidecar の Docker socket になり、公開ポートには `dind:PORT` で届く。

### `.devcontainer/Dockerfile`

```dockerfile
# Node.js 22 以上の入ったイメージ。Claude Code を npm で入れるイメージなら入っている。
FROM node:22-bookworm

ARG DIND_BRIDGE_VERSION=0.1.0
# リリースに添付された dind-bridge.sha256 の値
ARG DIND_BRIDGE_SHA256=...
RUN curl -fsSLo /usr/local/bin/dind-bridge \
      https://github.com/Hogeyama/nix-agent-sandbox/releases/download/dind-bridge-v${DIND_BRIDGE_VERSION}/dind-bridge \
 && echo "${DIND_BRIDGE_SHA256}  /usr/local/bin/dind-bridge" | sha256sum -c - \
 && chmod 755 /usr/local/bin/dind-bridge \
 && mkdir -p /etc/dind-bridge \
 && dind-bridge env-file \
      --socket /run/dind-bridge/bridge.sock \
      --api tcp://127.0.0.1:2375 \
      --publish-ip 0.0.0.0 \
      > /etc/dind-bridge/env.sh \
 && install -d -m 700 -o node -g node /run/dind-bridge

COPY dind-bridge-entrypoint.sh /usr/local/bin/
# serve と Claude Code は同じ user で動かす。serve の socket はその user にしか開かない。
# sidecar の rootless dockerd も uid 1000 なので、Docker socket にもこの user で届く。
USER node
ENTRYPOINT ["/usr/local/bin/dind-bridge-entrypoint.sh"]
```

`env-file` は、その時点の `node` と `dind-bridge` の絶対パスを snippet に書き込む。どちらかを移したら作り直す。

### `.devcontainer/dind-bridge-entrypoint.sh`

serve はコンテナの起動のたびに entrypoint から起動する。`ready` を読んでから元のコマンドを実行するので、Dev Container が使い始める時点で Docker が使える。

```sh
#!/bin/sh
set -eu
fifo=$(mktemp -u /run/dind-bridge/ready.XXXXXX)
mkfifo -m 600 "$fifo"
dind-bridge serve \
  --socket /run/dind-bridge/bridge.sock \
  --docker-host unix:///var/run/dind/docker.sock \
  --publish-host dind \
  --publish-ip 0.0.0.0 \
  --api tcp://127.0.0.1:2375 > "$fifo" &
read -r ready < "$fifo" || ready=
rm -f "$fifo"
if [ "$ready" != ready ]; then
  echo 'dind-bridge: serve did not start; Docker is unavailable' >&2
fi
exec "$@"
```

`/run/dind-bridge` は dind-bridge 専用の directory にする。serve は起動時に、そこに前回の serve が残した socket を消す。serve が落ちても起動し直す仕組みは持たない。Bash ツールのコマンドが `dind-bridge: relay unavailable` と警告するようになったら、コンテナを再起動する。

### `.claude/settings.json`

```json
{
  "env": {
    "CLAUDE_ENV_FILE": "/etc/dind-bridge/env.sh"
  },
  "sandbox": {
    "enabled": true,
    "network": {
      "allowAllUnixSockets": true
    }
  }
}
```

`CLAUDE_ENV_FILE` は Claude Code の Bash ツールのコマンドにだけ効く。Claude Code が bash と zsh のどちらを使っても読まれる。SessionStart などの hook には別のファイルが渡されるので、hook が環境変数を書き出す設定とも共存できる。

sandbox の中では、Bash ツールのコマンドごとに network namespace が新しくなるので、コマンドごとに relay の起動が走る。Docker を使わないコマンドもこの時間を払う。

## イメージの取得

sidecar は internal network にしかつながっていないので、イメージを取得できない。ホストで取得したイメージを tar にして読み込む。

```sh
# ホストで
docker pull postgres:16
docker save -o images.tar postgres:16
# Dev Container の中で（sandbox の外でも中でもよい）
docker load -i images.tar
```

## Testcontainers

- Testcontainers は ryuk のイメージも使う。上と同じ手順で事前に読み込むか、`TESTCONTAINERS_RYUK_DISABLED=true` で ryuk を使わない。
- ryuk は Docker の socket を bind mount する。`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` に、sidecar の中で dockerd が待ち受ける path（上の例では `/run/user/1000/docker.sock`）を渡す。

## 公開ポートについて

- relay が再現するのは、dockerd が `--publish-ip` のアドレス（上の例では `0.0.0.0`）で公開したと報告したポートだけである。`-p 127.0.0.1:8080:80` のように公開アドレスを指定したポートは再現しない。
- Docker API が `127.0.0.1:2375` を使うので、コンテナがポート 2375 を公開すると、そのポートは再現されず、`docker run` / `docker start` がエラーを返す。

## 境界

- 主な境界は、sidecar が internal network にしかつながっていないことにある。sandbox の中のコマンドは Docker API をそのまま使えるので、DinD のコンテナを通じて sidecar ができることは何でもできる。sidecar から外に出る経路が無ければ、sandbox の proxy を迂回する経路も生まれない。
- gateway は `--publish-host` の任意のポートに接続する。そこで待ち受けるのがコンテナの公開ポートだけである、というのが前提で、dockerd が TCP で待ち受けるとこの前提が崩れる。上の例では dockerd は UNIX socket だけで待ち受ける。加えて agent 側の firewall で sidecar の 2375 と 2376 を落とすと、二重の防御になる。
- `allowAllUnixSockets` を有効にすると、sandbox の中のコマンドはコンテナの中の全ての UNIX socket に接続できる。VS Code が作る socket もその対象に含まれる。

## コマンド

```text
dind-bridge serve     --socket PATH --docker-host ENDPOINT [--publish-host HOST]
                      [--publish-ip IP] [--api tcp://127.0.0.1:PORT]
dind-bridge env-file  --socket PATH --api tcp://127.0.0.1:PORT [--instance NAME]
                      [--name-prefix NAME] [--publish-ip IP] [--node PATH] [--script PATH]
dind-bridge ensure    --socket PATH [--instance NAME] [--api tcp://127.0.0.1:PORT]
                      [--publish-ip IP] [--name-prefix NAME]
dind-bridge --version
```

- `--docker-host`: `unix:///PATH` か `tcp://127.0.0.1:PORT`。
- `--publish-host`: gateway が公開ポートに接続する先。sidecar の hostname。
- `--publish-ip`: dockerd が公開ポートについて報告するアドレス。既定値は `--publish-host` と同じ。
- `--api`: Docker API を待ち受ける loopback のアドレス。

## ビルド

```sh
bun contrib/dind-bridge/build.ts --outfile dind-bridge
```

## ライセンス

nas と同じ。
