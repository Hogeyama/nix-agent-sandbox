# Docker Sandbox の hostname 許可と共有 IP の実測

系統5の A1a について、hostname 単位の network policy が IP で照合されていないかを調べた。照合が IP なら、許可した hostname と同じ IP を使う別の hostname にも接続できてしまう。[A1b の実測](../sbx-a1b/README.md)では、proxy を通らない `transparent` 経路が TLS を終端せずに GitHub へ届いたため、この経路で何を照合しているかが評価の前提になる。観測日は 2026-10-02、ホストは Linux、`sbx` は `v0.45.1`（`9d79d90ee4c5d297fb3d36b75384e8cea7a4fbcb`）。

**`transparent` 経路でも、許可は接続先 IP ではなく名前で判定された。** TLS では SNI、平文 HTTP では Host header を照合し、上流への接続先は sandbox 内で指定した IP ではなく、その名前を解決し直した先になった。名前を含まない接続は、sandbox が DNS で解決した許可 hostname の IP に対してだけ通った。許可した hostname と IP を共有する別の hostname へ、sbx の判定を通って接続する経路は見つからなかった。

## 構成

検証専用の Claude sandbox を workspace mount なし、`--skills off` で作った。ホストに既にあった global network policy は `api.anthropic.com`・`github.com`・`api.github.com`・`api.example.com` を port 指定なし（tcp）で許可しており、これを変更せずに使った。Claude kit が追加する hostname 許可も既定のままとした。secret は登録していない。

未許可の接続先には `example.org`（`172.66.157.237`、Cloudflare）を使った。sandbox 内からは `example.org` の名前解決自体が `DNS lookup blocked by proxy policy` で拒否されるため、IP はホスト側で解決して直接指定した。すべて `curl --noproxy '*'` または bash の `/dev/tcp` で `transparent` 経路を使い、判定は `sbx policy log --json` の `proxy_type`・`reason` と、応答した証明書・サーバで確認した。

## 観測結果

### 名前と接続先 IP を食い違わせる

| 試行 | 名前 | 指定した接続先 IP | 結果 |
| --- | --- | --- | --- |
| T1 | SNI `api.github.com`（許可） | `example.org` の IP | GitHub の `CN=*.github.com` 証明書と GitHub の応答 |
| T2 | SNI `example.org`（未許可） | `api.github.com` の IP | TLS 接続を切断。log は `example.org:443` を default deny |
| J | Host `api.github.com`（許可）、平文 HTTP | `example.org` の IP | GitHub の 301。log は `Request authority is not associated with the intercepted destination` を付けて `api.github.com:80` を許可 |
| K | Host `example.org`（未許可）、平文 HTTP | `api.github.com` の IP | 空応答。log は `example.org:80` を default deny |

T1 と J では、sandbox 内で指定した `example.org` の IP には届かず、名前から解決した GitHub が応答した。T2 と K では、許可先の IP を指定しても名前が未許可なら拒否された。許可した名前で未許可の IP へ接続することも、許可先の IP を使って未許可の名前へ接続することもできなかった。

### 名前を含まない接続

| 試行 | 接続 | 結果 |
| --- | --- | --- |
| F | SNI なしの TLS で `api.github.com` の IP へ | GitHub の証明書で接続 |
| G | `github.com` の IP（sandbox 内で解決済み）の 22 番へ TCP | GitHub の SSH banner。log は `github.com:22` を許可 |
| H | GitHub の別 IP `140.82.112.3`（sandbox 内で未解決）の 22 番へ TCP | banner なし。log は `140.82.112.3:22` を default deny |
| I | SNI なしの TLS で `example.org` の IP へ | 切断。log は `172.66.157.237:443` を default deny |

名前のない接続は、sandbox が DNS で解決した許可 hostname の IP に限って、その hostname として判定された。同じサービスの IP でも、sandbox 内で解決していなければ拒否された。

### 許可先サーバ内での Host の差し替え

sbx の判定とは別に、許可した hostname のサーバが TLS の内側の Host header で別のサイトへ振り分けるかを確認した。

| SNI | TLS 内の Host | 応答 |
| --- | --- | --- |
| `api.anthropic.com` | `claude.ai`・`console.anthropic.com`・`example.org` | いずれも Cloudflare の 403 |
| `api.github.com` | `gist.github.com`・`codeload.github.com`・`uploads.github.com` | いずれも GitHub の 400 |
| `github.com` | `gist.github.com` | gist のページを返した（`/starred` への 302、ユーザーページは 200） |
| `github.com` | `example.org` | `https://github.com/` への 301 |

`api.anthropic.com` の前段は SNI と Host の食い違いを拒否した。`github.com` は未許可の `gist.github.com` を返したが、これは同じ GitHub のサービスである。GitHub 内の取得先や書込み先の制限は A1b・P1 の問題として評価済みであり、A1a の第三者サーバへの流出には当たらない。第三者のサイトへ振り分けられた例はなかった。

### 付随して確認したこと

port を指定しない許可では、`github.com:22` の SSH や `api.github.com:80` の平文 HTTP も許可された。[比較構成](../../threat-model-configurations.md#系統5)は許可を `:443` に限っているため影響しないが、port の省略は TCP の全 port を許可する。

## 判定と実測の限界

`transparent` 経路は名前で判定し、上流への接続先も名前から決めていた。sandbox 内で接続先 IP を指定しても照合は変わらないため、許可した hostname と IP を共有する別の hostname は、この判定を通らない。名前を含まない接続も、sandbox 内で解決した許可 hostname の IP に限られた。この観測から、**系統5の A1a の ◎ は、共有 IP による許可の拡大で崩れない**と判定する。

ただし、次の点は確認していない。

- 判定方法は外部から観測した挙動であり、Docker の文書に照合方法の仕様は見当たらなかった。今後の版で変わり得る。
- 許可した hostname と未許可の第三者 hostname が実際に同じ IP を共有する組合せは用意していない。名前と IP を食い違わせた試行で代えた。
- 許可先サーバ内の Host の差し替えは、上の hostname の組合せだけを試した。許可先が第三者のサイトと同じ CDN の設定を共有し、Host で振り分ける場合は、sbx では止められない。その場合は許可先ごとの確認が必要になる。
- ECH、QUIC（UDP 443）、IPv6 の IP を直接指定した接続は試していない。

## 再確認するコマンド

既存の policy や secret を変更せず、検証用の環境で実行する。NAS 内からは `exec hostexec sbx "$@"` を内容とする wrapper を使った。`SBX_PROBE` は新規 sandbox 名、`EXAMPLE_IP` はホストで解決した `example.org` の IPv4、`GH_API_IP` は `api.github.com` の IPv4 とする。

```sh
sbx create --name "$SBX_PROBE" --skills off claude

# T1: 許可した SNI、未許可の IP
sbx exec "$SBX_PROBE" curl -vk --noproxy '*' --max-time 15 -o /dev/null \
  --connect-to "api.github.com:443:$EXAMPLE_IP:443" https://api.github.com/
# T2: 未許可の SNI、許可先の IP
sbx exec "$SBX_PROBE" curl -vk --noproxy '*' --max-time 15 -o /dev/null \
  --resolve "example.org:443:$GH_API_IP" https://example.org/
# J・K: 平文 HTTP の Host と IP の食い違い
sbx exec "$SBX_PROBE" curl -sS --noproxy '*' --max-time 10 -D - -o /dev/null \
  -H 'Host: api.github.com' "http://$EXAMPLE_IP/"
sbx exec "$SBX_PROBE" curl -sS --noproxy '*' --max-time 10 -D - -o /dev/null \
  -H 'Host: example.org' "http://$GH_API_IP/"
# 許可先サーバ内の Host の差し替え
sbx exec "$SBX_PROBE" curl -sS --noproxy '*' --max-time 15 -D - -o /dev/null \
  -H 'Host: claude.ai' https://api.anthropic.com/

sbx policy log "$SBX_PROBE" --json
sbx rm --force "$SBX_PROBE"
```

検証後、検証用 sandbox を削除し、`sbx ls` と `sbx secret ls` がともに空で、global policy が検証前と同じ4件の network allow であることを確認した。取得した template image は残している。
