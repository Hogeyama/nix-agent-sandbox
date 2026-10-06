# 実 gh による token 置換試験の正常系確認

2026-10-06、OpenShell 0.1.2 の provider に `pass github/token/for-agent` の token を登録し、sandbox 内で実際の `gh issue create` を実行した。**この token だけで正規 repo への Issue 作成が成功したため、読取専用 token が書込みを拒否するという正常系は成立しなかった。持込み用 token への置換段階は実行していない。**

## 実測した範囲

| 段階 | 結果 |
| --- | --- |
| 通常 Codex sandbox 内で再現スクリプトを起動 | Docker 接続失敗、終了コード1。token 取得・GitHub 要求前に停止 |
| 承認付きホストで provider を登録 | `pass` から取得した値を専用環境変数の参照で登録。`gh auth token` の別 token とは異なる値であることだけを確認 |
| sandbox 内で正規 provider の placeholder を `GH_TOKEN` に設定し、正規 repo に `gh issue create` | 終了コード0。[Hogeyama/nix-agent-sandbox #12](https://github.com/Hogeyama/nix-agent-sandbox/issues/12) 作成成功 |
| 書込み用 token を stdin で持ち込み、非正規 repo に `gh issue create` | 未実施。正常系の前提が崩れたため、スクリプトが停止 |
| 後処理 | #12 を番号で直接 GET し、title/body marker・URL・nodeId を照合して close。追加 GET でも closed を確認 |

「読取専用」という名前の token が実際にどの操作を拒否するかは、名前だけでは判断できない。この実験は、登録した token で Issue 作成が成功したことを示す。token の全権限、別 token による OpenShell の権限制限回避を確認したものではない。ホストから同じ token を使う共通対照との照合が必要である。

実行結果は [token-swap-host-result.json](token-swap-host-result.json)、通常 sandbox の起動失敗は [token-swap-sandbox-result.json](token-swap-sandbox-result.json)、後処理と秘密の走査は [token-swap-verification.json](token-swap-verification.json) に保存した。

## 構成

前回の専用 Docker gateway 構成を使った。新規 image `nas-a1b-openshell-gh-client:20261006` に、ホストと同じ static ELF の `gh 2.90.0 (2026-04-16)` を `/usr/bin/gh` として COPY した。image の build は credential の配置前に行った。

REST は `POST /repos/Hogeyama/nix-agent-sandbox/issues` のみ許可し、GraphQL は `query` の `repository` と `mutation` の `createIssue` を許可した。全 endpoint は `enforcement: enforce`。追加の読取り許可は必要なかった。`gh issue create` は通常の GraphQL 経路を使用する。

sandbox 内の実コマンドは次の形である。title と body は人工 marker と試験用途だけを含む。

```sh
gh issue create --repo Hogeyama/nix-agent-sandbox \
  --title '[sandbox probe] OpenShell token swap <case> <runid>' \
  --body '<artificial marker and verification description>'
```

`GH_TOKEN` は Python が子プロセス環境へ設定した。今回実行した段階では provider の placeholder だけを使用している。持込み用 token はホスト内で取得したが、sandbox 内には送信していない。

## 秘密と後片付け

両 token は subprocess の出力をメモリに capture し、値を argv・ログ・通常ファイルに含めていない。provider 登録は `--credential NAS_GITHUB_PROBE_TOKEN` による環境変数参照を使用した。登録先の一時暗号化 DB、PKI、CLI config は削除した。実験 container / network / volume は空で、新しい gh 入り image は残している。

結果保存前に stdout / stderr を両 token の実値で走査した。最終確認では成果物と一時作業ファイルも同じ2値で走査し、痕跡がないことを確認した。ホストの既存認証設定・既存 Issue は変更していない。

## 再現スクリプト

[ホスト側](token-swap-probe.py)と [sandbox 内クライアント](token-swap-client.py)を残した。書込みの明示許可がある場合だけ実行する。正規 provider で作成が成功した場合は、それを閉じて攻撃段階へ進まず停止する。

```sh
python3 docs/architecture/experiments/openshell-a1b/token-swap-probe.py \
  --cli /path/to/openshell \
  --work /tmp/openshell-token-swap-new-run \
  --output /tmp/openshell-token-swap-result.json
```
