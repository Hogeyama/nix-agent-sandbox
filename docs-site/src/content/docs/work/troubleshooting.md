---
title: 作業中の問題と調査
description: 承認待ち、通信拒否、コマンド失敗、UI 接続の切り分け
---

止まっている場所に応じて確認先を選びます。待っている要求への応答と、許可ルールの変更は別の操作です。

| 状態 | 確認先 |
| --- | --- |
| Pending に要求がある | [承認待ちの要求](#承認待ちの要求) |
| 通信やホストコマンドが拒否された | [許可・拒否の記録](#許可拒否の記録) |
| 許可したのに通信やコマンドが失敗する | [許可後の失敗](#許可後の失敗) |
| UI が開かない、入力できない | [UI の接続と入力](#ui-の接続と入力) |
| Local / Remote 転送で接続できない | [ポート転送の接続](#ポート転送の接続) |

## 承認待ちの要求

UI の Pending で **All** を選び、他のセッションに要求が届いていないかも確認します。要求があれば[内容と適用範囲を判断して応答](/nix-agent-sandbox/work/approvals/)します。

承認には待ち時間の上限があり、時間切れは拒否です。Pending に残っていない場合は、次の記録を調べます。設定で直接拒否された要求は、最初から Pending に現れません。

## 許可・拒否の記録

UI の **Settings → Audit** を開きます。**Domain** で通信なら network、ホスト実行なら hostexec に絞れます。**Session contains** はセッション ID の部分一致、**Active only** は実行中のセッションだけに限定する設定です。終了した作業を調べる場合は Active only を解除します。

<img src="/nix-agent-sandbox/images/ui-audit.png" width="1000" alt="Audit の Domain、Session contains、Active only と、時刻・判定・通信先の一覧" />

例示用データの画面です。**Timestamp** と **Session** で対象を特定し、**Decision** の `allow` / `deny` と **Summary** の通信先・コマンドを確認します。本文の判定診断が記録されていれば Summary に併記されます。古い記録は一覧の追加読み込みで表示できます。

### 判定理由の詳細

UI の一覧に必要な理由がない場合は、対象行の Session をコピーし、ホストで次を実行します。`<session-id>` と日付を調査対象に置き換えます。

```sh
nas audit --session <session-id> --since 2026-09-01 --json
```

時刻と通信先・コマンドが一致する記録の `reason` を確認します。日付を省略すると当日の UTC 日付以降が対象です。種類を限定する場合は `--domain network` または `--domain hostexec` を追加します。

必要な通信が直接拒否されていたら、[接続先と要求の許可](/nix-agent-sandbox/configuration/network/)を追加します。ホストコマンドなら[実行ルール](/nix-agent-sandbox/configuration/host-commands/)を見直します。設定を変更する場合は内容を確認して再信頼し、新しいセッションへ反映します。

## 許可後の失敗

判定が allow でも、通信先サービスのエラーやコマンド自体の失敗は解消しません。エージェントに返された HTTP ステータス、終了コード、エラーメッセージを確認します。

Gradle・Maven などでプロキシが使われていない場合は、[ツール側のプロキシ設定](/nix-agent-sandbox/configuration/network/#ツール側のプロキシ設定)を確認します。ホスト実行のルールに一致しないコマンドは、[コンテナ実行へのフォールバック](/nix-agent-sandbox/configuration/host-commands/#ルール不一致の要求)になる場合があります。

## ポート転送の接続

まず **Ports** の行で方向と二つの番号を確認します。Local はホストの `hostPort` で待ち受けてコンテナの `containerPort` へ接続し、Remote はコンテナの `containerPort` で待ち受けてホストの `hostPort` へ接続します。

状態が active なら待受は作成済みです。追加時に `Target probe: no answer ... yet` と表示されても転送は残るため、接続先のサービスが正しい番号で loopback から到達できることを確認し、もう一度接続します。Local のコンテナ側サービスは IPv4 の `127.0.0.1` または `0.0.0.0`、Remote のホスト側サービスは `127.0.0.1` で待ち受けます。転送が active であることは、接続先サービスの応答を保証しません。

pending のまま進まない、unavailable になる場合は、ホストで `nas container list` を実行し、対象セッションの agent コンテナが `running` か確認します。`stopped` または一覧にない場合は、新しいセッションを起動します。`running` でも unavailable が続く場合も、エージェントの作業を確認してから新しいセッションを起動してください。failed の行には理由が表示されます。`host port ... is unavailable` は Local のホスト側番号、`container port ... could not be opened` は Remote のコンテナ側番号がすでに使われている可能性があります。別の待受番号に変えて追加し直してください。nas が内部で使う予約ポートも Remote の待受には指定できません。

起動時の転送準備に失敗すると、エージェントは開始されません。起動ログの `Initial port forwarding failed or timed out` と競合した番号を確認し、設定を直して新しいセッションを起動します。

古い nas で開始したセッションが新しい転送操作に対応していない場合も、案内に従って新しいセッションを起動します。異常終了後の登録情報が残っている場合は `nas network gc` で回収できます。

設定由来の転送を Remove しても、変更は現在のセッションだけに適用されます。リレーの切断と復旧では戻らず、プロファイルを変えなければ次の新しいセッションで再び適用されます。Origin に `internal` も表示される行では、**Remove user** を押しても内部用途が残り、削除後のメッセージにその結果が表示されます。

## UI の接続と入力

UI は既定でエージェント起動時に自動起動します。ホストのブラウザで `http://localhost:3939` を開きます。`ui.port` を変更している場合は、そのポートを使ってください。

開けない場合は、セッションがまだ動いているか、起動ログに `UI daemon failed to start` が出ていないかを確認します。自動起動を無効にした構成や、UI だけを起動し直したい場合は、ホストで `nas ui` を実行できます。

UI が開いていても、中央ターミナルへの入力には接続可能な dtach セッションが必要です。Sessions には見えるのに入力できない場合は、[ブラウザから入力するための設定](/nix-agent-sandbox/work/sessions/#エージェントへの入力と再接続)を確認します。

UI だけを停止するコマンドは `nas ui stop` です。ポートを変えている場合は `nas ui stop --port 4040` のように指定します。これはエージェントを終了する操作ではありません。自動起動、ポート、自動停止時間は[UI の設定](/nix-agent-sandbox/configuration/profiles/#ui-の設定)で変更できます。
