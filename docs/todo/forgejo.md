# Forgejo

## 2026-08-13: NAS の終了によりデスクトップセッション全体が終了する

### 起こったこと

NAS sandbox 内から `forgejow request-review` を実行して Forgejo 16.0.2 を起動した後、
NAS の agent コンテナを `docker stop` すると Hyprland が終了した。同じ現象は NAS を
起動している端末で `Ctrl-C` した場合にも発生した。

Hyprland と NAS は別の process group / session で動いており、NAS が Hyprland に直接
シグナルを送った形跡はなかった。systemd user manager の debug log では、次の順序で
セッション終了が始まっていた。

```text
01:00:28.237  dtach PID 393489 と nas PID 393490 が終了
01:00:28      Forgejo が PID 397296 として graceful restart
               （旧 Forgejo は PID 395319）
01:00:29.247  旧 Forgejo PID 395319 が終了
01:00:29.529  systemd --user PID 384574 が
               PID 397296 (.forgejo-wrappe) から SIGTERM を受信
01:00:29.530  systemd --user が exit.target を開始
```

この後、user session の終了処理によって Hyprland が停止し、Hyprland 自身も Wayland
client の cleanup 中に `SIGSEGV` した。Hyprland のクラッシュはセッション終了開始後の
二次障害であり、最初にセッション終了を引き起こしたプロセスではない。

### 原因

直接原因は、graceful restart 後の Forgejo 子プロセスが `systemd --user` を旧 Forgejo
親プロセスと誤認し、`SIGTERM` を送ったこと。

再現時の因果関係は次のとおり。

1. `forgejow` は Forgejo を `nohup forgejo web ... &` で起動する。
2. `nohup` は Forgejo を新しい session / process group に移さない。このため Forgejo
   PID 395319 は、NAS と同じ PGID/SID `393490` および controlling TTY に残っていた。
3. NAS と dtach の終了で controlling TTY が切れ、同じ foreground process group にいた
   Forgejo が `SIGHUP` を受ける。
4. Forgejo は `SIGHUP` を無視せず、graceful restart として処理する。旧 Forgejo
   PID 395319 が新 Forgejo PID 397296 を起動してから終了する。
5. 新 Forgejo が server を登録すると `KillParent()` が呼ばれる。この関数は呼出時の
   `syscall.Getppid()` を取得し、その PID が 1 より大きければ相手を検証せず
   `SIGTERM` を送る。
6. 今回は `KillParent()` が実行される前に旧 Forgejo PID 395319 が終了していたため、
   新 Forgejo PID 397296 は `systemd --user` PID 384574 に reparent されていた。
   その結果 `Getppid()` は `384574` を返し、Forgejo が user manager を終了させた。

Forgejo 16.0.2 の該当実装:

```go
func KillParent() {
	killParent.Do(func() {
		if GetManager().IsChild() {
			ppid := syscall.Getppid()
			if ppid > 1 {
				_ = syscall.Kill(ppid, syscall.SIGTERM)
			}
		}
	})
}
```

- [`modules/graceful/restart_unix.go`](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.2/modules/graceful/restart_unix.go)
- [`modules/graceful/manager_common.go`](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.2/modules/graceful/manager_common.go)
- [`modules/graceful/manager_unix.go`](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.2/modules/graceful/manager_unix.go)

`nohup` が設定した `SIGHUP` の無視も Forgejo には効かない。Forgejo は
`signal.Notify(..., syscall.SIGHUP, ...)` を呼んでおり、Go は `Notify` の対象になった
`SIGHUP` に signal handler を設定して、それまでの無視設定を解除する。

### 現時点の切り分け

- **直接セッションを終了させた原因**: Forgejo 16.0.2 の `KillParent()` にある親 PID の競合
- **競合の発火条件**: `forgejow` が Forgejo を NAS の session / process group / TTY から
  切り離していないこと
- **Hyprland の `SIGSEGV`**: `systemd --user` が `exit.target` を開始した後に発生した二次障害

この記録では事象と原因の確定までとし、修正方法はまだ決定しない。
