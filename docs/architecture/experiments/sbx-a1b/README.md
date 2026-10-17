# Docker Sandbox の認証注入と直接接続の実測

系統5の A1b について、許可済みの GitHub への通信で認証主体の固定を迂回できるか調べた。観測日は 2026-09-29、ホストは Linux、`sbx` は `v0.43.0`（`79805a6e3c6667520dc2da4f6bdeddae9b700969`）。

**通常の proxy 経由では認証 header が上書きされたが、`curl --noproxy '*'` で認証注入を通らず GitHub に到達できた。** この構成の認証注入は、許可 hostname 上の認証主体を固定する強制境界にはならない。

`v0.48.0` で[再測定](#v0480-での再測定と-http-ルール)した。hostname の許可だけでは同じ結果だったが、その host に HTTP ルール（`--method` / `--path`）を1つでも加えると、直接接続は sbx が拒否した。

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

## v0.48.0 での再測定と HTTP ルール

観測日は 2026-10-17、ホストは Linux、`sbx` は `v0.48.0`（`5caf923e0587d376848f6f388eca3e0f5ca00e2d`）。この版の `sbx policy allow network` は `--method` と `--path` を受け付け、ローカルの policy に HTTP ルールを追加できる。v3 kit を使わず、組込み Claude の sandbox に直接適用した。

ホストの global network policy は `api.anthropic.com`・`github.com`・`api.github.com`・`api.example.com` を port 指定なしで許可しており、これを変更しなかった。検証用の Claude sandbox は workspace mount なし、`--skills off` で作り、HTTP ルールは sandbox 単位で追加した。

### 対照: 未許可 host の HTTP ルール

まず secret なしの sandbox で、global policy にない `httpbin.org` に `GET httpbin.org:443/get` の HTTP ルールだけを加えた。

| 経路 | 要求 | 結果 |
| --- | --- | --- |
| proxy | `GET /get` | 200。leaf 証明書は `Docker Sandboxes Proxy CA` 発行 |
| proxy | `POST /post`・`GET /anything`・`POST /get` | 403。log は `No matching allow rule (default deny)` |
| `--noproxy '*'` | `GET /get` を含む全要求 | TLS handshake 中に切断（curl 35）。log は `transparent` で `HTTP policy requires L7 enforcement, which is unavailable for transparent connections` |

続けて同じ sandbox に hostname ルール `httpbin.org:443` を加えると、proxy 経由の `POST /post` は 200 になった。直接接続は切断されたままだった。HTTP ルールと hostname ルールは proxy 経路では和として働き、直接接続の拒否は HTTP ルールの存在だけで決まる。

### GitHub の認証注入と直接接続

global secret `github` を `gh auth token` の command で登録し、新規作成した sandbox で測定した。今回は最初の sandbox で正常系が成立した。前半は global の hostname ルールだけ、後半は sandbox 単位で `GET api.github.com:443/user` の HTTP ルールを加えた状態である。

| 経路 | sandbox 内で指定した認証 | hostname ルールのみ | HTTP ルール追加後 |
| --- | --- | --- | --- |
| proxy `GET /user` | 認証 header なし | 200・ホストのアカウント | 200・ホストのアカウント |
| proxy `GET /user` | 偽の Bearer token | 200・ホストのアカウント | 200・ホストのアカウント |
| proxy `GET /rate_limit` | 偽の Bearer token | 200 | 200 |
| `--noproxy '*'` `GET /user` | 認証 header なし | 401 `Requires authentication` | 切断（curl 35） |
| `--noproxy '*'` `GET /user` | 偽の Bearer token | 401 `Bad credentials` | 切断（curl 35） |

前半は `v0.43.0` と同じで、直接接続は認証注入を通らず、プログラムが指定した token が GitHub に届いた。後半は直接接続が `l7 enforcement unavailable` で拒否され、proxy 経由では偽の token もホストの認証値へ上書きされた。proxy 経路の leaf 証明書は両方とも `Docker Sandboxes Proxy CA` 発行だった。

`GET /rate_limit` が後半も通ったのは、global の hostname ルールが HTTP ルールと和で効くためである。直接接続を塞ぐには HTTP ルールを加えるだけでよい。proxy 経由の method/path を絞るには、その host の hostname ルールを除いて HTTP ルールだけにする必要がある。

secret なしで同じ HTTP ルールを加えた対照でも、直接接続は拒否された。HTTP ルールのない `github.com` には、同じ sandbox から `--noproxy '*'` で 200 が返った。直接接続の拒否は host ごとに決まるため、使う host すべてに HTTP ルールが要る。

### 判定と残る問題

`v0.48.0` では、使う GitHub の host をすべて HTTP ルールで許可すれば、プログラムが指定した token を GitHub に届ける上の経路は閉じる。認証主体はホストの認証値に固定される。

それでも系統5の A1b は ○ のままとする。認証主体を固定しても、その主体で書き込める先が残るからである。公開 repo への issue・comment、gist、利用者自身の新規 repo がその例である。REST は path で repo を限定できる。一方、比較条件で許可する `POST /graphql` は本文で対象を指定するため、method/path では限定できない。提示構成にこの HTTP ルールを加えて ◎ とするには、GraphQL の扱いを別に決める必要がある。

次の点は確認していない。

- `github.com` の HTTP ルールと、その条件での Git over HTTPS の clone / push。
- repo を限定する REST の path ルールでの、許可・拒否の対照。
- Claude kit が追加する hostname ルールと HTTP ルールの関係。kit のルールは既定のまま残した。
- port 80 の平文 HTTP、QUIC、IPv6 の IP を直接指定した接続。HTTP ルールは `:443` に付けたので、port を書かない hostname ルールが許可する port 80 は別に扱われる可能性がある。
- 有効な攻撃者 token による書込み。直接接続は拒否まで、proxy 経由は偽 token の上書きまでを確かめた。

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

`v0.48.0` の再測定では、上の直接接続の比較に続けて、次のように HTTP ルールを加えて同じ要求を繰り返した。

```sh
sbx policy allow network --sandbox "$SBX_PROBE" api.github.com:443 \
  --method GET --path '/user'
sbx exec "$SBX_PROBE" curl -sS --max-time 20 -w '\n%{http_code} %{exitcode}\n' \
  --noproxy '*' -H 'Authorization: Bearer nas-a1b-invalid' https://api.github.com/user
sbx policy log "$SBX_PROBE" --format json
```

実際の測定では応答 JSON から `login` と `message` だけを抽出し、status と curl 終了コードを記録した。`v0.48.0` の再測定後も、追加した global secret と検証用 sandbox を削除し、`sbx ls` と `sbx secret ls` がともに空で、global policy が測定前と同じ4件の network allow であることを確認した。sandbox 単位の HTTP ルールは sandbox の削除とともに消えた。検証後、今回追加した global / sandbox 限定 secret と2つの検証用 sandbox を削除し、`sbx ls` と `sbx secret ls` がともに空であることを確認した。既存のホスト側 `gh` 認証情報は変更していない。初期化した global policy の `deny-all` と取得済み template image は残している。
