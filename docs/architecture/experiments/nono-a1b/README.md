# nono の認証・送信先制限の実測

**明示 `endpoint_policy` を付けた HTTPS credential route では、未許可 REST path を遮断し、持込 token を管理側の認証へ上書きできた。旧 `endpoint_rules` だけの設定では対象外 path が持込 token のまま通った。どちらも POST `/graphql` を許すだけでは本文の repo を限定できない。** REST に用途を絞る構成と、GraphQL の repo 制限が必要な構成を分けて評価する。

**[REST 制限の別経路を調べた追試](network-bypass.md)では、通常 session proxy が同じホストの別ポートへの平文 HTTP・TLS・SSH 相当通信を通した。** 同一 HTTPS origin の制限だけで、通信全体を限定できたとは扱わない。[Claude profile との合成・command proxy の監査](claude-profile-audit.md)も参照。

その後、ユーザー指定の2 repo で[実 GitHub の書込み試験](live-github.md)も行い、GraphQL を許可したときに非正規 repo へ Issue を作成できることを確認した。以下は先に行った模擬 API の記録である。

さらに、[read-only 設定の新規 PAT による直接対照](readonly-token-check.md)では、公開 repo の Issue 作成が成功した。登録 token の権限で書込みを防ぐ場合も、設定名だけでなく対象 API の実効的な制限を確認する必要がある。

2026-10-06 に nono 0.79.0 を Linux 6.18.40 / NixOS で実行した。A1b（許可サービス内の未許可相手への送信）を想定し、sandbox 内で任意コードを実行できる攻撃者が、別の認証情報や API の引数を使えるかを調べる。LLM に実際のプロンプトインジェクションを与える試験ではない。

実 API の token は不要。ホストで使い捨ての HTTP / HTTPS API を起動し、管理者役と攻撃者役の固定ダミー token を区別して記録する。送信データも `synthetic-source-marker` という人工の文字列だけで、GitHub への書込みは行わない。模擬 API は GraphQL の権限・構文を実行検証しないため、200 は「本文が proxy を通って届いた」という証拠であり、実 GitHub の mutation 成功ではない。

## 再現

Python 3、OpenSSL、Linux 用の公式 nono 0.79.0 binary が必要。このハーネスは NixOS の Python runtime のため `/nix/store` を読取り許可している。他の OS では runtime の読取り許可を調整する。

```sh
python3 docs/architecture/experiments/nono-a1b/probe.py \
  --nono /absolute/path/to/nono \
  --output /tmp/nono-a1b-results.json
```

使用 binary の SHA-256 は `e60f06945aba27bef1d8039ef1e24f30603ac5cf2af074111954b6d607b1c7d0`。[公式リリース](https://github.com/nolabs-ai/nono/releases/tag/v0.79.0)から取得した。ダウンロード archive の SHA-256 は `6102a4490daa69525606c7790f18aede1334e6a399ffd10bb196d42191b8d20f`。

[probe.py](probe.py) が一時 profile・XDG ディレクトリ・偽 credential ファイル・TLS 証明書を作り、[client.py](client.py) を nono 内で実行する。親の token や proxy 環境変数は継承しない。`SSL_CERT_FILE` は実験用証明書だけを指定する。クライアントの CONNECT 認証は nono が生成したセッション用のものに限り、その proxy が `127.0.0.1` の credential proxy と同じポートであることを assert する。TLS 検証を省く箇所は、この localhost フィクスチャへの試験クライアントだけである。

一時設定・credential・証明書は終了時に削除する。既定 group の `/tmp` 書込み許可は除外し、子には専用 workspace だけを書込み許可する。既存のユーザー設定は変更しない。

## 設定の比較

すべて、正規の GET `/whoami` と POST `/repos/trusted/private/issues` を許す。`graphql` 付きの構成だけ POST `/graphql` も許す。具体的な profile の生成処理は `probe.py` にある。

| profile | credential の upstream | 外向き通信と endpoint の設定 |
| --- | --- | --- |
| `credential-only` / `graphql-allowed` | HTTP の loopback API | `network.credentials` と旧 `endpoint_rules`。一般通信の allowlist は指定しない |
| `broad-domain` | 同上 | `localhost` の hostname 許可を追加 |
| `https-origin` / `https-origin-graphql` | HTTPS の localhost API | 同じ origin を credential と CONNECT の両方で使用。旧 `endpoint_rules` |
| `https-policy` / `https-policy-graphql` | 同上 | 明示的な `endpoint_policy: {default: {decision: deny}, allow: [...]}` |
| `command-scoped` | HTTP の loopback API | command のみに proxy credential を渡し、明示 endpoint policy と空の domain allowlist を使用 |

HTTP upstream の構成では CONNECT 先は別の TLS listener である。同一 origin の TLS 検査の成否は `https-*` の対照で判断する。

旧 `endpoint_rules` は、TLS 終端後にどの credential route を選ぶかにも使われる。対象外の要求は、その route を選ばず認証を付けずに転送しうる。明示 `endpoint_policy` の拒否は要求そのものに適用される。[route 選択の実装](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/tls_intercept/handle.rs)でこの違いが明記されている。

## 記録と判定範囲

[results.json](results.json) に各要求の応答、模擬 API に実際に届いた要求、nono の stderr を保存した。正規要求の最初と最後がともに成功したことを確かめ、接続障害を防御成功に数えない。

| 要求 | HTTP credential + 別 TLS listener | 同一 HTTPS origin + 旧 `endpoint_rules` | 同一 HTTPS origin + 明示 `endpoint_policy` |
| --- | --- | --- | --- |
| C15: CONNECT 内で未許可 repo に持込 token と canary を POST | 200、attacker として到達 | 200、attacker として到達 | 拒否、上流到達なし |
| C16: CONNECT 内で許可 GET に持込 token を付ける | 200、attacker として到達 | 200、owner に上書き | 200、owner に上書き |
| C17: CONNECT 内で未許可 `/graphql` に POST | 200、attacker として到達 | 200、attacker として到達 | 403、上流到達なし |
| C12 / C17: `/graphql` を許可して攻撃者 repo ID を送る | reverse route は200、owner | 200、owner | 200、owner |

表の拒否は、403 または送信中の接続 reset と、fixture に到達しないこと、直後の C16 正常系成功で判断した。旧設定の一般通信を許す挙動は、明示 policy の結果と区別する。`credential-only` の空の一般 allowlist は通信を拒否する設定ではなく、[実装](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-proxy/src/server.rs)では一般通信を許す。

reverse credential route では、攻撃者の Bearer / Basic token と認証なしは 401、未許可 repo・method・dot segment のパスは 403。重複 Authorization は管理側 token 一つに整理される。ただし Cookie はそのまま届く。これは別サービスでの認証方法を検討する材料であり、GitHub API が Cookie で認証したことを示す結果ではない。

POST `/graphql` を許すと、`repositoryId: "ATTACKER_REPO"` と canary を含む本文が管理側の認証で届く。管理側 token がその相手に書き込めるかは実サービスの権限による。path の許可と repo の許可は別である。

`command-scoped` は子の起動時に exit 126 となり、要求を一つも実行できなかった。

```text
Command sandbox execute restriction: cannot open / for Refer grant:
failed to open "/": Permission denied (os error 13)
```

この環境・profile での未検証であり、command sandbox が攻撃を拒否した結果とは扱わない。公式仕様では、[command の proxy credential](https://github.com/nolabs-ai/nono/blob/v0.79.0/docs/cli/features/tool-sandbox.mdx) は一般 forward proxy と分離できる。この起動問題だけで製品全体の不成立とも判定しない。

## 検証環境と限界

- Codex sandbox 内: localhost listener 作成が `EPERM` で失敗し、exit 2。製品の防御結果ではなく実験環境の制限。`hostexec` はこの環境にない。
- ホスト（承認済み sandbox 外実行）: 7 profile × 18 ケースを実行。command-scoped は前記の起動失敗で0ケース。
- 当初の高速な連続要求では、nono の seccomp supervisor の rate limiter（10 件/秒、burst 5）により後続 connect が `EPERM` になった。最終スクリプトは 250 ms 間隔にし、最後の正規要求も確認する。[実装](https://github.com/nolabs-ai/nono/blob/v0.79.0/crates/nono-cli/src/exec_strategy/supervisor_linux.rs)
- この最初の試験では redirect の 307 応答を観測するところまでに留めた。自動追従・SOCKS・SSH 相当通信は[別経路の追試](network-bypass.md)、実 GitHub の書込みは[実 API の追試](live-github.md)を参照。filesystem 全体の保護、daemon や broker の侵害は未検証。
- 結果は指定 version・profile・経路に限る。GraphQL の禁止、REST に限定した許可、認証を持つ HTTPS route の明示 endpoint policy はそれぞれ別の構成として評価する。
