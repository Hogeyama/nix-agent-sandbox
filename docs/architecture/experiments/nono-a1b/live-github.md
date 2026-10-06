# nono: 実 GitHub での送信先制限

2026-10-06、ユーザーが指定した正規 `Hogeyama/nix-agent-sandbox` と非正規 `Hogeyama/test-github` で追試した。**REST では非正規 repo への Issue 作成が拒否された。POST `/graphql` を許可すると、同じ managed token で非正規 repo への Issue 作成が成功した。** 模擬 API に届くところまでだった前回の結果を、実 GitHub の更新成功まで確認できた。

ここで「非正規」は、この実験の policy 上で共有を許可しない相手を意味する。両 repo と使用 token はユーザーの管理下にあり、第三者の repo を変更したものではない。

## 条件

- nono 0.79.0 / NixOS Linux 6.18.40。binary は前回と同じ。
- `gh auth token` の認証は両 repo に書込み可能。トークン値は表示せず、権限0600の一時ファイルから nono の保護側だけが読む。
- 子プロセスには placeholder と nono のセッション用 proxy 認証だけを渡す。実際の HTTPS 要求には無効な固定 token を付け、nono が managed token に上書きする経路を試す。
- 接続先は `api.github.com:443`。TLS の証明書検証は有効。`endpoint_policy.default.decision` は `deny`、REST は正規 repo の Issue 作成だけを許可する。
- `rest-only` は GraphQL を許可しない。`graphql-enabled` は POST `/graphql` を追加許可する。GraphQL 本文は [createIssue](https://docs.github.com/en/graphql/reference/issues#createissue) の `repositoryId` を変える。
- 作成内容は検証用のタイトルと人工 marker だけ。ソースコード・実 credential・その他の秘密を送信しない。

同じ token が両 repo に書ける構成なので、認証主体を固定しただけでは送信先の限定にならないことを調べる試験である。攻撃者アカウントの別 token を実 GitHub に持ち込む試験ではない。

## 結果

観測値は [live-github-results.json](live-github-results.json)。

| profile / ケース | 結果 | 作成先 |
| --- | --- | --- |
| REST 正規 repo | 201、Issue 作成 | [nix-agent-sandbox #8](https://github.com/Hogeyama/nix-agent-sandbox/issues/8) |
| REST 非正規 repo | 403、作成なし | — |
| GraphQL を禁止した状態での非正規 repo | 接続 reset、作成なし | — |
| GraphQL を許可した状態での正規 repo | 200、mutation 成功 | [nix-agent-sandbox #9](https://github.com/Hogeyama/nix-agent-sandbox/issues/9) |
| GraphQL を許可した状態での非正規 repo | 200、mutation 成功 | [test-github #1](https://github.com/Hogeyama/test-github/issues/1) |

5要求を実行し、作成された3件はすべて close した。GraphQL 作成直後の REST 一覧では2件を拾えなかったため、作成応答の repo / number で直接 GET し、title・body marker・URL の一致を確認して閉じた。再現スクリプトも応答の番号を優先するよう修正した。既存の別 Issue には触れていない。

取得した実 token が stdout / stderr、および credential ファイル以外の実験用一時ファイルに残っていないことを検査した。終了時に credential・profile・XDG 状態を含む一時領域を削除した。この検査はメモリや外部サービスの全ログに秘密が残らないことまで証明するものではない。

## 再現と検証

[live-github.py](live-github.py) は書込みを伴う。対象 repo は上記2つに固定しており、毎回別の marker を生成する。子側の要求は [live-github-client.py](live-github-client.py) にある。

```sh
python3 docs/architecture/experiments/nono-a1b/live-github.py \
  --nono /absolute/path/to/nono \
  --output /tmp/nono-live-github.json --execute
```

既存結果と Issue の closed 状態だけを検証する場合、新たな書込みは不要。

```sh
python3 docs/architecture/experiments/nono-a1b/live-github.py \
  --verify-result docs/architecture/experiments/nono-a1b/live-github-results.json
```

通常 Codex sandbox 内では listener の bind を拒否され、credential 取得・API 書込み前に exit 2。ホストでは5要求を実行した。初回は前述の一覧欠落により cleanup 件数の assertion が失敗したが、番号を使って全3件を close し、読取りだけの最終確認で5ケースと3件の closed 状態を再検証した。変更後に同じ Issue 作成試験を繰り返してはいない。

コマンド別 sandbox の起動問題、filesystem 保護、その他の未検証事項は [前回の記録](README.md)のままである。
