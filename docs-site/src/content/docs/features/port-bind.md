---
title: コンテナポート公開
description: コンテナ内の開発サーバーをホストの localhost で開く
---

## どんな機能？

`nas network bind` は、選んだ session のコンテナ内 `127.0.0.1:<container-port>` を、ホストの `127.0.0.1:<host-port>` で開きます。profile の設定変更や session の再起動は不要です。

これは `network.proxy.forwardPorts` と逆方向です。

| 機能 | 接続元 | 接続先 |
| --- | --- | --- |
| `network.proxy.forwardPorts` | コンテナ | ホストの loopback service |
| `nas network bind` | ホスト | コンテナの loopback service |

## いつ使う？

エージェントがコンテナ内で起動した開発サーバー、preview、デバッグ UI などをホストのブラウザやツールから確認するときに使います。外部ネットワークや LAN に公開する機能ではありません。

## CLI から操作する

コンテナ port を明示して開きます。host port を省略すると、最初に同じ番号を試し、使用中なら近くの空き port を選びます。

```sh
nas network bind <session-id>:3000
nas network bind <session-id>:3000 8080
```

指定した session で未公開の待ち受け port を検出し、`fzf` で選ぶこともできます。検出は要求された間だけ動き、nas 自身が使う port や kernel の ephemeral port range は候補から除外されます。

```sh
nas network bind <session-id>
```

relay はコンテナ内の `127.0.0.1` へ接続します。`0.0.0.0` または IPv4 loopback で待ち受ける server は到達できますが、コンテナの外向き address や IPv6 loopback だけで待ち受ける server は候補に理由が表示されても応答しません。

現在の binding は引数なしで一覧にできます。機械処理では JSON を選べます。

```sh
nas network bind
nas network bind --format json
```

閉じるときは session と container port、または host port を指定します。引数を省略すると `fzf` で選びます。

```sh
nas network unbind <session-id>:3000
nas network unbind 8080
nas network unbind
```

明示した host port が使用中または権限不足の場合は、別の port へ自動変更せずエラーになります。新しい binding に probe の応答がない場合でも listener は作成され、CLI はその状態を警告します。

## UI から操作する

UI daemon では session を選び、`Ports · in` panel を使います。コンテナで検出した待ち受け port の `Bind`、port 番号の直接入力、公開 URL を開く link、既存 binding の `Unbind` を一か所で操作できます。CLI と UI は同じ binding state を扱います。

## ライフサイクル

host 側 listener は、その session を起動した nas の host process が所有します。session が正常終了すると binding はすべて閉じられ、process が終了した場合も listener は残りません。`nas network gc` は異常終了などで残った runtime registry を整理しますが、通常の unbind や session teardown の代わりではありません。

機能追加前の nas で開始した session や、broker が既に終了した session には bind できません。session を再起動するか、stale state であれば `nas network gc` を実行してください。

## 注意点・セキュリティへの影響

listener は host の `127.0.0.1` だけに bind しますが、公開する service と content はコンテナ内のエージェントが制御できます。ブラウザでそのページを開くと、ページは同じホストの別の loopback service へ request を送れます。Same-Origin Policy により response を読めない場合でも request の送信自体は可能なため、loopback だけを認可境界と考えないでください。管理 UI、認証なし API、local daemon などを同じ host で動かしている場合は特に注意が必要です。

bind / unbind に network egress の承認キューはありません。これらは host 側の control 操作です。コンテナ内から host の `nas network bind` を呼び出す場合は、別途、狭く設定した HostExec rule とその承認が必要です。

[コンテナポート公開のリスク](/nix-agent-sandbox/security/risks/#port-bind)も確認してください。

## 関連ページ

- [localhost ポート転送](/nix-agent-sandbox/features/port-forwarding/) — host service をコンテナから使う逆方向の relay
- [UI daemon](/nix-agent-sandbox/features/ui/) — `Ports · in` panel から操作する
- [HostExec](/nix-agent-sandbox/features/hostexec/) — コンテナから host command を委譲する場合
- [ネットワーク制御](/nix-agent-sandbox/features/network/) — 外向き HTTP(S) の scope / rule 認可
