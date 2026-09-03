---
title: 承認キューを操作する
description: Network と HostExec の pending request を確認、承認、拒否する
---

## pending を確認して判断する

```sh
nas network pending
nas hostexec pending
nas network pending --format json
nas network review
nas hostexec review
```

`pending` は保留中の request を表示します。network は target、HTTP review 情報、rule ID、
状態、作成時刻を、HostExec は rule ID、cwd、`argv0` と引数を示します。`review` は `fzf`
で選んで approve / deny する対話操作です。表示した値が期待した narrow rule か、cwd や
target が意図したものかを確認してから判断してください。

## 個別に approve / deny する

```sh
nas network approve <session-id> <request-id> --scope once
nas network deny <session-id> <request-id>
nas hostexec approve <session-id> <request-id> --scope capability
nas hostexec deny <session-id> <request-id>
```

Network の `--scope` は request ごとに表示される `approvalScopes` から選びます。現在の
候補全体は `once`、`rule`、`host-port`、`host`、`violation` です。ただし実際に送れる
範囲は pending の種類で異なります。通常の rule / fallback review は `once` のほか、
scope が単一の正確な host:port なら `rule`、それ以外では `host-port` または `host` を
提示します。受理条件違反の review では `once` または `violation` だけです。**Network
では `--scope` を省略すると必ず `once` です。** 再利用したい範囲を明示してください。

| scope | session 中に再利用する同一性 |
| --- | --- |
| `once` | 記憶しない。次の request は再度確認する。 |
| `rule` | rule ID、判定理由、正確な host:port。scope 自体がその 1 target に固定される場合だけ選べる。 |
| `host-port` | rule ID、判定理由、host、port。 |
| `host` | rule ID、判定理由、host。port はまたいで再利用する。 |
| `violation` | rule ID、受理条件の位置、違反値。target は含まず、受理条件違反の review だけで選べる。 |

HostExec の scope は `once` または `capability` です。`once` はその request のみ、
`capability` は同じ rule、command、引数などで表す capability を session 中に再利用します。
HostExec の scope を省略したときは `hostexec.prompt.defaultScope` が使われます。Network の
再利用も session 限定ですが、Network の省略値は前述のとおり `once` です。

## stale network runtime を掃除する

```sh
nas network gc
```

これは stale session registry、pending directory、broker socket を回収し、削除件数を
表示します。現在動いている broker の state を消すためのコマンドではありません。

## 関連ページ

- [ネットワーク制御](/nix-agent-sandbox/features/network/)
- [HostExec](/nix-agent-sandbox/features/hostexec/)
- [UI daemon](/nix-agent-sandbox/features/ui/)
