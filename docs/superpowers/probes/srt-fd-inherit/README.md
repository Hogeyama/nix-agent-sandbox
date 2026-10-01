# srt の中へ制御用 fd を継承させられるか

sumi のマスクブローカーに srt (sandbox-runtime) の中から接続する経路を探した probe。
srt は Linux で `socket(AF_UNIX, ...)` を seccomp で塞ぐので、hook がパス上の Unix ソケットへ接続できない。
srt 0.0.76 の `dist/sandbox/linux-sandbox-utils.js` は、継承した Unix ソケットの fd への操作と `SCM_RIGHTS` は塞がないと明記している。
そこで、srt の外で作った fd を hook まで継承させられるかを調べた。

## 仕組み

- `broker.py -- COMMAND` は `SOCK_SEQPACKET` の socketpair を作り、片方を CLOEXEC なしで COMMAND に渡す。番号は `SUMI_PROBE_FD` で伝える。
- `client.py [LABEL]` は `socket(AF_UNIX)` と `socketpair` が使えるかを記録する。その上で自分の socketpair の片方を `SCM_RIGHTS` で制御用 fd に送り、残りで `hello` を送って `echo:hello` が返るかを確かめる。結果は 1 行の JSON で、`SUMI_PROBE_LOG` があればそこにも追記する。

```bash
python3 broker.py -- python3 client.py direct
python3 broker.py -- node -e 'require("child_process").spawn("python3",["client.py","via-node"],{stdio:"inherit"})'
```

## 結果 (2026-10-01, Linux 6.1, node 24.20.0, bun 1.4.2)

| 経路 | 子での fd |
|---|---|
| 直接起動 | 開いている (PASS) |
| bash -c | 開いている (PASS) |
| node `child_process.spawn`、`stdio: 'inherit'` | 閉じている (EBADF) |
| node `child_process.spawn`、`stdio` の 4 番目に fd を指定 | 開いている (PASS) |
| bun `child_process.spawnSync` | 閉じている (EBADF) |
| `Bun.spawnSync` | 閉じている (EBADF) |

node 自身と bun 自身からは fd が見えていた。閉じているのは、子を起動するときである。
srt の CLI は `spawn(argv[0], argv.slice(1), { stdio: 'inherit' })` で bwrap を起動し、Claude Code は Bun で hook を起動する。
したがって、srt の手前で作った fd は hook まで届かない。bwrap と apply-seccomp を経由する段は、この環境では userns が使えず試していない。

別に、`socketpair(AF_UNIX, SOCK_DGRAM)` で作ったソケットは `connect()` でパス上の DGRAM ソケットにつなぎ直せた。
`SOCK_STREAM` ではつなぎ直せない (EPROTOTYPE)。
srt の seccomp が `socketpair` を塞がないなら、srt の中からも任意の Unix DGRAM ソケットに送れることになる。ただし、srt の中では確かめていない。
