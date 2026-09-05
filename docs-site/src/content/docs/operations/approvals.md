---
title: 通信・ホスト実行の承認
description: 通信・ホスト実行の承認待ち一覧と許可範囲
---

通信や HostExec が承認待ちになった場合は、ホストの CLI または[ブラウザ UI](/nix-agent-sandbox/features/ui/)で許可・拒否します。

## 保留中の要求

```sh
nas network pending
nas hostexec pending
nas network pending --format json
```

通信では接続先とルール、HostExec では作業ディレクトリ、コマンド、引数を確認します。対話的に選ぶ場合は `fzf` が必要です。

```sh
nas network review
nas hostexec review
```

## 個別の承認・拒否

一覧に表示されたセッション ID と要求 ID を指定します。次は一回限りの承認と拒否の例です。

```sh
nas network approve <session-id> <request-id> --scope once
nas network deny <session-id> <request-id>
nas hostexec approve <session-id> <request-id> --scope once
nas hostexec deny <session-id> <request-id>
```

## 通信の承認範囲

`--scope` は、要求ごとの `approvalScopes` に表示された候補から選びます。省略時は常に `once` です。再利用はいずれも同じセッション内に限られます。

| 値 | 承認の適用範囲 |
| --- | --- |
| `once` | その要求だけ。 |
| `rule` | 同じルール ID・判定理由・ホスト・ポート。scope が単一のホストとポートに固定されている場合のみ選択可能。 |
| `host-port` | 同じルール ID・判定理由・ホスト・ポート。 |
| `host` | 同じルール ID・判定理由・ホスト。異なるポートにも適用。 |
| `violation` | 同じルール ID・受理条件の位置・違反値。接続先は問わない。受理条件違反の承認でのみ選択可能。 |

通常の要求では `once` と、接続先の設定に応じて `rule` または `host-port` / `host` を選べます。受理条件違反では `once` または `violation` だけです。

通常の再利用条件にはパスを含みません。scope の fallback はルール ID `$fallback` として扱われ、別のパスにも承認が適用されます。

## HostExec の承認範囲

`once` はその要求だけ、`capability` は同じルール、コマンド、引数などの実行条件に対してセッション中の再利用を許可します。

省略時は `hostexec.prompt.defaultScope` に従い、既定は `"capability"` です。一回限りにする場合は `--scope once` を明示してください。

## 終了済みセッションの通信データ

```sh
nas network gc
```

異常終了などで残ったセッション登録情報、承認待ちディレクトリ、仲介プロセスのソケットを回収します。稼働中の通信状態は削除しません。
