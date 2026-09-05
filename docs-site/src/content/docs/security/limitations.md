---
title: 制約・注意事項
description: 対応 runtime、agent binary、TTY、cleanup と機能別の制約
---

このページは現在の実装で確認できる制約です。構成を広げる前に、[機能別リスク](../risks/)も確認してください。

## runtime と配布物

- nas は Linux と Docker 20.10 以降を前提にします。Docker が利用できない host や、Docker daemon を操作できない user では agent container を起動できません。
- 使用する Claude Code、GitHub Copilot CLI、OpenAI Codex CLI は公式の standalone binary が必要です。npm 版は `node_modules` tree に依存し、単一 binary の bind mount で起動する設計には対応しません。
- release artifact は `x86_64-linux` と `aarch64-linux` 向けです。現在 aarch64 release は動作未確認です。対応 artifact があることは、その host / agent / Docker 組合せの動作保証ではありません。

## terminal と file ownership

- 引数なしの interactive agent 起動には TTY が必要です。non-TTY の CI / script では agent に prompt option など明示的な引数を渡します。untrusted config は non-TTY では trust prompt を出せず失敗するため、事前に確認して `nas config trust` を実行します。
- entrypoint は setup のため root で始まりますが、agent 実行前に host UID/GID へ drop します。workspace や writable bind mount で agent が作成・変更した file は host user の ownership / permission で残ります。

## optional feature の前提と cleanup

- Nix integration は host の `/nix` 検出で auto 有効になり得ます。`nix.enable = true` でも host に `/nix` がなければ mount は作られません。Nix は必要性だけでなく socket を渡してよいかを判断してください。
- DBus proxy は host UID または `xdg-dbus-proxy` がなければ有効化を skip します。`DBUS_SESSION_BUS_ADDRESS` がないことだけでは skip せず、`unix:path=/run/user/$UID/bus` を source address として合成します。その bus が実在・利用可能でなければ proxy の起動または readiness が失敗します。設定だけで session bus を作る機能ではありません。
- X11/xpra には `xpra`、`xauth`、xpra が起動する Xvfb が必要です。host `DISPLAY` がないと auto-attach は失敗しますが、container と X server は継続します。WSL などで `/tmp/.X11-unix` が read-only の場合は host の `unshare` と `mount` binary で private user/mount namespace 内に `mount --bind` を実行します。unprivileged user namespace と mount namespace が利用可能で、両 binary がなければ display setup は失敗します。
- session scope が正常に閉じれば broker、xpra、secret frame は cleanup を試みます。しかし SIGKILL や finalizer の失敗では、mask-filter runtime の per-session directory と mode `0600` の plaintext `mask-secrets` frame が残り得ます。この runtime に reaper はなく、nas を再起動しても残存 frame が自動で消えるとは限りません。host operator は live session が使っていないことを確認してから、残存する該当 session directory を手動で安全に cleanup してください。`nas network gc` は stale network runtime 用であり、mask-filter frame を回収する command でも、稼働中 broker の state を消す command でもありません。
- DinD sidecar、mutable data volume、一時 volume、`registry-mirror` は session 専用で、通常の teardown で削除されます。agent container がまだ DinD の network namespace を使っている場合や cleanup に失敗した場合は残り得るため、unused になってから `nas container list` で確認し、`nas container clean` を使います。永続 pull cache の `nas-registry-cache` はこの cleanup でも削除されません。`docker.shared = true` は deprecated な互換 field であり、DinD 有効時は validation error です。worktree cleanup は active session を検査しません。

## 実装上の境界

- HostExec の `fallback = "deny"` は schema にありますが、current runtime は per-rule fallback の deny を実行しません。rule 不一致の fallback は container execution が成功する保証でもありません。
- relative HostExec `argv0` と `workspace-only` は workspace root を固定しません。nested cwd から同名 wrapper を request できるため、one-shot approval と cwd/integrity の確認、または immutable absolute path が必要です。
- network / HostExec approval、audit、telemetry は security control の補助であり、完全な forensic record ではありません。receiver や保存の失敗で telemetry は欠け、request body の expiry は audit metadata を消しません。

## 関連ページ

- [インストール](/nix-agent-sandbox/getting-started/installation/) — runtime と artifact
- [相対パスコマンドを prompt 承認で移譲](/nix-agent-sandbox/recipes/relative-hostexec/) — cwd の残余リスク
- [Docker イメージを再ビルドする](/nix-agent-sandbox/operations/maintenance/) — sidecar / worktree cleanup
