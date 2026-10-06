# read-only 設定の新規 PAT による Issue 作成の対照

**ユーザーが Contents / Issues / Metadata をすべて Read-only にして新規作成した fine-grained PAT でも、公開 repo `Hogeyama/nix-agent-sandbox` への Issue 作成が成功した。** 2026-10-06 にホストから確認した。nono / OpenShell の中での試験ではない。

## 試験の経緯

登録トークンを read-only、持込トークンを書込み可能にして、`GH_TOKEN=$ATTACKER_TOKEN gh issue create` が成功するかを比較しようとした。最初に `pass github/token/for-agent` を使ったが、この token だけでホストの `gh issue create` が成功した（[#13](https://github.com/Hogeyama/nix-agent-sandbox/issues/13)）。OpenShell でも登録 token の placeholder だけで作成できた（[#12](https://github.com/Hogeyama/nix-agent-sandbox/issues/12)）。両件は閉じ、すり替え段階へは進めなかった。

その後、ユーザーは新規 PAT を作り、GitHub の作成確認画面に次の権限が表示されたと共有した。

- 対象: all repositories
- Contents: Read-only
- Issues: Read-only
- Metadata: Read-only

この新規 token を `pass tmp` から取得し、単独の直接対照を行った。

## 条件と結果

`gh` は 2.90.0。実行ごとに空の `GH_CONFIG_DIR` と作業ディレクトリを作り、環境は PATH / HOME / USER と明示した gh 制御変数に限った。`GH_TOKEN` には `pass tmp` の値だけを設定し、既存の `GITHUB_TOKEN`・proxy 環境変数・他の認証設定は引き継いでいない。

| 対照 | 結果 |
| --- | --- |
| `gh api repos/Hogeyama/nix-agent-sandbox` | 読取り成功 |
| `gh issue create --repo Hogeyama/nix-agent-sandbox ...` | 終了コード0、[#14](https://github.com/Hogeyama/nix-agent-sandbox/issues/14) 作成成功 |
| `gh api --method POST repos/Hogeyama/nix-agent-sandbox/issues ...` | 終了コード0、[#15](https://github.com/Hogeyama/nix-agent-sandbox/issues/15) 作成成功 |
| Python `http.client.HTTPSConnection` で直接 POST（認証は `pass tmp` のみ） | HTTP 201、[#16](https://github.com/Hogeyama/nix-agent-sandbox/issues/16) 作成成功、閉鎖済み |
| 空の設定＋無効 token で `gh api user` | 終了コード1、`Bad credentials` |
| 空の設定で `gh auth token` が選ぶ値をメモリ内で比較 | `pass tmp` と一致 |

対象 repo の `private` は false、`visibility` は public。直接 TLS 接続で観測した `api.github.com` の証明書発行者は Sectigo Public Server Authentication CA DV E36 だった。Issue #14 / #15 は title・body の人工 marker と URL を確認して閉じた。後処理の書込み用認証は、作成試験のプロセスが終了した後に別プロセスで使い、作成する `gh` には渡していない。

## ここから言えること

「read-only と設定した fine-grained PAT なら、この Issue 作成経路を止められる」という前提は、今回の対照では成立しなかった。[公式 REST 仕様](https://docs.github.com/en/rest/issues/issues#create-an-issue)は fine-grained token の Issue 作成に Issues(write) を要求すると記載しており、ユーザーが共有した設定と今回の実測には食い違いがある。

原因を GitHub の不具合や特定の仕様と断定してはいない。非公開 repo、他の所有者、Issue 以外の更新操作は、この対照では調べていない。また、これを「持込トークンへのすり替えが成功した」と数えない。登録用 token 自体が書ける状態では、書込みの成否だけでどちらの token が使われたかを区別できないためである。

追加の直接 HTTPS 対照は `gh` の認証処理と proxy 環境変数を介さず、リダイレクトもしない。GitHub の応答は HTTP 201 と `X-Accepted-GitHub-Permissions: issues=write` を同時に返した。このヘッダーはエンドポイントの要求権限であり、使用した token が実際に持つ権限の証明ではない。作成後は従来どおり別のホスト認証で marker を照合して閉じた。

[公式の権限一覧の導入](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#about-permissions-required-for-fine-grained-personal-access-token)は、列挙した権限が非公開リソースのアクセスに必要であり、一部の公開リソースはその権限なしでもアクセス可能と説明している。ただし、Issue 作成の個別ページには公開 repo の例外が明記されていない。2025-11-20 の[同様の再現報告](https://github.com/orgs/community/discussions/180063)もあるが、GitHub による仕様の確定回答としては扱わない。公開 repo への参加操作と token の権限判定の関係が原因である可能性はあるものの、今回の試験だけでは確定できない。

同じ問題は 2026-06-09 の [github/docs #44656](https://github.com/github/docs/issues/44656) にも報告されている。報告者は fine-grained token と GitHub App installation token について、`metadata: read` だけでも公開 repo に Issue を作成できるとしている。参照時点では Closed だが、内部へコピーして公開 Issue を閉じる `fix-internally` ラベルが付いており、動作の修正完了を示すものではない。本試験の token は Contents / Issues / Metadata の3権限なので、metadata 単独の再現は行っていない。

## 記録と再現

### Secret Service の token 削除後の再試験

ユーザーが Secret Service の token を削除した後、`pass tmp` だけを使う直接 HTTPS の POST を再試行した。結果は再び HTTP 201 で、[#17](https://github.com/Hogeyama/nix-agent-sandbox/issues/17) を作成できた。一方、同じ token で `PATCH .../issues/17` に `state: closed` を送ると HTTP 403 (`Resource not accessible by personal access token`) だった。作成と閉鎖で結果が異なる。

空の gh 設定・GH_TOKEN なしでは credential を取得できず、明示した GH_TOKEN は `pass tmp` と一致した。後処理用の通常の `gh auth token` も取得できなかったため、#17 はこの時点で開いたままである。追加の gh 作成試験は実施せず停止した。通常 sandbox では pass の取得に失敗し、上記の実測はホストで実行したもの。記録は [tmp-token-after-secret-removal.json](tmp-token-after-secret-removal.json)、手順は [retry-after-secret-removal.py](retry-after-secret-removal.py) に保存した。

- [gh issue create の記録](tmp-token-check.json)
- [REST の記録](tmp-token-rest-check.json)
- [gh を介さない直接 HTTPS の記録](tmp-token-direct-check.json)
- [認証選択の対照](tmp-token-auth-controls.json)
- [最初の for-agent token の対照](token-swap-results.json)

[check-readonly-token.py](check-readonly-token.py) は、指定した pass entry の値を出力せずに読み、人工 marker の Issue 作成を1回試す。作成できた場合は本人の応答番号・title・body を照合して閉じる。対象 repo は上記 repo に固定している。

```sh
python3 docs/architecture/experiments/nono-a1b/check-readonly-token.py \
  --pass-entry tmp --output /tmp/readonly-gh.json --execute

python3 docs/architecture/experiments/nono-a1b/check-readonly-token.py \
  --pass-entry tmp --transport rest --output /tmp/readonly-rest.json --execute
```

token は実行中のメモリだけで扱い、argv や結果ファイルに保存しない。実行用の gh 設定は終了時に削除し、実験用一時ファイルに token の実値が残らないことを確認した。今回はホストで実行した。通常 Codex sandbox では外部接続が制限されるため、製品の防御の対照には使っていない。
