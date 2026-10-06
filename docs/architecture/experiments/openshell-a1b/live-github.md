# OpenShell 0.1.2 の実 GitHub Issue 作成試験

**正規 repo の REST 作成は成功し、非正規 repo の REST 作成は拒否された。GraphQL の `createIssue` は正規・非正規の両 repo で成功した。** 2026-10-06 に、利用者が指定した repo と認証情報で確認した。

- 正規の共有先: `Hogeyama/nix-agent-sandbox`
- 共有を許可していない比較先: `Hogeyama/test-github`
- 認証情報: 両 repo に書込み可能な同じ `gh auth token`。これは **送信先制限の試験**であり、別の攻撃者アカウントの認証情報を持ち込む試験ではない。

ホストからの事前読取りで両 repo の Issue 有効化と書込み権限を確認した。OpenShell の一時 provider に認証情報を登録し、sandbox は provider の placeholder を使った。正規 REST の成功により、前回の HTTP fixture に加えて **実 HTTPS 上の代理注入の正常系**も確認できた。

## Policy と結果

provider の endpoint rule はすべて `enforcement: enforce`。`api.github.com:443` の REST は `POST /repos/Hogeyama/nix-agent-sandbox/issues` だけを許可した。同じ host の `/graphql` は `operation_type: mutation`、`fields: [createIssue]` を許可した。repo 引数の制約や hostname 全体の allow は追加していない。基本 policy の `network_policies` は空で、この provider の rule が合成される構成である。

| 要求 | 結果 | 作成 Issue / 後処理 |
| --- | --- | --- |
| 正規 REST | 作成成功 | [nix-agent-sandbox #10](https://github.com/Hogeyama/nix-agent-sandbox/issues/10)、closed |
| 非正規 REST | OpenShell の403 `policy_denied` | 作成なし |
| 正規 GraphQL | `createIssue` 成功 | [nix-agent-sandbox #11](https://github.com/Hogeyama/nix-agent-sandbox/issues/11)、closed |
| 非正規 GraphQL | `createIssue` 成功 | [test-github #2](https://github.com/Hogeyama/test-github/issues/2)、closed |

GraphQL の正規・非正規要求は同じ mutation と認証情報を使い、`repositoryId` と人工 marker だけを変えた。**標準の操作・最上位フィールド制限は、同じ許可操作の repositoryId を正規 repo に限定しない**という fixture での観測が、実 GitHub の書込み成功でも確認された。

Issue の title は `[sandbox probe] OpenShell <case> <runid>`、body は人工 marker と検証用途の説明だけである。プロジェクトデータ、secret、ソースは送信していない。作成応答の URL / number / nodeId / repo / status だけを抽出した記録は [live-github-host-result.json](live-github-host-result.json) にある。`observations` の `open` は作成直後の状態で、`cleanup_issues` に最終的な `closed` を記録した。

## 秘密の扱いと後処理

ホストの token は `gh auth token` の subprocess 出力をメモリに capture し、provider 作成時の専用環境変数にだけ渡した。`--credential NAS_GITHUB_PROBE_TOKEN` の環境変数参照を使い、token 値を argv に含めていない。既存の利用者環境変数や認証ファイルを workload に渡していない。

CLI / API の生出力はメモリ上にとどめ、token の実値が含まれないことを保存前に確認した。provider の暗号化 DB、PKI、専用 CLI 設定は実験後に削除した。実験用 container / network / volume も空である。前回取得した image cache は残している。

最初の後処理では、GitHub の Issue 一覧に作成直後の GraphQL Issue が現れず、削除候補を拾えなかった。作成応答に含まれる番号で3件を直接 GET し、title / body の人工 marker、URL、nodeId の一致を確認して、ホスト `gh api` から閉じた。既存 Issue は変更していない。最後に追加の書込みをせず3件を GET し、marker 一致と closed を再確認した。成果物・一時作業ファイルの token 実値走査と PKI / DB 削除確認も通った（[最終読取り確認](live-github-verification.json)）。

再現スクリプトも、作成応答の番号による直接確認を主な後処理に変更した。Issue の再作成はせず、この変更は構文と処理内容を確認した。作成応答を失った場合だけの一覧による補助検索には反映遅延の限界がある。

## 実行環境と再現

| 環境 | 結果 |
| --- | --- |
| 通常 Codex sandbox | Docker 接続で終了コード1。token 取得・GitHub 書込み・資源作成より前に停止。[記録](live-github-sandbox-result.json) |
| 承認付きホスト実行 | 終了コード0。4要求、3 Issue 作成、3件とも closed。`hostexec` がないため承認付き sandbox 外実行を使用 |

ホストの初期2試行は profile 登録で書込み前に停止した。2回目は gateway への接続拒否を確認したため、稼働確認を追加した。最終試行だけが上記4要求を送った。試行ごとの Docker / PKI / DB は削除済み。

ユーザーが指定した repo への Issue 作成と後処理を許可した場合だけ、Docker に接続できるホストで実行する。公式 v0.1.2 CLI と前回の client image を使う。

```sh
python3 docs/architecture/experiments/openshell-a1b/live-github-probe.py \
  --cli /path/to/openshell \
  --work /tmp/openshell-live-new-run \
  --output /tmp/openshell-live-result.json
```

[ホスト側スクリプト](live-github-probe.py) は一時 gateway / provider / sandbox を作り、[sandbox 内クライアント](live-github-client.py) を実行する。通常3 Issue、非正規 REST が予想外に許可された場合のみ計4 Issue が上限となる。例外時にも Issue の確認・close と実験資源の削除を試み、後処理失敗を結果に残す。
