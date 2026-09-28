# Docker Sandbox の認証注入と直接接続の実測

系統5の A1b について、許可済みの GitHub への通信で認証主体の固定を迂回できるか調べた。観測日は 2026-09-29、ホストは Linux、`sbx` は `v0.43.0`（`79805a6e3c6667520dc2da4f6bdeddae9b700969`）。

**通常の proxy 経由では認証 header が上書きされたが、`curl --noproxy '*'` で認証注入を通らず GitHub に到達できた。** この構成の認証注入は、許可 hostname 上の認証主体を固定する強制境界にはならない。

## 構成と正常系の対照

未初期化だった global network policy を `deny-all` に設定した。検証専用の Claude sandbox を workspace mount なし、`--skills off` で作り、sandbox 単位で `api.github.com:443` と `github.com:443` を許可した。ホストの `gh auth token` を command secret として登録し、GitHub の `GET /user` だけを測定した。token の値は出力・記録していない。

通信部分を切り出した実験であり、比較設定の全再現ではない。clone mode は使わず、SSH forwarding の設定と Claude kit が追加する7つの hostname 許可も既定のままとした。今回の測定に SSH や追加 hostname は使っていない。Anthropic の認証注入は設定・測定していない。

最初に作った sandbox に、作成後から sandbox 限定の GitHub secret を登録した試行では、`GH_TOKEN` の使用を含め `GET /user` が 401 となり、ログは `forward-bypass` だった。global 登録の追加と sandbox の停止・再開でも、この sandbox では正常系を確認できなかった。原因は未確定であり、scope 単独の不具合とは判定しない。

**global secret 登録後に新規作成した別の sandbox では、認証 header なしでも 200 とホストの GitHub アカウントが返った。** 以下の迂回評価は、この正常系が成立した sandbox で行った。

## 観測結果

すべて同じ `https://api.github.com/user` を使用した。query のケースだけ `?access_token=nas-a1b-invalid` を追加した。

| 経路 | sandbox 内で指定した認証 | HTTP | 応答 |
| --- | --- | ---: | --- |
| proxy | `GH_TOKEN` を Bearer として使用 | 200 | ホストのアカウント |
| proxy | 認証 header なし | 200 | ホストのアカウント |
| proxy | 偽の Bearer token | 200 | ホストのアカウント |
| proxy | 偽の Basic 認証 | 200 | ホストのアカウント |
| proxy | 大文字・小文字を変えた2つの偽 Authorization header | 200 | ホストのアカウント |
| proxy | query に偽の access token | 200 | ホストのアカウント |
| proxy | Cookie に偽の `user_session` | 200 | ホストのアカウント |
| `--noproxy '*'` | 認証 header なし | 401 | `Requires authentication` |
| `--noproxy '*'` | 偽の Bearer token | 401 | `Bad credentials` |

通常経路では偽の認証指定でもホストのアカウントになるため、認証 header の上書きが働いている。一方、直接接続では偽 token に対する GitHub の拒否応答が返る。これは sandbox が通信を遮断した結果ではない。

TLS 証明書と `sbx policy log` も比較した。証明書検証は無効化していない。

| 経路 | leaf 証明書の subject / issuer | policy log の `proxy_type` |
| --- | --- | --- |
| proxy | `O = Docker Sandboxes, CN = api.github.com` / `Docker Sandboxes Proxy CA` | `forward` |
| `--noproxy '*'` | `CN = *.github.com` / `Sectigo Public Server Authentication CA DV E36` | `transparent` |

直接接続では Docker の CA による TLS 終端も認証注入も通っていない。[Docker の監視仕様](https://docs.docker.com/ai/sandboxes/governance/monitor-and-enforce/monitoring/)も、`transparent` では network policy を適用するが credential injection は利用できないとしている。

## 判定と実測の限界

実測したのは、正常な代理認証と、それを通らず許可 hostname へ任意の認証 header を送れる経路である。有効な攻撃者 token による第三者 repo への書込み、Git push、Anthropic Files API は試していない。

A1b-X は攻撃者が有効な credential を持ち込む前提である。認証注入を通らない GitHub への TLS 接続が成立し、提示した network policy は hostname 単位なので、その経路で攻撃者の credential を使う操作を制限する根拠がない。この観測と脅威モデルから、**提示構成の系統5-A1b は ○（必須の ◎ に未達）**と判定する。第三者への書込み成功を実測したという意味ではない。

## HTTP 制限による改善案の確認

この実験の結論は hostname 単位の許可を使った構成に限る。v3 kit の [`network-policy@2`](https://github.com/docker/sandbox-kit-spec/blob/main/docs/spec/capabilities/com.docker.sandbox/network-policy%402.md) は method/path を制限でき、検査できない接続を拒否する仕様である。この構成での直接接続の拒否は、今回測定していない。

併用方法を調べたところ、[組込み Claude は v2 kit で、v3 mixin と併用できない](https://docs.docker.com/ai/sandboxes/customize/#version-compatibility)ことが分かった。ローカルの `spec.yaml` に `schemaVersion: "3"` と `network-policy@2` の `capabilities` を記述し、v0.43.0 の `kit validate` と `create claude --kit <directory>` に渡した試行も、次の decode error で作成前に終了した。

```text
field capabilities not found in type spec.SpecFile
```

このエラーは従来の `spec.yaml` 入口での拒否であり、正しい v3 artifact のロードや、v3 workload と mixin の組合せを試した結果ではない。次の検証では全体を v3 に揃え、通常の許可 request、未許可 method/path、直接接続の3つを対照にする必要がある。組込み Claude の今後の対応も検討対象とし、対応時期や成功は既定としない。

## 再確認するコマンド

既存の policy や secret を変更せず、検証用の環境で実行する。NAS 内からは `exec hostexec sbx "$@"` を内容とする wrapper を使った。以下はホスト上のコマンド表記で、`SBX_PROBE` は新規 sandbox 名とする。

```sh
sbx version
sbx secret set github --command 'gh auth token'
sbx create --name "$SBX_PROBE" --skills off claude
sbx policy allow network --sandbox "$SBX_PROBE" api.github.com:443,github.com:443

# 正常系: header なしでも注入されたアカウントとして 200 になることを先に確認する
sbx exec "$SBX_PROBE" curl -sS --max-time 20 -w '\n%{http_code}\n' \
  https://api.github.com/user

# 同じ偽 token を proxy 経由と直接接続で比較する
sbx exec "$SBX_PROBE" curl -sS --max-time 20 -w '\n%{http_code}\n' \
  -H 'Authorization: Bearer nas-a1b-invalid' https://api.github.com/user
sbx exec "$SBX_PROBE" curl -sS --max-time 20 -w '\n%{http_code}\n' \
  --noproxy '*' -H 'Authorization: Bearer nas-a1b-invalid' https://api.github.com/user

sbx policy log "$SBX_PROBE" --json
```

実際の測定では応答 JSON から `login` と `message` だけを抽出し、status と curl 終了コードを記録した。検証後、今回追加した global / sandbox 限定 secret と2つの検証用 sandbox を削除し、`sbx ls` と `sbx secret ls` がともに空であることを確認した。既存のホスト側 `gh` 認証情報は変更していない。初期化した global policy の `deny-all` と取得済み template image は残している。
