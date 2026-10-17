# Docker Sandbox の認証注入と直接接続の実測

系統5の A1b について、許可済みの GitHub への通信で認証主体の固定を迂回できるか調べた。観測日は 2026-09-29、ホストは Linux、`sbx` は `v0.43.0`（`79805a6e3c6667520dc2da4f6bdeddae9b700969`）。

**通常の proxy 経由では認証 header が上書きされたが、`curl --noproxy '*'` で認証注入を通らず GitHub に到達できた。** この構成の認証注入は、許可 hostname 上の認証主体を固定する強制境界にはならない。

`v0.48.0` で[再測定](#v0480-での再測定と-http-ルール)した。hostname の許可だけでは同じ結果だった。その host に HTTP ルール（`--method` / `--path`）を1つでも加えると、直接接続は sbx が拒否した。GitHub の host を repo 単位の HTTP ルールだけで許可した構成では、試したすべての認証指定がホストの認証値へ上書きされた。許可外の repo・web 画面・port 22/80 も拒否された。Anthropic への認証 header は Claude kit の proxy が除去した。共通条件の fine-grained token と組み合わせれば、**系統5の A1b は ◎** と判定する。

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

### repo 単位の HTTP ルールだけで GitHub を許可する

proxy 経由の method/path も絞るため、global の `github.com`・`api.github.com` の hostname ルールを測定中だけ削除し、測定後に同じ内容で戻した。許可先は、検証用に作った private repo（以下 `R`）に限った。sandbox 単位で次の HTTP ルールだけを加え、[l7-probe.sh](l7-probe.sh) を sandbox 内で実行した。

| host | method | path |
| --- | --- | --- |
| `github.com:443` | `GET` | `/R.git/info/refs` |
| `github.com:443` | `POST` | `/R.git/git-upload-pack`・`/R.git/git-receive-pack` |
| `api.github.com:443` | `ANY` | `/repos/R`・`/repos/R/**` |
| `api.github.com:443` | `POST` | `/graphql` |

Claude kit が sandbox に追加する hostname ルールは `api.anthropic.com`・`platform.claude.com`・`downloads.claude.ai`・`claude.com`・`code.claude.com`・`mcp-proxy.anthropic.com`・`bridge.claudeusercontent.com` の各 `:443` で、GitHub の host を含まない。

| 区分 | 要求 | 結果 |
| --- | --- | --- |
| 許可 | `GET /repos/R`・`/repos/R/contents/README.md`（偽 token 付き） | 200。private repo の内容が返り、ホストの認証値が使われた |
| 許可外の REST | `GET /repos/cli/cli`・`GET /user`・`POST /user/repos`・`POST /gists`・`POST /repos/cli/cli/issues` | すべて 403（`Approval required`）。GitHub へは届かない |
| path の細工 | `R/../../cli/cli`・`%2e%2e`・`..%2f`・`R;x/../..` | 403。log は `http endpoint path must not contain ".." segments` |
| path の細工 | `//repos/cli/cli`・`/REPOS/cli/cli`・大小文字を変えた `R` | 403（default deny）。照合は大小文字を区別し、正規化しない側に倒れる |
| Host の差替え | `api.github.com` への接続に `Host: uploads.github.com` | 403。log は `host header mismatch` |
| GraphQL | `repository(owner:"cli",name:"cli")` の取得 | 200。本文の対象は検査されない |
| GraphQL | 存在しない ID への `addComment` mutation | 200 で GitHub の `NOT_FOUND`。mutation も GitHub まで届く |
| 直接接続 | `--noproxy '*'` で `api.github.com`・`github.com` | 切断（curl 35）。`l7 enforcement unavailable` |
| 他の port | `api.github.com:80`（proxy・直接）、`github.com:22` | 拒否（default deny） |
| 他の経路 | UDP 443 | 拒否（`Direct UDP connections not allowed`）。sandbox 内の `ip -6 route` は空で、curl は HTTP/3 非対応 |
| Git | `R.git` の clone、commit の push | 成功。push した branch がホストから見えた |
| Git | `.git` なしの `R` の clone、`cli/cli` の clone、`cli/cli` への `push --dry-run` | 失敗（403）。path が規則と一致しない |
| Git | `https://nas:<偽 token>@github.com/R.git` の `ls-remote` | 成功。Basic 認証もホストの認証値へ上書きされた |
| Git | proxy の環境変数を外した `ls-remote` | TLS handshake で失敗 |

許可外の要求は即座に 403 になり、同時に `sbx policy approval ls` に承認待ちとして並んだ。要求は承認を待たずに 403 で返った。承認した場合に追加されるルールの範囲は測定していない。

### 認証の指定方法と上書き

同じ HTTP ルールの sandbox で、[l7-auth-probe.sh](l7-auth-probe.sh) により認証の指定方法を変えた。`R` は private repo なので、偽の認証値が GitHub に届けば 404 か 401 になる。

| 指定方法 | 結果 |
| --- | --- |
| なし、`Bearer`、`token`、Basic（`-u`）、大小文字を変えた2つの `Authorization`、小文字の header 名、query の `access_token`、Cookie の `user_session` | すべて 200 で `R` の内容 |
| HTTP/1.0、HTTP/2 での偽 `Bearer` | 200 |
| GraphQL の `viewer` を偽 `Bearer` で | ホストのアカウント |
| `github.com` の `info/refs`（upload-pack・receive-pack）に偽 `Bearer`・偽 Basic | 200 で ref 一覧 |
| `github.com` の web 画面、偽 Cookie 付きの `POST /gists` | 403（HTTP ルールに一致しない） |

GitHub の web 画面は Cookie のセッションで認証し、`Authorization` header の注入では上書きされない。`github.com` を `/**` で許可すると、攻撃者のセッション Cookie による web 操作が残る。Git の3つの path に限れば、この経路も閉じる。

### Anthropic

Claude kit の `api.anthropic.com:443` は kit が管理するルールで、`sbx policy rm` は `managed by a kit and is recreated at sandbox create` として削除を拒否した。sandbox 単位の `sbx policy deny network` は kit の許可より優先し、`code.claude.com:443` への要求は `Denied by local rule` で拒否された。

secret を登録していない sandbox で、`api.anthropic.com` に偽の認証値を送った。`x-api-key`、大小文字を変えた `X-Api-Key`、2つの `x-api-key`、OAuth 形式の `Authorization: Bearer` のいずれも、Anthropic の応答は `x-api-key header is required` だった。proxy が認証 header を除去したことになり、偽の key は Anthropic に届かなかった。`api.anthropic.com:443` に `ANY /**` の HTTP ルールを加えると、直接接続も `l7 enforcement unavailable` で拒否された。kit の hostname ルールが残るので、proxy 経由の path はこのルールでは絞れない。

### 提案構成の通し確認

次節の判定に使う構成を、global の HTTP ルールと sandbox 単位の deny で組み、[e2e-probe.sh](e2e-probe.sh) で確認した。global の `github.com`・`api.github.com`・`api.anthropic.com` の hostname ルールは測定中だけ外し、測定後に戻した。

```sh
R=my-org/private-repo
sbx policy allow network api.anthropic.com:443 --method ANY --path '/**'
sbx policy allow network github.com:443 --method GET --path "/$R.git/info/refs"
sbx policy allow network github.com:443 --method POST --path "/$R.git/git-upload-pack"
sbx policy allow network github.com:443 --method POST --path "/$R.git/git-receive-pack"
sbx policy allow network api.github.com:443 --method ANY --path "/repos/$R"
sbx policy allow network api.github.com:443 --method ANY --path "/repos/$R/**"
sbx policy allow network api.github.com:443 --method POST --path /graphql
sbx secret set github --command 'gh auth token'
sbx create --name "$SBX_PROBE" --skills off claude
sbx policy deny network --sandbox "$SBX_PROBE" \
  platform.claude.com:443,downloads.claude.ai:443,claude.com:443,code.claude.com:443,mcp-proxy.anthropic.com:443,bridge.claudeusercontent.com:443
```

`R` への REST・GraphQL は偽 token のまま 200 でホストの認証値が使われ、`R.git` の clone と `push --dry-run` も通った。`cli/cli` の REST と clone、`POST /gists`、`github.com` の web 画面は 403 だった。3つの host への直接接続は切断された。deny した kit の6つの host は proxy 経由で 403、直接接続も切断された。Anthropic への偽 key は除去され、`x-api-key header is required` が返った。

### 判定と残る問題

`v0.48.0` で GitHub の host を repo 単位の HTTP ルールだけで許可すると、sandbox から GitHub に届く要求はすべて proxy の TLS 終端を通る。そこで認証値はホストのものに上書きされる。試した範囲では、上書きを逃れる認証の指定方法も、TLS 終端を通らない経路も見つからなかった。Anthropic への認証 header は kit の proxy が除去し、直接接続は HTTP ルールで閉じる。

GraphQL の本文は検査されないため、mutation は任意の repo を対象にできる。ただし実行される認証主体はホストの token に固定される。共通条件ではその token を自組織の必要な非公開 repo と最小限の permission に限るので、攻撃者が自分の credential を持ち込んで別の repo へ書き込む A1b-X の経路は残らない。この観測と共通条件から、**この構成の系統5-A1b は ◎** と判定する。GraphQL で公開 repo を読めることは P1 の問題として残る。

次の点は確認していない。

- 本物の Claude Code のセッション。`sbx secret set anthropic` の key の注入と、kit の6つの host を deny した状態での起動・応答は試していない。
- `gh` の各コマンドが、上の HTTP ルールの範囲で動くか。REST の `/repos/R/**` と GraphQL 以外を使うコマンドは拒否される。
- 承認待ちを承認したときに追加されるルールの範囲。
- 有効な攻撃者 token による書込み。上書きは偽 token で確かめた。fine-grained token の権限制限は GitHub 側の仕様に依存する。

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

repo 単位の HTTP ルール以降の測定は、上の各節のルールを加えた sandbox に probe を `sbx cp` で入れて実行した。引数は、注入される token で読める private repo である。

```sh
sbx cp l7-probe.sh "$SBX_PROBE":/tmp/l7-probe.sh
sbx exec "$SBX_PROBE" bash /tmp/l7-probe.sh my-org/private-repo
sbx policy log "$SBX_PROBE" --format json
sbx policy approval ls
```

実際の測定では応答 JSON から `login` と `message` だけを抽出し、status と curl 終了コードを記録した。`v0.43.0` の検証後、追加した global / sandbox 限定 secret と2つの検証用 sandbox を削除し、`sbx ls` と `sbx secret ls` がともに空であることを確認した。既存のホスト側 `gh` 認証情報は変更していない。初期化した global policy の `deny-all` と取得済み template image は残している。

`v0.48.0` の各測定後も、追加した global secret と検証用 sandbox を削除した。一時的に外した global の hostname ルールは同じ内容で戻した。`sbx ls`・`sbx secret ls`・`sbx policy approval ls` が空で、global policy が rule ID を除いて測定前と同じであることを確認した。sandbox 単位のルールと承認待ちは、sandbox の削除とともに消えた。検証用の private repo は測定後も残っている。
