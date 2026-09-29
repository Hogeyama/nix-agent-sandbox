# srt の TLS 終端を通らない経路の実測

[脅威モデルの選定](../../threat-model.md)の系統2では、srt をライブラリとして組み込み、`filterRequest` で要求ごとに許可・拒否すれば A1b・P1 を改善できるかを検討した。`filterRequest` が呼ばれるのは、平文の HTTP と、srt が TLS を終端した HTTPS の要求だけである（srt の `request-filter.d.ts`）。そこで、sandbox 内のプログラムが TLS 終端を通らずに許可先へ届く経路があるかを調べた。

**TLS 終端を通らない経路が3つ確認できた。SOCKS 経由、TLS 以外のプロトコル（SSH）、`excludeDomains` に入れたホストである。** これらの経路では `filterRequest` による検査も認証情報の代理注入も通らないので、`filterRequest` を実装するだけでは A1b・P1 は ◎ にならない。

観測日は 2026-09-29。環境は Linux（NixOS）、srt 0.0.77（`srt --version` は 1.0.0 と表示）、bubblewrap 0.11.2、socat 1.8.0.3、curl 8.21.0、OpenSSH 10.4p1。

## 方法

`filterRequest` は関数なので JSON 設定には書けないが、呼ばれるかどうかは TLS が終端されるかどうかで決まる。そこで srt の CLI で `tlsTerminate` を有効にし、次の2点で経路を判定した。

- curl が受け取ったサーバ証明書の発行者。srt の CA（`sandbox-runtime ephemeral CA`）なら srt が TLS を終端しており、公開 CA（Sectigo）なら GitHub と直接 TLS を張っている。
- `srt --debug` のログ。接続の許可・拒否と、TLS を終端せずに中身を見ないまま中継した（`opaque-tunnelling`）かが出る。

[probe.sh](probe.sh) をホストで実行し、ケースごとに [settings/](settings/) の設定で srt を起動した。環境変数は `env -i` で最小限にした。sandbox 内のコマンドは、srt が sandbox に渡す環境変数（`HTTPS_PROXY`、`GIT_SSH_COMMAND`）だけを使う。proxy の認証情報も、sandbox 内で `HTTPS_PROXY` から取り出した。GitHub API には固定の偽 token `nas-a1b-invalid` を送り（[sbx-a1b](../sbx-a1b/README.md) と同じ値）、SSH にはその場で作った使い捨ての鍵を使った。`~/.ssh` と `~/.config/gh` は `denyRead` にした。

TLS 終端を通らない経路では、curl に `--cacert` でシステムの CA bundle を指定した。どの CA を信頼するかは sandbox 内のプログラムが決められるので、攻撃者も同じことができる。

## 観測結果

| ケース | 許可リスト（`allowedDomains`） | sandbox 内の操作 | 証明書の発行者 / debug ログ | 結果 |
| --- | --- | --- | --- | --- |
| C0 対照 | `api.github.com:443`, `github.com:443` | `HTTPS_PROXY` 経由で認証なしの `GET /user` | srt の CA / `Allowed by config rule: api.github.com:443` | 401 `Requires authentication`。ポートを付けた許可でも HTTPS は通る |
| C1 対照 | `api.github.com`, `github.com` | `HTTPS_PROXY` 経由で偽 token 付き `GET /user` | srt の CA | 401 `Bad credentials`。TLS が終端される経路で、ライブラリなら `filterRequest` が呼ばれる |
| C2 | 同上 | 同じ proxy URL の scheme を `socks5h://` に変えて同じ要求 | Sectigo / `Opened SOCKS connection ... via 127.0.0.1 port 3128` | 401 `Bad credentials`。TLS 終端を通らない |
| C3 | 同上 | `socks5h://<proxy の認証情報>@localhost:1080` で同じ要求 | Sectigo / SOCKS 接続 | C2 と同じ |
| C4 | 同上 | `$GIT_SSH_COMMAND -p 22 -T git@github.com` | `Allowed by config rule: github.com:22`、`non-TLS bytes on CONNECT github.com:22; opaque-tunnelling` | `Permission denied (publickey)`。GitHub の sshd まで届いた |
| C5 対照 | `api.github.com:443`, `github.com:443` | C4 と同じ | `No matching config rule, denying: github.com:22` | proxy が CONNECT に 403（`Forbidden`） |
| C6 | `*.github.com:443` | `$GIT_SSH_COMMAND -p 443 -T git@ssh.github.com` | `Allowed by config rule: ssh.github.com:443`、`opaque-tunnelling` | `Permission denied (publickey)`。443 番でも SSH が届いた |
| C7 | C1 と同じ + `tlsTerminate.excludeDomains: ["api.github.com"]` | C1 と同じ要求 | Sectigo / `policy exempts api.github.com:443; opaque-tunnelling` | 401 `Bad credentials`。TLS 終端を通らない |

C1 と C2 は、どちらも sandbox が渡した proxy の同じポート（3128）に接続している。違うのは最初に話すプロトコルだけである。srt は同じポートで HTTP と SOCKS を受け付け、SOCKS の CONNECT は中身を見ずに中継する（srt の `mux-proxy.js`、`socks-proxy.js`）。

## 判定

どの経路も、sandbox 内でコマンドを実行できれば使える。ホストを先に侵害する必要はない。proxy の認証情報は srt 自身が sandbox 内の環境変数に入れており、この認証は sandbox の外にいる他のプロセスから proxy を守るためのものである。プロンプトインジェクションで実行させたコマンドや、悪意ある依存パッケージから使える。

- **SOCKS（C2・C3）**: 許可リストにあるホストへ、プログラムが指定した認証情報を付けた HTTPS 要求が検査なしで届く。有効な攻撃者の token を使えば、攻撃者の repo への書込み（A1b）や未信頼の repo の取得（P1）に使えると判断する。
- **TLS 以外のプロトコル（C4・C6）**: 許可リストにポートを書かないと、SSH で GitHub の sshd に届く。攻撃者の鍵を使えば、攻撃者の repo への push（A1b）や未信頼の repo の fetch（P1）に使えると判断する。ポートを `:443` に絞っても（C5 で拒否、C0 で HTTPS は通過）、`ssh.github.com:443` が許可に含まれれば同じ経路が開く。
- **`excludeDomains`（C7）**: 除外したホストへの HTTPS は検査されない。A1b にどれだけ影響するかは、除外したホストに攻撃者が自分のアカウントを持てるかによる。

**srt 0.0.77 では、`filterRequest` を実装しても系統2の A1b・P1 は ○ にとどまる。** 迂回されない制御にするには、SOCKS 経路でも TLS 終端を強制するよう srt を変更する必要がある。

## 実測の限界

- 実測したのは、偽の token が GitHub に届いて `Bad credentials` が返ることと、使い捨ての鍵が GitHub の sshd で拒否されることまでである。有効な攻撃者の token による第三者の repo への書込みや、git push の成功は試していない。
- ライブラリとして `filterRequest` を設定した構成は動かしていない。`filterRequest` が呼ばれない理由は、TLS が終端されないこと（証明書の発行者と debug ログ）と、srt のソースコードから判断した。
- 試したのは Linux だけである。macOS の srt は別の実装を使うので、同じ結果になるとは限らない。

## 再現

bubblewrap の user namespace が使える Linux ホストで、repository root から実行する。結果は `.local/srt-filter-bypass/` に出力する。

```sh
docs/architecture/experiments/srt-filter-bypass/probe.sh
```

各ケースの標準出力と debug ログ（`<ケース名>.stdout`・`.stderr`）と、判定に使った行を抜き出した `summary.txt` が残る。`summary.txt` では proxy の認証 token を伏せているが、`.stderr` には残るので共有しない。
