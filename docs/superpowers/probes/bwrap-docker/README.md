# bwrap 内の専用 Docker と Testcontainers のホスト実証

本番 launcher ではなく、NixOS の一台で成立性を調べる独立 probe。
ホストの Docker socket は使用しない。`/nix/store` のツールを読み取り専用で利用し、専用 user/mount/PID/network namespace 内に Docker daemon とテストを置く。
Docker は vfs、独立 bridge、userland proxy を使用する。外向きの経路と RootlessKit の host port forwarding は用意しない。イメージは事前に用意した archive からロードする。

## 確認すること

- 複数 UID の二段 mapping と、内側での tmpfs mount。
- 静的なマスク用 bind mount の取り外しと readonly 解除が拒否される。
- 専用 rootless Docker の起動、UID 0/1234 のコンテナ実行。
- privileged な試験用コンテナは新しい tmpfs を mount できるが、保護 fixture の unmount/remount は拒否される。
- cap0 の bwrap クライアントから動的公開ポートへ接続できる。
- Testcontainers 12.1.0 の start、HTTP wait、mapped port、exec、stop。
- Ryuk 0.14.0 が SDK 終了後に取り残したコンテナを削除する。

`fixture.c` のマスクは静的な置換ファイルであり、maskfs/FUSE の実証ではない。privileged probe では既存の `/sys` を ro bind している。無指定の privileged コンテナは、この構成では sysfs mount で拒否された。
完全なセキュリティ保証、全 Testcontainers module の互換性、Nix 不在ホストでの実行、実 agent と通信 proxy、障害時のホスト資産回収は検証範囲に含まない。

## 準備

ホストには bwrap、Docker の CLI/daemon、RootlessKit、uidmap の helpers と subordinate UID/GID、util-linux、Node、curl、iproute2、基本的な shell tools が必要。
実証時は Linux 6.18.40、bwrap 0.11.2、Docker 29.6.2、RootlessKit 2.3.6、Node 24.19.0 を使用した。
RootlessKit は `nix build --no-link --print-out-paths nixpkgs#rootlesskit` で一時取得した。profile やホスト設定は変更していない。

以下はこのディレクトリを cwd にして実行する。生成物は既存の `.gitignore` により無視される `node_modules/probe-artifacts/` に置く。プロジェクト本体の依存には追加しない。

```bash
mkdir -p node_modules/probe-artifacts/sdk
printf '{"private":true,"type":"module"}\n' > node_modules/probe-artifacts/sdk/package.json
bun add --cwd node_modules/probe-artifacts/sdk testcontainers@12.1.0
zig cc -target x86_64-linux-musl -O2 -static fixture.c -o node_modules/probe-artifacts/fixture
python3 - <<'PY'
from pathlib import Path
import tarfile
p = Path('node_modules/probe-artifacts')
with tarfile.open(p / 'fixture.tar', 'w') as tf:
    info = tf.gettarinfo(str(p / 'fixture'), arcname='fixture')
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mtime = 0
    with (p / 'fixture').open('rb') as f:
        tf.addfile(info, f)
PY
```

Ryuk archive は準備用の sandbox Docker daemon で取得した。これは新たに起動する probe daemon とは別であり、bwrap のネットワーク疎通成功には数えない。

```bash
docker pull testcontainers/ryuk:0.14.0
docker save --output node_modules/probe-artifacts/ryuk.tar testcontainers/ryuk:0.14.0
```

取得時の registry digest: `sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0`。
この tag/digest は実証記録であり、将来取得時に同じものか確認する。

## 実行

```bash
bash namespace-probe.sh host true /path/to/rootlesskit
```

nas 内から実ホストへ依頼するときは、共有 workspace 上のこの script の絶対パスを `hostexec bash` に渡す。UID 範囲はこの probe では65,536個を前提とする。ホスト設定の不足を自動修正しない。

外側に60秒 timeout と PID namespace の回収機構があり、通常終了時は daemon へ TERM/wait、一時ディレクトリの削除を行う。強制終了後の残存資産検査は別の受入試験として必要。

失敗時は、どの PASS まで進んだかと exit status を記録する。`docker ps` の失敗を、Ryuk による削除成功として数えない。
