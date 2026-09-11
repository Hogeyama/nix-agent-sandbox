# bwrap と Testcontainers の成立性

Status: NixOS ホストで独立 probe が exit 0。専用 Docker、制限した bwrap 内の Testcontainers、Ryuk の回収を実証した。製品の受入検証は未完了。プロダクト実装は開始していない。

## 判断と必須条件

Linux の既存機構を組み合わせ、一台のホストでは基本動作を実証できた。bwrap 単体で Docker を置き換えるものではなく、セッション専用の Docker daemon も隔離する必要がある。現在の計画の「DinD 非対応」はユーザーの用途を満たさない。

- ホスト環境を利用する。Ubuntu rootfs の独自配布を前提にしない。
- `.nas/config.pkl` の主要 profile を backend 選択以外の機能削減なしで使うことを目標にする。Nix が任意であることと、Nix 利用機能を削除することを混同しない。
- Testcontainers によるコンテナ操作へ、人間の都度承認や hostexec を要求しない。
- ホストの rootful/rootless Docker socket を共有しない。専用 daemon にもホストの home、秘密、他セッション、nas の承認 control socket を見せない。
- 設定済み network review は別の契約。コンテナ操作が承認不要でも、未知の外部宛先を自動許可する意味ではない。
- `docker.enable=false` の通常 bwrap 経路では Docker を要求しない。true の場合はテスト用 Docker とその依存が必要になる。

## 確認した現行実装

`src/docker/dind.ts` は `docker:dind-rootless` を外側 Docker の `--privileged` で起動している。単純な argv 変換では bwrap に移せない。
`src/stages/dind/stage.ts` は agent を sidecar の network namespace に参加させ、`DOCKER_HOST=tcp://127.0.0.1:2375` としている。公開ポートも同じ loopback から使う。
Ryuk 用の `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`、接続先用の `TESTCONTAINERS_HOST_OVERRIDE` / Python 用 connection mode、専用共有 tmp の処理がある。
ただし、今回検索した package.json/tests/src では Testcontainers ライブラリを使う実テストは確認できなかった。Docker CLI の integration test と Testcontainers 向け設定の存在を、SDK 実行成功の証拠にしない。

最初の nas 内調査では Docker info に rootless と表示された。ローカル image 一覧は空。bwrap の user/net namespace 最小 probe は exit 1、`No permissions to create a new namespace` で失敗した。RootlessKit は PATH に無かった。ホスト設定は変更していない。
この nas 内調査だけでは候補構成を試せなかった。その後、ユーザーの hostexec 実行許可により、下記の実ホスト試行へ進んだ。

## 最終試行の結果（2026-09-11）

NixOS 26.05、Linux 6.18.40、bwrap 0.11.2、Docker 29.6.2、RootlessKit 2.3.6、Node 24.19.0。ホスト UID は1000、subuid/subgid は開始231072・各65536個。
判定の read-only レビュー後、false positive を防ぐ修正を加えた最終 script を hostexec で実行し、exit 0 を確認した。

| 検証 | 結果 |
| --- | --- |
| 外側で filesystem を制限し、内側で複数 UID と mount 能力を持つ | 成功 |
| 専用 Docker daemon の rootless 起動 | 成功。ホスト daemon は不使用 |
| UID 0 と UID 1234 のコンテナ実行 | 出力を assert して成功 |
| privileged container で新しい tmpfs を mount | 成功（負例試験の positive control） |
| 同じ container から保護 fixture の unmount / rw remount | EINVAL / EPERM で拒否。静的な mask 内容を維持 |
| 制限した bwrap クライアントから動的公開ポートへ HTTP 接続 | 成功 |
| SDK の実行 UID・権限 | UID1000、CapEff0、NoNewPrivs1 を assert |
| Testcontainers 12.1.0 の start・HTTP wait・mapped port・exec・stop | 成功 |
| SDK 終了後の Ryuk 0.14.0 による残したコンテナの回収 | Docker API の正常応答を確認した上で、対象の消失を確認 |

実行コマンド（この worktree の絶対パスで hostexec に渡した）:

```bash
hostexec bash /home/hogeyama/repo/nix-agent-sandbox/.worktrees/bwrap-assessment/docs/superpowers/probes/bwrap-docker/namespace-probe.sh host true /nix/store/qb4p1bc62q8ldv4fz0dv290w88dnqbh6-rootlesskit-2.3.6/bin/rootlesskit
```

最終出力の抜粋:

```text
PASS privileged fixture: new mount works; protected unmount/remount denied (22/1)
PASS published dynamic port reachable from restricted bwrap client
PASS SDK process has UID 1000, no effective capabilities, NoNewPrivs
PASS Testcontainers 12.1.0 start, HTTP wait, mapped port, exec
PASS Ryuk removed container after SDK process exit
```

準備した archive の SHA-256:

- fixture.tar: `abfc8dbdeafe3e8c0e959854fb02e91161d615a9bc40be329e0e61ed798a7dd0`
- ryuk.tar: `5576d16e1439345cf07e950c846e9ef50801f021cf7642fe035ac829b5d59012`

専用 Docker 内の操作ごとの hostexec 承認は不要だった。hostexec はこの独立試行をホストで始めるためだけに使った。
ローカルでは shell/JavaScript の構文検査と、fixture C の警告をエラーにしたコンパイルも成功した。製品コードを変更していないため、本体の Bun suite はこの試行では再実行していない。

## ホスト試行で確認した構成

[独立 probe と再現手順](../probes/bwrap-docker/README.md)を追加した。本番コードや既存 `.nas/config.pkl` は変更していない。

1. RootlessKit がホスト UID と subordinate IDs を user namespace A に割り当てる。network/port driver は none。
2. A 内で bwrap が filesystem view を確定する。ツールはホスト `/nix/store` から利用し、home やホスト Docker socket は渡さない。
3. さらに user namespace B と独立 mount/net/PID namespace を作り、専用 Docker daemon を起動する。B では子コンテナ作成に必要な権限を持つが、A で作った保護 mount の解除は制限される。
4. SDK はさらに bwrap の中へ置き、UID 1000・実効 capability なしで専用 Docker API に接続する。Docker の公開ポートは B のネットワーク内で利用する。

新しい daemon は rootless モード、vfs、Docker bridge と userland proxy を使用。iptables、IP forwarding、masquerade は無効。RootlessKit API は port driver none のものだけを渡す。この API を host port forwarding 有効の構成へ無検討に差し替えてはいけない。
Docker 用 image は事前取得した archive をロードした。実証中の pull、proxy、外部ネットワークアクセスはまだ試していない。

試行中に解消した条件:

- UID map は「ホスト本人」と「subordinate IDs」の二つの extent に分かれる。子で一つの連続範囲として再 mapping すると EPERM。二つに分けると成功した。
- Docker 29.6.2 の rootless モードは RootlessKit の API socket を要求した。
- Docker が操作する netns は内側の user namespace B で作る必要があった。A 所有の netns のままでは Docker の setns が EPERM。
- privileged container の既定 sysfs mount は EPERM。負例試験では `/sys` の ro bind を明示し、実際に tmpfs mount 能力を持つプロセスから保護 fixture を操作する。

実証できた範囲を製品の受入合格と混同しない。静的な mount の検証は real maskfs を代替せず、正常終了と Ryuk の回収は owner SIGKILL 後のホスト資産回収を証明しない。Nix/devShell 互換、proxy、Nix 不在ホスト、他の Testcontainers SDK/module、storage 性能・容量制限は未検証。

## 製品化に向けて残る設計

ホスト上の信頼済み launcher が subordinate UID/GID の割当てと namespace を準備し、ホスト filesystem への参照を取り除いてから専用 daemon を起動する。agent はさらに権限を落とした bwrap 環境で動かす。両者に必要な workspace/tmp の view を同じ絶対パスで渡す。
Docker API は専用 Unix socket で agent に渡す。Docker が公開した動的ポートをセッション内で利用可能にする。ホスト公開は既存の承認された nas relay 経路に限る。
外部通信は nas gateway/proxy への Unix socket 経路だけにする。CA 秘密鍵、注入する秘密、承認状態はこの Docker 管理範囲の外に置く。

RootlessKit は UID/GID mapping の候補であり、起動しただけでは filesystem allowlist にならない。既定のネットワーク設定もそのまま採用しない。
上記 probe は限定した機能での実証であり、以下の製品機能を含む構成や起動手順はまだ確定していない。

### 最大の難所: daemon から解除できない外側の境界

Docker は mount、子 namespace、複数 UID などを必要とする。agent 向けの cap-drop/seccomp をそのまま daemon に継承させると動かない可能性が高い。
反対に、agent が専用 Docker API から任意プロセスを起動できる以上、agent 側だけの syscall 制限・マスクは十分ではない。daemon とその子孫にも変更できない外側の制限が必要。

検証候補は、信頼済み側が mount 制限を確定し、daemon をその所有 user namespace より内側へ置く階層構成。単に同一 user namespace 内で daemon に CAP_SYS_ADMIN を残すと、保護 mount の取り外し・再 mount の可否が問題になる。
複数階層の UID mapping、mount lock、必要 capability、procfs/sysfs、cgroup delegation、storage driver の組合せを確認する。通常の一 UID の bwrap の中から newuidmap を呼べば済むとは扱わない。

`--privileged`、`--pid=host`、`--network=host`、`-v /:/outside`、seccomp の解除要求を専用 daemon に送っても、到達範囲がセッションの外へ広がらないことを負例で確認する。ホストを指す継承 FD、`/proc/*/root`、元の mount の alias も確認対象。
内部コンテナが nas 側の制限を回避できるなら、通常の DB テストだけが通っても不合格。

### 通信と Testcontainers の互換性

Docker API socket が届くだけでは不十分。動的公開ポート、Ryuk socket の daemon 側パス、wait strategy、コンテナ間通信、コンテナからテストプロセスへの逆向き接続を確認する。
外側のセッション netns は daemon が変更できない配置を検討する。daemon 自身の netns からの公開ポートをそこへ中継する場合、動的割当てと SDK の接続先検出を実証する。
RootlessKit の slirp/pasta をホストに直結すると外向き通信の抜け道になり得るため、単に proxy 環境変数を渡して隔離済みとはしない。
Docker の版によって detached-netns 等の既定が変わる。版と namespace 配置を固定して確認する。

イメージ pull と、Dockerfile の RUN 内の通信は別試験。現行 nas の DinD では後者がネットワークに到達できない制約がある。これを Testcontainers 全般の互換として隠さず、image build を使うケースを明示する。

### filesystem と後始末

bind mount の source は daemon 側で解決される。workspace/tmp の同一パスと view を揃え、maskfs 有効時は daemon にもマスク前の source を見せない。
rootless 子コンテナの UID と FUSE view のアクセス権、ro mount の維持も試験する。ホストの `/tmp` 全体を共有する設定では、nas の内部ファイルをそこに露出させない。
Ryuk を有効にした通常回収をまず試す。停止時には Ryuk に依存せず、nas が daemon、containerd、shim、子コンテナ、mount、専用データを回収する。異常終了、別セッション同時利用も確認する。

## 製品の受入に必要なホスト検証

上記の NixOS probe を出発点に、次の項目の未検証部分を埋め、Ubuntu ホストへも広げる。ホストの userns/subuid/subgid/uidmap/cgroup 条件は事前に記録する。必要な初回ホスト設定と、日常のテストごとの承認は区別する。

1. ホスト tool/Nix closure を使った候補の隔離内で専用 daemon が起動する。rootfs 配布を追加しない。
2. agent 相当の別 bwrap から Docker API、イメージ起動、動的ポートへの接続が使える。
3. 一つの Testcontainers SDK と版を固定し、Redis 等で実際の読み書き、wait、Ryuk の起動と回収を確認する。追加 dependency は独立 probe に閉じ込める。
4. bind mount、別 UID、コンテナ間通信、image build の代表ケースを実行する。
5. 上記の負例からホスト秘密・実ホスト loopback・外部ネットワーク・別セッションへ到達できない。
6. 正常終了・テスト強制終了・owner 強制終了後に専用資産が残らない。

各結果を host/kernel/各 tool 版/commit/実行コマンド/exit code と対応づける。最初の daemon 起動や通常テストが成功しても、境界試験前に採用を決定しない。
Nix は必要なバイナリと依存を揃える助けになるが、subordinate ID 割当てや namespace 権限の成立を代替しない。

## 一次資料

- [RootlessKit](https://github.com/rootless-containers/rootlesskit): user/mount/net namespace、newuidmap/newgidmap と subordinate IDs、network driver と state socket。
- [Rootless Docker の DinD](https://docs.docker.com/engine/security/rootless/tips/): 現行 Docker sidecar に対応する rootless DinD の privileged 要件。
- [dockerd-rootless.sh](https://github.com/moby/moby/blob/master/contrib/dockerd-rootless.sh): RootlessKit 起動、network と detached-netns の設定。参照した master の既定を既存導入版へそのまま適用しない。
- [bwrap のオプション](https://github.com/containers/bubblewrap/blob/main/bwrap.xml): user namespace と capability 等。具体的な多階層構成の成立は未実証。
- [Testcontainers Node の runtime 対応](https://node.testcontainers.org/supported-container-runtimes/): SDK runtime 対応。rootless で Ryuk 無効化との記述は Podman の節にあり、rootless Docker 全般へ一般化しない。
