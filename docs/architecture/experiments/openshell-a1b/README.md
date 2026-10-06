# OpenShell の認証値持込みと GraphQL 送信先制限の実測

OpenShell 0.1.2 では、**REST の method/path 制限は直接 TLS にも適用された。一方、credential provider は placeholder を置換し、任意の認証値を固定値へ上書きしない。GraphQL の許可操作でも repository 引数を変えた要求が通った。** この組合せでは、指定 repo の GraphQL 更新を許可しながら A1b の攻撃者 repo への送信を阻止するところまで届かない。

これは製品全体の脆弱性判定ではなく、[比較の A1b](../../threat-model.md) を満たす構成を作れるか調べた評価である。追加 middleware 等の独自実装は評価していない。

## 環境と構成

観測日は 2026-10-06。Linux NixOS、kernel 6.18.40、Docker 29.6.2、公式 OpenShell CLI / gateway / supervisor / sandbox image は 0.1.2。CLI バイナリ SHA-256 は `f334da80f867776dde9034e0ca3c2406d48ba77b0d0abe64b5aa610490a34fca`。調査ソースは [v0.1.2](https://github.com/NVIDIA/OpenShell/tree/v0.1.2)（取得 archive のディレクトリ名は `NVIDIA-OpenShell-6648bd0`）。

専用 Docker gateway を loopback の固有 port に起動し、一時 PKI の mTLS と起動単位の JWT 認証を使用した。既存 gateway / global policy は変更していない。CLI の状態は専用 `XDG_CONFIG_HOME`、gateway の状態は専用 `/tmp` 配下である。Docker driver は workload の network を `none` にし、ホストネットワーク上の別 supervisor が外部通信を行う。

新規 Ubuntu 24.04 image に curl / Python を入れた。ホストの作業ツリー・認証ファイルは workload に mount せず、`--no-auto-providers` で既存 credential の自動取得を無効にした。gateway に渡した環境変数は一時 state / TLS / DB の指定と telemetry 無効化のみ。再現スクリプトは CLI の環境も PATH と専用 XDG 設定等に限る。sandbox の proxy 環境変数は空だった。

[policy.yaml](policy.yaml) と [profile.yaml](profile.yaml) はすべて `enforcement: enforce`。共有先を REST path では `/repos/my-org/private-repo` とその Issue 作成に限定し、GraphQL では `repository` query と `createIssue` mutation を許可した。`access: full` や hostname 全体の別 allow は加えていない。

実験は次の2つを分けて行った。

- **ローカル HTTP fixture**: Docker bridge のホスト IP に置いた使い捨て HTTP server。認証値は `nas-managed-fake` と `nas-attacker-fake`、本文は架空 repo ID と `nas-a1b-fake-canary` のみ。provider が渡した placeholder の置換と、別 token・GraphQL 本文が上流へ届くかを確認する。fixture は GraphQL を実行せず、受け取った本文と認証値の分類だけを返す。
- **実 GitHub HTTPS**: `GET /user` のみを許可し、認証なしまたは偽 token を送る。GitHub 用 credential provider は付けていない。この試行は透過 TLS 検査と method/path 制限の確認であり、HTTPS 上の代理注入の正常系を確認したものではない。

## 結果

[results/results.jsonl](results/results.jsonl) に23件の記録があり、22ケースを実行、SOCKS 1件は未実施。最終 fixture が受信した内容は [fixture-final.jsonl](results/fixture-final.jsonl)、拒否理由は [openshell.log](results/openshell.log) に残した。

| ケース | 結果 | 言えること |
| --- | --- | --- |
| R0: provider の placeholder | 200、fixture は `managed` を受信 | 代理注入の正常系が成立 |
| R1 / R2: 同じ URL に持込 token / 認証なし | 200、`attacker` / `absent` | provider は認証主体を固定しない |
| R3: 許可 REST path へ偽 token と canary を POST | 200、`attacker` と canary を受信 | 許可操作の認証値・本文はそのまま通る |
| R4 / R5: 別 repo の REST path / 未許可 PUT | 403、`policy_denied` | REST の repo・method 制限は働く |
| R6 / R7: 未許可 port / hostname | 接続失敗、supervisor に deny ログ | 未許可宛先は拒否。port 側の fixture はホストから200となる対照あり |
| G0 / G1: `repository` の owner/name を正規 / 攻撃者に変更 | 両方200、本文を受信 | 操作名・最上位フィールドの許可は repo 指定の制限にならない |
| G2 / G3: `createIssue` の repositoryId を正規 / 攻撃者に変更 | 両方200、偽 token と canary を受信 | 同じ許可 mutation で書込み対象を変更できる |
| G4: 未許可 `deleteRepository` | 403、GraphQL operation blocked | GraphQL 検査自体は有効 |
| G5: GraphQL variables で攻撃者 repo を指定 | 200、本文を受信 | variables でも同じ結果 |
| N0 / N1: GitHub `/user` に認証なし / 偽 token | 401 `Requires authentication` / `Bad credentials` | 偽 token が実 GitHub の認証処理へ届く |
| N2 / N3: `--noproxy '*'` で許可 / 禁止 API path | 401 `Bad credentials` / OpenShell の403 | NO_PROXY は L7 制限の迂回にならない |
| N4: fixture への `--noproxy '*'` | 200、`attacker` | 通常通信と同じ |
| N5: SOCKS | 未実施 | 製品はこの構成で proxy URL を環境変数に渡さない。SOCKS 経路が存在しないと証明したものではない |
| N6 / N7: Python の生 socket + TLS で許可 / 禁止 API path | OpenShell Sandbox CA、401 / 403 | クライアントの proxy 設定に依存せず TLS と HTTP を検査 |
| N8: 許可 `api.github.com:443` に SSH greeting の生 TCP | 403 `unsupported_l7_protocol` | REST endpoint で検査不能なプロトコルを拒否 |

R0 と R1 は同じ sandbox、同じ URL、同じ provider を使用した。初期設定の不具合で代理注入が全く働いていない環境を、持込 token が通る証拠にはしていない。

## ソースとの照合と評価範囲

公式 [GraphQL schema](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/docs/how-it-works/policies/schema.mdx#graphql-rules) は `operation_type`、`operation_name`、`fields` を定義する。[GraphQL classifier](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-supervisor-network/src/l7/graphql.rs) の `classify_document` / `collect_root_fields` も最上位フィールド名を集める。repo の引数や mutation input を許可先と照合する機能としては記述されていない。

[credential の実装](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-core/src/secrets.rs) の `rewrite_header_value` は、解決可能な placeholder を置換し、予約 marker を含まない別の値には `Ok(None)` を返す。これは R0〜R2 の観測と一致する。

**指定 repo への REST path 制限は、今回の通常・直接 TLS・生 TCP 対照を通った。一方、GraphQL を指定 repo の取得・更新に使う共通要件では、provider と標準 GraphQL rule だけで A1b-X を満たすとは言えない。** 攻撃者が有効な自分の token と repo ID を持ち込める脅威モデルでは、G3 と同形の要求で第三者 repo に書き込めると推論する。

実際に GitHub の第三者 repo に書き込んだわけではない。GraphQL の更新成功、Git push、HTTPS fixture 上の credential 置換、TLS の全異常系、独自 middleware、別 compute driver・OS は未検証である。HTTP fixture での要求通過と、GitHub 上の権限評価・更新成功を同一視しない。REST だけに用途を狭めた構成や追加実装まで不可能と判断するものでもない。

## 再現と後片付け

Docker に接続できる Linux ホストで、公式 v0.1.2 CLI を用意して実行する。ビルド・image 取得にネットワークが必要で、bridge IP と4つの空き port（既定27670、27671、27680、27681）を使う。

```sh
python3 docs/architecture/experiments/openshell-a1b/probe.py \
  --cli /path/to/openshell \
  --work /tmp/openshell-a1b-new-run
```

`--work` は空のディレクトリにする。[probe.py](probe.py) が専用 gateway / fixture / sandbox を作り、[client.py](client.py) を実行し、結果を `logs/` に保存する。sandbox の binary 許可は `/usr/bin/curl` と `/usr/bin/python*` である。

成功・失敗とも `finally` で当該 run の sandbox、supervisor、gateway、ラベルが一致する network / volume、fixture process を削除する。PKI・CLI config・DB も当該 run の一時領域から削除する。共有 image cache は削除しない。残した image と digest は [environment.json](results/environment.json) に記録した。初回手動試行と再現スクリプト実行後、実験ラベルの container / network / volume が空であることを確認した（[cleanup.json](results/cleanup.json)）。

起動時には次の調整が必要だった。公式 `deploy/docker` の plaintext 例では Docker driver が launch-scoped authentication を要求して作成を拒否したため、一時 mTLS/JWT を使った。`grpc_endpoint` は `https://127.0.0.1:<port>` にした。`host.openshell.internal` を指定するだけではこの版の supervisor から名前解決できなかった。fixture を127.0.0.1に置くと workload 自身の loopback に接続するため、ホスト bridge IP を指定した。profile の endpoint 更新直後は旧 credential scope のままだったため、最終測定は更新後に provider と sandbox を新規作成して実施した。

## 実行環境ごとの検証結果

| 実行環境 | 再現スクリプトの結果 | ケース実行・未実施 |
| --- | --- | --- |
| 通常の Codex sandbox 内 | 終了コード1。最初の `docker network inspect bridge` が `/var/run/docker.sock` への接続権限不足で失敗 | ケースは0件。OpenShell gateway / sandbox 作成前に停止したため、製品の防御結果には数えない |
| 承認付きホスト実行 | 終了コード0。新規環境での再現実行成功 | 22ケース実行。SOCKS 1件は proxy URL がないため未実施 |

この環境には `hostexec` がないため、ホスト側は承認付きの sandbox 外実行を用いた。通常 sandbox 内の失敗ログは [sandbox-execution.log](results/sandbox-execution.log)、ホスト実行の観測値は [results.jsonl](results/results.jsonl) に保存した。通常 sandbox 内では Docker リソースを作成しておらず、ホスト実行後の削除確認は [cleanup.json](results/cleanup.json) のとおりである。

実験スクリプトの検証以外に nas の製品テストは実行していない。

## 実 GitHub での追加確認

利用者の明示許可を得て、正規 `Hogeyama/nix-agent-sandbox` と非正規 `Hogeyama/test-github` に、人工 marker だけの Issue 作成を試した。正規 REST は成功、非正規 REST は403、GraphQL `createIssue` は両 repo で成功した。作成した3件は marker と URL を確認してすべて閉じた。[実 GitHub 試験の設定・結果・後処理](live-github.md)を参照。

この追加試験では同じ token が両 repo に書込み可能であり、**repo 送信先制限と実 HTTPS 上の代理注入**を確認した。別の攻撃者アカウントの token 持込み試験ではない。上記の「実 GitHub の更新成功は未検証」という限界は最初の fixture 試験についての記述で、追加試験では Issue 作成の範囲を実測した。
