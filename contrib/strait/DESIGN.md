# strait の設計

strait を変更する人のための文書です。strait の現在の構成と、要求が処理される流れを記載します。使用方法は [README](README.md)、守るべき性質・信頼すべきコード・変更後の確認方法は [SECURITY.md](SECURITY.md)を参照してください。この文書は SECURITY.md の規則を繰り返さず、該当する節にリンクします。

## 目的と位置付け

nas は、独自の大きなプロキシでネットワークのポリシーを適用します。strait の目標は、信頼すべきコードを srt と小さな判定のコードに抑えたサンドボックスです。

そのため、strait は srt のプロキシを置き換えません。srt の `filterRequest` に判定を差し込み、srt の不足はパッチで補います。パッチはどれも数行です。プロキシを自作すれば、srt を使う意味がなくなります。

この方針から、strait には 2 つの性質があります。

1 つ目は、出口が `filterRequest` の 1 か所だけであることです。通信の許可、承認、ホストでのコマンド実行のすべてが、この 1 つの関数を経由します。別のソケット、別のプロキシ、srt の `mitmProxy` のように経路を増やす変更は、この性質を壊します。

2 つ目は、設定では変更できない不変条件があることです。TLS の終端、443 番への限定、固定のホスト、すべての要求への `filterRequest` の適用は、コードで固定しています。`strait.json` は srt の `network` と `credentials` の節を受け付けません。`githubRepos`、`hosts`、`filesystem` で許可の範囲を広げることはできますが、これらの不変条件を外すことはできません。

## 全体構成

```
[サンドボックス（bubblewrap）]
  claude など、strait hostexec（curl）
  GH_TOKEN などはダミーの値
        │ HTTPS_PROXY 経由のみ
        ▼
[ホスト：strait のプロセス]
  srt の HTTP プロキシ（パッチ済み、TLS を終端）
    └ filterRequest
        └ policy.decide() ── allow ──▶ 上流（認証ヘッダーをホスト側で上書き）
                           ── deny ───▶ 403
                           ── review ─▶ Approvals.hold()
                                          │  ▲ Unix ソケット（$XDG_RUNTIME_DIR/strait）
                                          │  └─ strait review / strait review web
                                          ├ 承認：上流へ、hostexec なら runOnHost → respond
                                          └ 拒否・期限切れ：403
```

### 起動の流れ

1. `strait`（launcher）が、固定の `bunfig.toml` と `--no-env-file` を指定して bun で `src/cli.ts` を起動します。配布物では同梱の `libexec/bun`、それ以外では PATH の `bun` を使います。
2. `cli.ts` が、サブコマンド（`review`、`hostexec`）を振り分けます。それ以外は、UI のフックを付けて `core/main.ts` の `run()` を呼び出します。
3. `run()` が `strait.json` を検証し、ホスト環境から送信先ごとの認証ヘッダーを組み立てます。GitHub の API は Bearer、git は Basic、Anthropic は OAuth を優先して API key にフォールバックします。
4. 認証ヘッダー上書きのパッチを必ず検証します。`hostExec` が有効な場合は、srt に respond のパッチがあることを検証します。セッション ID を決定し、承認用ソケットを確保して待機を開始します。
5. srt を初期化します。許可リスト、`filterRequest`、`denyWrite` に追加する保護対象、マスクする認証情報と、ホスト側の上書き関数を渡します。全認証情報の `injectHosts` は空配列で、ヘッダー・本文の sentinel 置換候補はありません。
6. `selfcheck.ts` が、稼働中のプロキシに SOCKS と TLS 以外の CONNECT を送信し、パッチの有効性を検証します。
7. srt がコマンドをラップする際に、すべての環境変数がマスクされたことを確認します。policy には実値も sentinel も渡さず、ホストごとの認証情報の有無とヘッダー名だけを渡します。
8. サンドボックス内でコマンドを起動します。終了時には、保留中の要求をすべて拒否します。

### 1 件の要求の流れ

1. srt が CONNECT の段階で、許可リストにないホストを拒否します。
2. srt が TLS を終端し、`filterRequest` を呼び出します。`wantsBody` が真の要求（`POST /graphql` と hostexec）だけ、`body.ts` が上限付きで本文を読み込みます。
3. `policy.decide()` が allow、deny、review のいずれかを返却します。`decide()` は I/O のない純粋な関数です。判定の順序は [SECURITY.md の判定の要点](SECURITY.md#判定の要点) を参照してください。
4. review の要求は `Approvals.hold()` で保留され、`strait review` か `strait review web` の決定、または 240 秒の経過を待ちます。
5. 許可・承認された通常の要求は、srt が hop-by-hop ヘッダーを除去した後で、検証済みの接続先に対応する認証情報を上書きして転送します。クライアントの Host ヘッダーは選択に使いません。上書きの失敗は秘密を含まない 403 で終了し、上流には送信しません。本文や他のヘッダーはこの認証処理では変更しません。
6. 承認された要求が hostexec であれば、`runOnHost` がホストで実行し、srt の respond のパッチで結果を返却します。上流には送信しません。

## 未解決の課題

未解決の課題は [docs/todo/strait.md](../../docs/todo/strait.md) で管理しています。
