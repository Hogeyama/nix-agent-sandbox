# 双方向のポート転送を統一する

Status: Approved — 2026-09-08

Date: 2026-09-08

## この設計で決めること

読者は、host → container と container → host のポート転送を同じ方法で
設定・操作したい利用者と実装者。両方向とも config で起動時に設定でき、
起動後は CLI/UI で追加・削除できる仕様と、その実現方法をレビューする。
説明順は利用時の動作、設定と操作、互換性、通信経路、失敗時の扱い、検証とする。
詳細な関数分割とコミット順序は、承認後の実装計画で扱う。

`network.proxy.forwardPorts` は container → host の同番号の転送を起動時に作る。
host → container は `nas network bind` / `unbind` と UI で実行中に操作できる。
実装計画時点では container → host の `forward` / `unforward` も存在するが、
config 由来の転送はその動的管理に含まれない。ユーザーは、両方向で config と
on-demand の両方を利用できる形への統一を指定した。

## 利用時の動作

名前は SSH の `-L` / `LocalForward` と `-R` / `RemoteForward` に合わせる。
local は nas を起動するホスト、remote は対象コンテナに固定する。
コンテナ内から hostexec 経由で操作しても、この基準は変えない。
L/R は待受を置く側を表し、矢印は「接続を始める側 → サービスがある側」を表す。

| CLI / config | 方向 | 接続するアドレス | 転送先 |
| --- | --- | --- | --- |
| `-L` / `localForwards` | host → container | host の `127.0.0.1:hostPort` | container の `127.0.0.1:containerPort` |
| `-R` / `remoteForwards` | container → host | container の `127.0.0.1:containerPort` | host の `127.0.0.1:hostPort` |

参照: [OpenSSH ssh(1)](https://man.openbsd.org/ssh.1)、
[ssh_config(5)](https://man.openbsd.org/ssh_config.5)。
SSH と名前・待受側の意味を揃え、転送先アドレスは nas の loopback 制約に従う。

両方向とも TCP を扱い、異なるポート番号を指定できる。UDP、LAN 公開、
任意の転送先アドレス指定はこの変更に含めない。

config は新規セッションの初期値。CLI/UI の変更は対象セッションの間だけ有効で、
config を書き換えない。config 由来の転送も動的に削除でき、同じセッション中に
自動復活させない。次の新規セッションでは config の指定から再作成する。
セッション終了時に両方向の listener と接続を閉じる。

## 共通設定

新しい設定は profile の `network.localForwards` と `network.remoteForwards`。
各要素に `hostPort`、`containerPort` を持たせる。ポートは 1–65535。
設定キーが方向を決めるため、要素内に `direction` は書かない。
config では両ポートを必須とし、指定番号を勝手に変更しない。

評価後の設定例:

```json
{
  "network": {
    "localForwards": [
      { "hostPort": 8080, "containerPort": 3000 }
    ],
    "remoteForwards": [
      { "hostPort": 5432, "containerPort": 15432 }
    ]
  }
}
```

Pkl schema に対応する要素型を追加し、実装時に実行可能な Pkl 設定例を
ユーザーガイドへ載せる。内部では二つのリストを方向付きの共通モデルへ正規化する。
UI と CLI の一覧は方向、両ポート、由来
(`config` / `dynamic` / `internal`)、稼働状態を共通の情報として使う。

同一方向・同一 containerPort をセッション内の転送キーとする。
同じ対応への再追加は冪等。異なる hostPort への変更は削除後の再追加を求める。
config 内の完全重複は一つに正規化し、同じキーの異なる対応は設定エラーにする。
同方向の異なるキーが同じ listen ポートを要求する場合も競合として拒否する。

## CLI と UI

既存の `nas network bind` / `unbind` を拡張する。
新構文は `bind SESSION -L listenPort:targetPort` または
`bind SESSION -R listenPort:targetPort`。長い名前はそれぞれ
`--local-forward` / `--remote-forward` とする。
SSH と同じく左が待受、右が転送先。アドレスは両側とも `127.0.0.1` 固定のため省略する。
1 回の操作で 1 件を指定し、L/R の併用・繰り返しは usage error とする。

```sh
nas network bind SESSION -L 8080:3000
nas network bind SESSION -R 15432:5432
nas network unbind SESSION -L 8080
nas network unbind SESSION -R 15432
nas network bind
```

`unbind` は指定方向の待受ポートをセッション内で特定して削除する。
最後のコマンドは両方向を一覧表示する。既存の JSON 出力にも方向と由来を追加する。
利用者に見せる方向の指定は L/R に統一する。

新構文は両ポートを明示し、使用中の待受ポートを別番号へ自動変更しない。
既存の `bind SESSION:containerPort [hostPort]` は local forwarding の互換構文として
残し、hostPort 省略時の候補選択も現在の動作を維持する。
既存構文と L/R オプションの混在は拒否する。

既存の `unbind <host-port>` と `unbind SESSION:containerPort` は
local forwarding だけを対象とする。remote forwarding は新構文で削除し、
hostPort だけの削除は認めない（同じ host サービスを複数の転送で使えるため）。
引数なしの削除候補には両方向を表示し、選んだ方向とキーで削除する。

UI の Ports パネルに `Local (host → container)` / `Remote (container → host)`
の選択と両ポート入力を用意する。一覧にも方向を明記し、
host → container のみホストブラウザで開くリンクを表示する。
現在のコンテナ内 listener 検出は host → container の追加候補に用いる。
host 側のサービス自動検出は追加しない。
既存の `forward` / `unforward` と `forward SESSION` のホストポート候補表示は
互換入口として維持し、新しい UI にホスト自動検出を追加する作業は含めない。

## 既存設定と内部転送

`network.proxy.forwardPorts` は互換入力として受理し、各番号を
`network.remoteForwards` の `hostPort = containerPort` の対応へ正規化する。
新旧設定を合わせて重複・競合を検証する。ユーザー設定を自動書換えしない。
新しい説明と設定例では `network.localForwards` / `network.remoteForwards` を使う。

ユーザー指定により、schema の変更は後方互換にする。Pkl の `ProxyConfig` 型と
`forwardPorts` フィールド、既存の構築構文を残し、旧設定だけでも起動できる。
旧形式を理由に拒否したり、明示的な移行操作を起動の前提にしたりしない。

旧 `forwardPorts` が空でない profile には、設定ロード時に profile ごと一度、
stderr へ更新案内の warn を出す。空の schema デフォルトや nas 自身の内部転送には
出さない。新旧併記で重複が吸収されても、旧設定が残っている間は案内する。
JSON の標準出力を汚さず、UI の poll や接続ごとに繰り返さない。
警告には profile 名、旧キー、新キー、および同じポート対応の置換例を含める。
たとえば 5432 の旧設定は、`network.remoteForwards` に
`hostPort = 5432`、`containerPort = 5432` の要素を置くことを案内する。
実装時には新しい Pkl 型を使ったコピー可能な例と、移行ガイドへの参照を付ける。
非推奨の案内だけとし、この変更で削除期限を設定しない。

履歴・OTel receiver のため nas 自身が追加する転送も同じ通信管理を使い、
由来を `internal` とする。内部利用とユーザー設定が同一対応なら物理転送は共有し、
所有理由を別々に保持する。ユーザー分を削除しても内部所有分は残る。
UI は内部利用中であることを示し、CLI の削除応答も残る理由を明示する。
転送先が異なる競合は起動前に拒否する。

新しい動的操作は新しい nas で開始したセッションが対象。
既存セッションに relay の新機能がなければ再起動が必要と表示し、
既存の host → container 操作は可能な範囲で維持する。

## 通信と管理の構造

既存の `port_bind` broker、registry、domain service、container relay を
両方向へ拡張する。CLI と UI は共通の L2 domain service を経由する。
stage は計画と stage service の呼出しを担い、I/O とライフサイクル管理を
stage の `run()` に追加しない。

ホスト専用の管理ソケットで追加・削除を受け付ける。コンテナにはホスト所有の
relay 用 UDS のみを read-only でマウントする。container → host のための
ポート別ソケットと `local-proxy.mjs` の固定 listener ループは共通 relay へ移す。
これにより初期設定が空でも、コンテナの再起動や追加マウントなしで転送を追加できる。

host → container のデータ経路は既存方式を継続する。container → host では
ホストの broker が container relay に listener の作成・削除を指示する。
接続を受けた relay は、ホストが発行した転送識別子を使い UDS 経由で stream を
要求する。ホストは現在許可された対応から hostPort を解決し、loopback に接続する。
コンテナから任意の hostPort やアドレスを渡して接続させるプロトコルにはしない。
削除・再作成で識別子を更新し、古い識別子、別セッションの識別子、削除済みの
stream 要求を拒否する。

relay 用ソケット上の状態通知は、ホスト専用の追加・削除 API と分離する。
コンテナ側は自己承認や新しいホストサービスへのアクセス追加を行えない。
これは security-constraints の C2 と N1 を維持するための要件。

broker はコンテナ起動前に管理状態を準備する。初期転送がある場合は
エントリポイントから relay を agent より先に起動し、初期 listener の準備完了を
待って agent を開始する。初期転送がない場合は既存の on-demand 起動を維持する。
entrypoint 起動と supervisor の動的起動が競合しないよう、同じ readiness と
単一起動の管理に統合する。内部の履歴収集先も agent 起動時には利用可能とする。

## 競合、失敗、再接続

転送先サービスの未起動は許容する。listen の成功と転送先 probe の失敗を区別し、
サービスが後から起動すれば接続できる。一方、待受ポートの確保失敗は追加失敗。
config の待受ポートが確保できない場合は対象を明示して起動を失敗させ、
それまでに作成した資源を片付ける。

container 側の listener 作成には応答とタイムアウトを設け、確認前に active と
報告しない。コンテナ未起動時の動的な逆方向追加は失敗とする。
既存方向の「host listener は作成し、probe で未起動を示す」動作は維持する。

broker は操作を直列化し、両方向の一覧と実際の資源を一致させる。
registry 保存失敗時は新規追加を取り消す。削除時はまずホスト側の許可を失効させ、
転送中の接続も閉じる。relay が応答しない場合も新しいホスト接続を許可しない。
削除応答では container listener の撤去確認が取れたかを区別する。

relay 切断中は該当転送を unavailable と表示する。再接続時は broker の現在の
対応だけを再適用し、削除済みの config 転送を復活させない。
再接続時に listener を確保できなければ失敗状態と理由を表示する。

nas 自身の proxy・DinD 等の予約ポートを container 待受に使う要求は拒否する。
共有ネットワーク名前空間で別セッションが確保済みのポートも、実際の bind 失敗を
競合として扱う。動的な逆方向 listener は検出候補から除外する。
両方向の組合せだけで転送が循環する対応も拒否し、自己接続の増殖を防ぐ。

## 検証と受け入れ条件

- 新旧 config の正規化、範囲、重複、方向付きキー、CLI の既存引数互換性。
- L/R と localForwards/remoteForwards の方向一致、異番号での待受・転送先の対応、
  新構文の削除が待受ポートを使うこと、旧構文との混在・複数指定の拒否。
- 旧 Pkl 構文の評価と起動互換性、profile ごとの移行 warn、空の旧設定・
  新形式のみの場合に warn が出ないこと、JSON 標準出力への非混入。
- 両方向で config による開始、実行中の追加・削除、異番号の対応。
- config 転送の一時削除、relay 再接続時の維持、新規セッションでの復元。
- 転送先未起動、待受ポート競合、同時要求、保存失敗、relay 切断と復旧。
- 不正・古い・別セッションの識別子からホストへ接続できないこと。
- 内部転送とユーザー転送の共有、内部所有を残した削除、agent 起動時の準備完了。
- UI の方向表示、追加・削除、ホスト向けリンク、CLI/UI の一覧の一致。
- 実 Docker で loopback にのみ bind したサービスへ両方向で到達し、
  初期設定なしから再起動せず転送を追加できること。終了後に接続・listener が残らないこと。

テスト分類は test-policy に従う。反復中は unit と対象テストを実行し、
最後に post-change-checks の検証と `bun run test` を一度実行する。
Docker や外部ネットワーク条件による skip は実行済みの検証と区別して報告する。

## なぜこのアプローチを選んだか

利用者が求めたのは両方向で初期設定と実行中の操作を使えること。
config を共通の管理状態の初期入力とすることで、設定由来か動的追加かで
削除・一覧・競合の動作が分かれるのを防ぐ。既存 broker と relay の拡張なら、
ホストが転送を許可する境界と、既存の CLI/UI・registry を活用できる。

利用者向けの名前には SSH の local/remote forwarding を採用する。
既存知識で待受側を判断でき、CLI の L/R と config のキーが直接対応する。
local の基準はホストに固定し、実行場所で意味が逆転しないようにする。
設定を二つのリストで表しても、正規化後の管理は一つに保つ。

## 他のアプローチを採らない理由

逆方向専用の動的 broker を足す案は既存実装の変更が小さいが、一覧、資源管理、
復旧、予約ポート処理が二系統になる。両方向を同じ操作として扱う今回の目的に合わない。

ポート別 UDS を置くディレクトリ全体をマウントして追記する案も可能だが、
container 側の listener 管理は別途必要で、既存の双方向制御用 relay との
管理の重複を解消しない。共通 relay に明示的な許可対応を保持する案を選ぶ。

Docker のポート公開は起動後に自由に追加できず、container の loopback 上の
サービスへ届く既存動作も置き換えられないため採用しない。
