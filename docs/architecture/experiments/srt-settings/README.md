# srt と Claude Code 内蔵 sandbox の併用実験

[脅威モデルの選定](../../threat-model.md)で検討する系統1+2について、Claude Code 本体にはモデル API への通信を許可し、Bash から同じ宛先への通信を拒否できるか確認する。

**今回のバージョンと設定では、srt と内蔵 sandbox の併用で正常な通信を維持しつつ拒否する構成は確認できなかった。** 既定の組合せは初期化で失敗し、Unix socket を許可した診断構成では拒否側だけでなく許可側の対照も未到達となった。`enableWeakerNestedSandbox` を有効にしても結果は変わらず、系統1+2を要求充足済みには数えない。

## 方法

[probe.mjs](probe.mjs) は実物の Claude Code CLI、Bash、srt、bubblewrap、curl を実行する。モデル API だけをローカル HTTPS fixture に置き換え、固定の `tool_use` で Bash に送信させる。外部 API や実 credential は使わない。

- Claude Code 本体はダミーの正規 token で `/v1/messages` を呼ぶ。
- Bash は別のダミー token と固定の無害な本文を、同じ host・port の `/v1/files` に送る。
- 外側の srt は fixture への通信を許可し、内蔵 sandbox はケースに応じて許可・拒否する。送信が fixture に届いたかと、Bash の `tool_result` を記録する。

fixture は `127.0.0.2` の空き port で待ち受ける。srt が `NO_PROXY` に入れる `127.0.0.1` を避け、proxy を通る経路を試すためである。OpenSSL で fixture 用の自己署名証明書を作り、`NODE_EXTRA_CA_CERTS` と curl の `--cacert` で信頼する。証明書検証は無効化しない。

内外の sandbox が保護する `.claude/settings.json` と `.claude/settings.local.json` は先に作る。事前作成しない試行では、内側が read-only の場所へ mount 対象を作ろうとして失敗した。

追加の3ケースでは、内側の `sandbox.enableWeakerNestedSandbox = true` も試した。これは新しい `/proc` の mount を既存 `/proc` の bind mount に替える設定で、Unix socket を許可する設定とは別である。[公式の説明](https://code.claude.com/docs/en/sandboxing#troubleshooting)

観測日は 2026-09-28。環境は Linux、Node 24.20.0、Claude Code 2.1.283、srt 0.0.77、bubblewrap 0.11.2、socat 1.8.1.3。user namespace を使う bubblewrap の起動を先に確認した。

## 観測結果

HTTPS の基本9ケースと追加3ケースを示す。[観測データ](observations.json)には HTTP の許可側対照も含める。全12ケースで Claude Code 本体から fixture のモデル API へ2回ずつ到達し、CLI 自体は終了コード0だった。

| ケース | 結果 | 判断 |
| --- | --- | --- |
| `no-sandbox` | ダミー token と本文が到達 | fixture と送信処理の対照 |
| `srt-only` | 同じ送信が到達 | 外側の hostname 許可だけでは同一宛先への別 token の送信を阻止しない |
| `settings-only-allowed` | 同じ送信が到達 | 内蔵 sandbox の許可ケースの対照 |
| `settings-only` | CONNECT 403 と network allowlist の拒否。送信は未到達 | 内蔵 sandbox 単独では、本体の API 通信を保ち Bash の同一宛先への通信を拒否できた |
| `srt-and-settings` | `srt-mux` の Unix socket を listen できず `EPERM`。Bash は未実行 | `failIfUnavailable = true` による初期化失敗時の拒否。通信制御の成立は未確認 |
| `nested-unix-allowed` | CONNECT 403 と network allowlist の拒否 | 診断構成の拒否側は未到達 |
| `nested-unix-allowed-control` | 内側でも許可したが CONNECT 502。送信は未到達 | 許可側の正の対照が失敗し、正常通信を維持した選別の成立は未確認 |
| `nested-unix-allowed-direct` | proxy を使わない curl が接続失敗、終了コード7 | この直接接続の試行は未到達 |
| `nested-unix-allowed-escape` | `dangerouslyDisableSandbox` を指定しても CONNECT 403 | この sandbox 外実行の指定では未到達 |
| `nested-weaker` | 外側の Unix socket 制限を維持すると同じ `srt-mux` の `EPERM` | 内側の `enableWeakerNestedSandbox` では初期化失敗を解消しない |
| `nested-weaker-unix-allowed` | Unix socket 許可を併用し CONNECT 403 | 拒否側は未到達 |
| `nested-weaker-unix-allowed-control` | 内側でも許可したが CONNECT 502 | 許可側の対照は追加設定でも失敗 |

名前に `unix-allowed` を含むケースは、外側に `allowAllUnixSockets = true` を設定する。これは外側の強制境界を弱める診断であり、推奨構成ではない。

HTTP でも同じ許可側対照は `Bad Gateway` で未到達だった。原因は確定しておらず、すべての入れ子構成が不可能という結論にはしない。

## 再現

上記の CLI と実行環境、curl、OpenSSL を用意し、bubblewrap の user namespace が使える Linux ホストの repository root で実行する。追加の npm 依存は独立した作業用ディレクトリだけに配置する。

```sh
npm install --prefix node_modules/threat-model-probe-runtime \
  @anthropic-ai/sandbox-runtime@0.0.77

node docs/architecture/experiments/srt-settings/probe.mjs \
  --runtime node_modules/threat-model-probe-runtime \
  --claude "$(command -v claude)" \
  --bwrap "$(command -v bwrap)" \
  --socat "$(command -v socat)" \
  --out node_modules/threat-model-probe-runtime/results
```

既定は HTTPS。HTTP の対照は `--protocol http`、特定ケースだけなら `--cases settings-only,srt-and-settings` を指定する。出力先の `results.json` と各ケースの JSON に、使用バージョン、設定、到達した要求、tool result、debug log が残る。CLI の終了コードや送信未到達だけで防御成功を判定せず、ネットワーク拒否、初期化失敗、許可した通信の失敗を区別する。

## この実験が示さないこと

HTTPS の CONNECT tunnel は試したが、実際の Anthropic Files API、TLS inspection による credential masking や代理注入は検証していない。固定の Bash 呼出しを試す実験なので、Claude Code 本体や他の子プロセスも敵対的に振る舞う X 全体の保証にはならない。auto mode の classifier の判断も評価しない。
