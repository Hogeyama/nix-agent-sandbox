---
title: 通信・ホスト実行の承認
description: UI に届いた要求の内容と適用範囲の確認、許可・拒否
---

エージェントの通信やホスト実行が承認待ちになると、UI の **Pending** に要求が届きます。何をしようとしているかと、今回の判断をどこまで適用するかを確認して応答します。

**ホスト実行**は、コンテナに隔離されたエージェントが、設定で許可したコマンドだけをホスト側で実行する仕組みです。ホストのツールや認証情報が必要な作業のために用意されています。詳しくは[ホストコマンドの実行許可](/nix-agent-sandbox/configuration/host-commands/)を参照してください。

## 承認待ちになる条件

承認待ちは、設定でそう決めた要求にだけ起きます。設定が許可と決めた要求はそのまま通り、拒否と決めた要求は待たずに失敗します。

通信では、ルールの `action`、ルールが判定不能だったときの `onIndeterminate`、スコープの `fallback`、全体の `fallback` のいずれかを `review` にしたときに承認待ちになります。加えて、送ってよいボディの形を `expect` で宣言していて、その `onViolation` を `review` にしている場合は、宣言に反するボディを含む要求も承認待ちになります。設定方法は[ネットワーク制御](/nix-agent-sandbox/configuration/network/#自動許可と承認待ち)にあります。

ホスト実行では、ルールの `approval` を `prompt` にしたときに承認待ちになります。もう 1 つ経路があり、実行ファイルがセッション開始時から変化していた場合は、`approval` が `allow` のルールでも、すでに許可した条件でも承認待ちになります。カードに変更の警告が出ます。設定方法は[ホストコマンドの実行許可](/nix-agent-sandbox/configuration/host-commands/)にあります。

## 要求の所在

左の **Sessions** で作業中のセッションを選び、右の **Pending** を確認します。**Current session** は選択中の作業だけ、**All** は全セッションの要求です。作業を選ぶまでは **All** が選ばれていて、**Current session** は押せません。作業を選ぶと **Current session** に切り替わります。All を見る場合は、カードのセッション名も確認してください。

## 外部への通信

**Network · out** には、接続先とメソッド、パス、承認が必要になった理由が表示されます。依頼した作業に必要な通信か確認します。

**受理条件**は、設定の `expect` で「この接続先へ送ってよいボディの形」を宣言したものです。これに反する要求は、条件の `onViolation` の指定に従って拒否されるか、承認待ちになります。条件に反した場所と、そこにあった**違反値**がカードに表示されます。違反値はマスク済みのものが表示されます。

ヘッダー注入が表示される場合は、許可すると nas が接続先へ付け足す認証情報の種類が分かります。エージェント自身が付けたヘッダーではありません。値は表示されず、名前だけが出ます。

<img src="/nix-agent-sandbox/images/ui-network-approval.png" width="312" alt="通信の承認カード。接続先、理由、once と this rule の範囲、Allow と Deny" />

例示用データの画面です。この要求だけに答える場合は **once** を選びます。範囲の選択肢の下にある **This action** には、いま選んでいる範囲で許可したときに何が通り、何が記憶されるかが一文で表示されます。そこを確認してから、通信を許可するなら **Allow**、拒否するなら **Deny** を押します。

### 同じ通信への判断の再利用

同じセッションで繰り返す通信には、カードに表示される範囲で判断を再利用できます。初期選択は常に **once** です。**通信では Deny にも選択中の範囲が適用されます。** 範囲を広げてから拒否すると、その範囲の通信がセッション中ずっと拒否されます。一回だけ拒否するつもりなら、once に戻してから押してください。

| 画面の選択肢 | 適用先 |
| --- | --- |
| **once** | その要求だけ。判断を記憶しない。 |
| **this rule** | 同じルール、同じ理由、同じホストとポート。 |
| **host:port** | 同じルール、同じ理由、同じホストとポート。 |
| **host** | 同じルール、同じ理由、同じホスト。異なるポートにも適用。 |
| **these values** | 同じルールの同じ受理条件で、同じ違反値を含む要求。接続先は問わない。 |

ここでいう**理由**は、カードに表示されている「承認が必要になった理由」です。同じルールでも理由が違えば別の判断として扱われ、再利用されません。

**this rule** と **host:port** は適用先が同じで、どちらが表示されるかだけが違います。当たったルールが接続先を 1 つのホストとポートに固定している場合は this rule が、ホストにワイルドカードを使っているなど接続先が広い場合は host:port と host が表示されます。両方が同時に並ぶことはありません。**these values** は受理条件違反のカードにだけ表示されます。

再利用の条件に URL のパスは入りません。別のパスへの通信も対象になるため、接続先が同じという理由だけで広い範囲を選ばず、表示される This action を確認してください。再利用は別のセッションには引き継ぎません。

## ホスト上でのコマンド実行

**Host exec · cmd** では、コマンドと引数、**Working directory**、一致した **Rule** を確認します。ホストの権限で実行するため、コマンド名だけでなく、どのフォルダーのどのファイルを実行するかも確認してください。環境変数の注入・引き継ぎや実行ファイル変更の警告が表示される場合は、その条件も確認します。

<img src="/nix-agent-sandbox/images/ui-hostexec-approval.png" width="312" alt="ホスト実行の条件と Approve scope。一回限りの選択と Approve、Deny this request only" />

例示用データの画面です。許可する前に **Approve scope** で適用先を選びます。

| 画面の選択肢 | 許可の適用先 |
| --- | --- |
| **This request only** | その要求だけ。許可を記憶しない。 |
| **Matching command for this session** | 実行条件が一致する保留要求と、同じセッションの後続要求。 |

**実行条件**が一致するとは、次のすべてが同じことです。一致したルール、実行ファイル（絶対パスで指定された場合はそのパス、コマンド名だけの場合はその名前）、引数の並び全体、作業ディレクトリ、注入する環境変数の名前と取得元、引き継ぐ環境変数の指定です。環境変数の値そのものは一致の条件に入りません。通信の再利用と違い、作業ディレクトリと実行ファイルのパスは一致の条件に入ります。

既定では **Matching command for this session** が選ばれます。一回だけ許可する場合は **This request only** を選び直します。スコープの選択肢の下にある **This approval** には、いま選んでいる範囲で許可したときに何が許可され、何が記憶されるかが表示されます。確認してから **Approve** を押します。初期選択は `hostexec.prompt.defaultScope` の設定で変更できます。

実行させない場合は **Deny this request only** を押します。ホスト実行の拒否は一回限りで、選択中の承認範囲を記憶しません。

## コマンドで応答する

Web UI を開かずに、同じ要求をコマンドで確認して応答できます。nas を起動したのと同じユーザーで、ホストのターミナルから実行します。コンテナの中からは実行できません。

保留中の要求を一覧します。

```sh
nas hostexec pending
nas network pending
```

一覧に出たセッション id と要求 id を渡して応答します。

```sh
nas hostexec approve <session-id> <request-id>
nas network approve <session-id> <request-id>
nas hostexec deny <session-id> <request-id>
nas network deny <session-id> <request-id>
```

`approve` の `--scope` は、画面の選択肢と次のように対応します。意味は上の 2 つの表を参照してください。

| `--scope` の値 | 画面の選択肢 |
| --- | --- |
| `once` | once / This request only |
| `capability` | Matching command for this session |
| `rule` | this rule |
| `host-port` | host:port |
| `host` | host |
| `violation` | these values |

省略したときの適用先は、通信とホスト実行で違います。通信では `once` になります。ホスト実行では `hostexec.prompt.defaultScope` の値になり、初期設定では `capability` です。

`deny` に `--scope` はありません。ホスト実行の拒否は画面と同じくその要求だけに効きます。通信の拒否は画面と違って範囲を記憶せず、その時点で保留中の同条件の要求をまとめて拒否します。範囲を記憶させたい場合は画面から拒否してください。

`nas hostexec review` と `nas network review` は、保留中の要求を一覧から選んでまとめて応答します。選択には [fzf](https://github.com/junegunn/fzf) を使うため、ホストに導入しておいてください。

## 自作のクライアントに組み込む

エディタなどから nas を使っていて、Web UI も[デスクトップ通知](/nix-agent-sandbox/configuration/notifications/)も使わない場合は、要求が届いたことを知る手段がありません。エージェントは時間切れまで止まったままになります。待ち時間は通信で `network.pendingTimeoutSeconds`、ホスト実行で `hostexec.prompt.timeoutSeconds` の値で、どちらも初期設定では 300 秒です。

`watch` は要求の増減を購読します。

```sh
nas hostexec watch
nas network watch
```

停止するまで、1 行 1 件の JSON を出力し続けます。`added` は要求が届いたこと、`removed` はその要求が無くなったことを表します。

```json
{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a1b2c3","requestId":"req_7","ruleId":"gcloud","cwd":"/home/u/proj","argv0":"gcloud","args":["auth","print-access-token"],"createdAt":"2026-09-16T04:12:03.114Z"}}
{"event":"added","domain":"network","entry":{"sessionId":"sess_a1b2c3","requestId":"req_9","host":"api.example.com","port":443,"state":"pending","createdAt":"2026-09-16T04:13:10.552Z","method":"POST","reviewContext":null,"ruleId":"$fallback","askReason":"scope-fallback","approvalScopes":["once","host-port","host"],"violations":null}}
{"event":"removed","domain":"hostexec","sessionId":"sess_a1b2c3","requestId":"req_7"}
```

`entry` には、画面のカードに出るのと同じ判断材料が入ります。ホスト実行では実行しようとしているコマンド（`argv0` と `args`）、作業ディレクトリ（`cwd`）、一致したルール（`ruleId`）です。通信では接続先（`host` と `port`）、メソッド、一致したルール（`ruleId`）、承認が必要になった理由（`askReason`）、その要求で選べる `--scope` の値（`approvalScopes`）です。

購読を始めた時点で残っている要求も `added` として出ます。`removed` は要求が無くなったことだけを伝え、許可、拒否、時間切れのどれで無くなったかは区別しません。自分の画面に出した要求を取り下げるために使います。

応答は上の `nas hostexec approve` などをそのまま呼びます。`watch` 専用の応答手段はありません。

nas はエディタ向けの連携パッケージを提供していません。要求を画面に出す部分と、応答のコマンドを呼ぶ部分は、利用する側で書くことになります。

### 自分のセッションだけを購読する

既定ではそのユーザーの全セッションの要求が流れます。複数のプロジェクトで nas を同時に使っていると、関係のない要求も届きます。

セッションを絞るには、nas を起動するときに `--write-session-id` でセッション id の書き出し先を指定し、その値を `--session` に渡します。

```sh
nas --write-session-id /tmp/nas-session-id claude
nas hostexec watch --session "$(cat /tmp/nas-session-id)"
```

`--write-session-id` はプロファイル名より前に置きます。nas は起動時にこのファイルへセッション id を 1 行で書くので、ファイルが現れたら読めます。不要になったら削除してください。nas は削除しません。ACP クライアントから起動する場合の指定方法は [ACP クライアントとの接続](/nix-agent-sandbox/configuration/acp/#承認の応答先)にあります。

`--session` を付けた `watch` は、そのセッションが終わると自身も終了します。終了コードは 0 です。セッションごとに購読を起こすクライアントは、後片付けを自分でしなくて済みます。セッションが登録される前に購読を始めても終了しません。一度見えたセッションが消えたときだけ終了します。

## 応答後の確認

操作が成功すると要求が Pending から消えます。許可した場合は、エージェント側で通信やコマンドの結果を確認します。拒否や時間切れでは、その要求が失敗します。カードにエラーが表示された場合は操作が完了していません。

Pending に要求がないまま作業が失敗している場合は、[監査ログ](/nix-agent-sandbox/work/troubleshooting/)を調べます。設定で直接拒否された要求は承認待ちにならないため、失敗の理由は監査ログにしか残りません。どう設定すれば承認待ちになるかは、上の[承認待ちになる条件](#承認待ちになる条件)を参照してください。
