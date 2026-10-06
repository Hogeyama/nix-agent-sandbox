# nono の REST 制限と別経路の追試

**nono 0.79.0 の通常 session proxy は、設定した HTTPS origin の method/path を制限できる。一方、同じホストの別ポートにはその制限を適用しない。** 模擬 API では、別ポートへの平文 HTTP・TLS・SSH 相当の通信が通った。したがって「GraphQL を禁止して REST policy を設定すれば、通信全体をその範囲に閉じ込められる」とまでは言えない。

これは、実 GitHub の未許可 repo に書けたという結果ではない。GitHub について先に確認したのは、`api.github.com:443` の正規 REST は成功し、非正規 REST は拒否されたこと。本追試は、その正常な制限の外に通信経路が残るかをローカルの模擬サーバーで調べた。

## 条件

2026-10-06、NixOS / Linux 6.18.40、公式 Linux musl binary の nono 0.79.0。binary と source は [先の記録](README.md)と同一。

ホスト側に使い捨てのサーバーを4つ置いた。保護対象の HTTPS API、別ポートの HTTPS API、平文 HTTP API、SSH の識別行だけを受信する TCP サーバーである。すべて loopback、空きポートを使い、既存サービスを変更しない。SSH 認証やコマンド実行、実 GitHub への通信はない。

保護対象の credential route に次の policy を置いた。

```json
{
  "endpoint_policy": {
    "default": { "decision": "deny" },
    "allow": [
      { "method": "GET", "path": "/repos/trusted/private/pulls" },
      { "method": "GET", "path": "/redirect-same" },
      { "method": "GET", "path": "/redirect-other-port" },
      { "method": "GET", "path": "/redirect-other-host" }
    ]
  }
}
```

後ろの3経路はリダイレクト追従を試すためだけのもの。正常要求では管理側の偽 token を代理注入し、攻撃側の要求では別の偽 token と人工 marker を使う。実 token は取得しない。子の filesystem は専用 workspace と runtime の読取りに限定し、既定の `/tmp` 書込み許可を外した。親の credential / proxy 環境変数も継承しない。

以下の4 profile を比較した。

| profile | 一般 proxy の設定 |
| --- | --- |
| `host-allow` | `allow_domain: ["localhost"]` |
| `port-allow` | `allow_domain: ["localhost:<保護対象のport>"]` |
| `unrelated-allow` | `allow_domain: ["unused.invalid"]`。credential upstream を一般許可に書かない |
| `known-ports-denied` | 上記の unrelated-allow に、模擬サーバーの別ポート3つを `deny_domain` で明示拒否 |

すべて同じ HTTPS credential route を有効にした。ホストから各サーバーへの正常通信を確認した後、子の最初と最後で保護対象の GET が成功することも確認した。

## 結果

最初の3 profile は同じ結果だった。`port-allow` には、port 指定を無視して hostname filtering のみ行うという nono の警告が出た。

| 経路 | 最初の3 profile の結果 |
| --- | --- |
| reverse route / CONNECT 内の正規 GET | 200、管理側の偽 token で到達 |
| 保護対象の未許可 repo・POST・GraphQL | 403、上流到達なし |
| 直接 TLS、直接 IP、curl `--noproxy '*'` | 拒否、上流到達なし |
| SOCKS5 の初期挨拶 | 応答せず timeout。SOCKS 接続の成立なし |
| 同じホスト・別ポートへの HTTP forward POST | 200、攻撃側の偽 token と本文が到達 |
| 同じホスト・別ポートへの CONNECT 後の平文 HTTP | 200、未許可 path と攻撃側の偽 token が到達 |
| 同じホスト・別ポートへの CONNECT 後の SSH 識別行 | TCP サーバーに到達し、識別行の応答を受信 |
| 保護対象ポートへの CONNECT 後の SSH 識別行 | TLS alert で終了。上流には届かない |
| 同じホスト・別ポートへの TLS POST | 200、未許可 path・攻撃側の偽 token・本文が到達 |
| CONNECT の IP 指定 | 403。許可した hostname の代わりにはならない |
| CONNECT の末尾 dot・大文字 hostname | 未許可 path は403。保護対象 route の照合を迂回しない |
| 内側の Host header を別 origin に変更 | 保護対象 upstream へ送られ、送信先の変更にはならない |
| 同一 origin の未許可 path への redirect | 追従先で403 |
| 同じ hostname の別ポートへの redirect | 追従先に到達。curl は Authorization を外したが、未許可 path の GET は200 |
| 未許可 hostname への redirect | CONNECT が403 |
| dot segment / percent-encoded dot segment | 403、上流到達なし |
| 正規 path に query parameter を付ける | 200。通常の REST query を使える |
| curl `--http2` で未許可 POST | 403。ただし HTTP/1.1 に fallback しており、HTTP/2 の検証とは数えない |

`known-ports-denied` では、上記の別ポート3つへの HTTP・TLS・SSH・redirect を拒否し、正規 GET は成功した。**特定ポートの deny は働くが、列挙していない port まで閉じたことにはならない。**

## 原因と設定上の限界

通常 session の proxy 構築時、nono は credential upstream の `host:port` だけでなく、裸の `host` も一般 proxy の許可先に追加する。一般許可に upstream を書かなかった3番目の構成でも起きたのは、このためである。[proxy_runtime.rs:2440–2482](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/proxy_runtime.rs#L2440-L2482)

CONNECT が保護対象の host と port に一致すると TLS を終端して policy を適用する。それ以外は hostname filter を使う通常の tunnel に進む。平文 HTTP の forward も credential route とは別に hostname filter で判定する。[CONNECT の分岐](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/server.rs#L1534-L1559)、[HTTP forward](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/server.rs#L1960-L1998)

`allow_domain` の port は取り除かれる一方、`deny_domain` の特定 port は有効である。通常 profile の公開 schema には、簡潔な「この origin の port 以外をすべて拒否」や一般 proxy の `strict_filter` 指定を確認できなかった。[port 警告](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/network_policy.rs#L488-L506)、[NetworkConfig](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/profile/mod.rs#L1777-L1872)

これは全設定で防げないという証明ではない。明示 deny の追加、外側の別 proxy / firewall、command ごとの専用 proxy という選択肢はある。ただし command sandbox は、この環境の公式 binary では子の起動前に失敗している。Claude 用 pack の既定権限、継承、command proxy の設計と起動失敗の原因候補は [別監査](claude-profile-audit.md)に記録した。

## 採用判断への影響

GitHub API の443番だけを使う構成で、同じ port の未許可 REST を拒否できたという評価は維持する。一方、hostname の別 port がどんなサービスを提供するかまで利用者が把握し、それを deny で閉じる必要が残る。広い `claude-code` network profile をそのまま併用すると、GitHub 以外も含む許可先が増える。

現時点の判定は **「REST の個別制限は有効だが、通常 session profile だけで通信全体を限定できる構成は未確立」**。nono を採用済み相当とは扱わず、command proxy の起動・Claude 全体との合成、または別ポートを閉じる追加境界を確認する候補として残す。

## 記録と再現

- [network-bypass.py](network-bypass.py): 親側の fixture・profile・正常系と観測結果の照合。
- [network-bypass-client.py](network-bypass-client.py): nono 内の26ケース。
- [network-bypass-results.json](network-bypass-results.json): ホスト側の4 profile × 26ケース、上流受信記録、stderr。
- [network-bypass-sandbox.json](network-bypass-sandbox.json): 通常 Codex sandbox の失敗記録。

```sh
python3 docs/architecture/experiments/nono-a1b/network-bypass.py \
  --nono /absolute/path/to/nono \
  --output /tmp/nono-network-results.json
```

通常 Codex sandbox では listener の bind が拒否され、製品の試験前に exit 2。ホスト側では104ケースを実行した。途中で CONNECT 拒否が HTTP 応答ではなく Python 例外になる差を判定処理に反映し、最終版を両環境で再実行した。fixture の自己署名証明書だけを supervisor に信頼させ、子側の TLS 検証省略は loopback fixture に限る。

HTTP/2 の実通信、完全な SSH セッション、実 GitHub の別 port を使った書込み、macOS、Claude の API 認証・推論・OAuth 更新、filesystem/IPC 全体は未検証。終了時にサーバーを停止し、一時 credential・証明書・profile・XDG 状態を削除する。nas 本体の実行コードは変更しておらず、無関係な nas テストスイートは実行していない。
