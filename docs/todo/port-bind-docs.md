# `nas network bind` がドキュメントに存在しない

## 結論

コンテナ側のポートをホストの localhost に出す機能 —— `nas network bind` /
`unbind` —— を説明したページが docs-site にひとつも無い。実装も CLI も揃って
いて日常的に使えるのに、ユーザーがそれを知る経路が help テキストしかない。

紛らわしいことに、逆方向だけがドキュメント化されている。
`docs-site/src/content/docs/features/port-forwarding.md` は
`network.proxy.forwardPorts`、つまり **ホストの loopback service をコンテナから
見えるようにする**話だけを扱う。ページ名が「localhost ポート転送」なので、
逆方向を探した人はここを開いて、目的の機能が無いと分かって引き返す。

## どうやって気づいたか

サンドボックス内で HTTP サーバ (127.0.0.1:3117) を立て、ホストのブラウザから
見たかった。`forwardPorts` に 3117 を足す方向を検討したが、これは方向が逆で
あって解にならない。`nas --help` の Network options を読んで初めて
`nas network bind` の存在を知った。

コンテナの中からは hostexec 経由で呼ぶことになる:

```bash
./scripts/hostexec nas network bind "$NAS_SESSION_ID":3117 3117
```

なお最初 `nas port bind` と書いて `Profile "port" not found` に当たった。
サブコマンドが `network` の下にぶら下がっている点も、help 以外に手がかりが無い。

## 書くべき内容

- 方向の区別。`forwardPorts` は host → container、`network bind` は
  container → host。両ページから相互にリンクする。
- `nas network bind <session-id>:<container-port> [<host-port>]`。引数なしで
  一覧、`--format json` あり。`unbind` は引数なしで fzf 選択。
- コンテナの中からは hostexec を通すこと、そこが承認点になること。
  bind 自体に独立した承認キューは無い。
- ライフサイクル。session の teardown で開いている binding は全部閉じる
  (`src/network/port_bind_broker.ts` の `close()` が `open` を回して
  `closeBinding`、その後 `PortBindServiceLive` が `removeSessionRegistry`)。
  ホスト側の listener は nas のホストプロセス内にあるので、プロセスが死ねば
  ソケットも道連れになる。**残らない**ことを明記したい —— 今回これを口頭で
  「残る」と誤って断言してしまい、あやうくバグとして起票するところだった。
- host port が埋まっているときの挙動 (broker の `candidates`)、および dind の
  `reservedNamespacePorts` が候補から除外される点。

## 置き場所

`features/port-forwarding.md` に節を足すか、`features/port-bind.md` を新設して
両者を相互リンクするか。ページを分けるほうがページ名と内容が一致すると思うが、
「ポート」で探す人が2ページのどちらを開いても迷子にならないことが条件。

## 関連

- 実装: `src/stages/port_bind/`、`src/network/port_bind_broker.ts`、
  `src/network/port_bind_relay.ts`、`src/network/port_bind_supervisor.ts`
- CLI: `src/cli/port_bind_args.ts`、`src/cli/usage.ts` の Network options
- コンテナ側 relay: `/run/nas-ports/relay.sock` 上の
  `/usr/local/lib/nas/port-relay.mjs`
