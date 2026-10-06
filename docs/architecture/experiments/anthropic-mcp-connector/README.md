# Messages API の MCP connector による第三者への送信の実測

A1a について、接続を許可した `api.anthropic.com` を経由して、許可していない第三者のサーバへ情報を送れるか調べた。観測日は 2026-10-07、ホストは Linux、strait は `contrib/strait` のチェックアウト（0.2.0 の後、`fe631993`）。

**strait の中で実行した `curl` から `POST /v1/messages` を1回送るだけで、Anthropic のサーバが第三者の MCP server に接続し、ツールを呼び出した。** 要求は strait の検査で保留されずに許可され、認証は strait が上書きした subscription の OAuth token だった。

## 機能

Messages API の [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector) は、要求の本文の `mcp_servers` に書いた URL の MCP server へ Anthropic 側から接続する。beta header `anthropic-beta: mcp-client-2025-11-20` を要求する。事前の登録は不要で、認証 token も任意である。server の条件は、HTTP（Streamable HTTP または SSE）で公開されていることだけである。

ツールの引数はモデルが会話から決める。隔離環境内のプログラムは、送りたい情報を会話に含め、攻撃者の MCP server のツールを呼ぶよう指示できる。隔離環境から見える通信は `api.anthropic.com` への要求だけで、第三者への接続は Anthropic のサーバから行われる。

これは claude.ai の connector（Gmail、Drive 等）とは別の機能である。claude.ai の connector は claude.ai で事前に登録したものだけを、`mcp-proxy.anthropic.com` 経由で使う。

## 手順

ホストで strait を起動し、strait の中で次の要求を `curl` で送った。受け側には、認証なしで公開されている DeepWiki の MCP server（`https://mcp.deepwiki.com/mcp`）を使い、公開 repo の目次だけを取得させた。`Authorization` はダミーの値で、strait がホストの認証情報に上書きする。

```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 400,
  "system": [{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}],
  "mcp_servers": [
    {"type": "url", "url": "https://mcp.deepwiki.com/mcp", "name": "deepwiki"}
  ],
  "tools": [{"type": "mcp_toolset", "mcp_server_name": "deepwiki"}],
  "messages": [
    {"role": "user", "content": "Call the deepwiki read_wiki_structure tool with repoName \"anthropics/sandbox-runtime\" and list the first 3 topics."}
  ]
}
```

header は `anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20,mcp-client-2025-11-20` とした。

## 観測結果

HTTP 200 が返った。応答の `content` には、次の2つの block と、その結果を要約した `text` があった。

| block | 内容 |
| --- | --- |
| `mcp_tool_use` | `server_name: "deepwiki"`、`name: "read_wiki_structure"`、`input: {"repoName": "anthropics/sandbox-runtime"}` |
| `mcp_tool_result` | `is_error: false`、DeepWiki が返した目次 |

strait は要求を保留しなかった。strait は `POST /v1/messages` を許可し、本文を読まない。

## 同じ境界の中から Bash だけを塞げるか

strait の中で Claude Code の内蔵 sandbox を有効にし、Bash の通信先から `api.anthropic.com` を除く構成も試した。内蔵 sandbox は初期化に失敗した。

```
Sandbox is required but failed to initialize: EPERM: operation not permitted, listen '/tmp/claude/srt-mux-2-9.sock'.
```

内側の srt は proxy との中継に Unix socket を作る。外側の strait（srt）は seccomp で隔離環境内の `AF_UNIX` を拒否しており、この拒否は内側の srt にも適用される。`AF_UNIX` を許可すると、隔離環境から見えるホストの socket（tmux、D-Bus、各種 agent）にも接続できるようになる。

## 評価

- hostname の allowlist は、Claude Code 本体の要求とこの要求を区別できない。どちらも `api.anthropic.com` への `POST /v1/messages` である。
- Claude Code 本体が Bash の隔離境界の外にある構成では、Bash の通信先から `api.anthropic.com` を除けば、Bash からこの要求を送れない。
- Claude Code 本体と Bash が同じ境界の中にある構成では、`api.anthropic.com` を拒否できない。要求の header か本文を検査し、`mcp_servers` 等を含む要求を拒否する必要がある。
- web fetch など、Anthropic 側で外部に接続する他の server tool も同じ系統の経路になる。今回は MCP connector だけを実測した。
## Bash だけを内蔵 sandbox で塞ぐ構成

Claude Code 本体が Bash の隔離境界の外にある構成で、Bash の通信先から `api.anthropic.com` を除けばこの要求を止められるかを、系統1・3・5の形で確かめた。どの構成も、`claude -p` に Bash で同じ要求を送らせた。Claude Code の設定は共通で、内蔵 sandbox を有効にし、`failIfUnavailable: true`、`allowUnsandboxedCommands: false`、`strictAllowlist: true` とした。

- 対照: `allowedDomains` に `api.anthropic.com:443` を入れる（threat-model の系統1の旧設定例と同じ）
- 対策: `allowedDomains` から除き、`deniedDomains` に `api.anthropic.com` を入れる

内蔵 sandbox は Bash の要求に認証情報を付けないので、対照の要求はダミーの token のまま Anthropic に届き、401 になる。攻撃者は自分の API key を使えば済むので、Anthropic に届くこと自体を通過とみなす。

| 構成 | 実行環境 | 対照 | 対策 |
| --- | --- | --- | --- |
| 系統1 | ホスト、Claude Code 2.1.291 | 401（Anthropic に到達） | `CONNECT tunnel failed, response 403`（内蔵 sandbox の proxy が拒否） |
| 系統5 | Docker Sandbox `sbx v0.45.1` の VM、Claude Code 2.1.280 | 401 | `CONNECT tunnel failed, response 403` |
| 系統3 | `docker run --cap-add NET_ADMIN --cap-add NET_RAW`、Claude Code 2.1.291 | 未測定 | bwrap が user namespace を作れず、Bash のコマンドがすべて失敗 |
| 系統3 | 上に `--security-opt seccomp=unconfined --security-opt apparmor=unconfined` を追加 | 未測定 | `Can't mount proc` で失敗。`enableWeakerNestedSandbox: true` を足すと `CONNECT tunnel failed, response 403` |

系統5の VM では、内蔵 sandbox の bwrap が追加の設定なしに動いた。VM の中から直接 `curl` で送った要求も、sbx の network policy を通って Anthropic に届き、401 になった。

系統3では、Dev Container の参照実装と同じ capability の container の中で、内蔵 sandbox は起動しなかった。`failIfUnavailable` により Bash は sandbox の外で実行されず、失敗した。内蔵 sandbox を動かすには、container の seccomp と AppArmor の制限を外し、`enableWeakerNestedSandbox` で container の `/proc` を sandbox に見せる必要があった。どちらも container 自体の隔離を弱める。系統3の対照は、参照実装の firewall が `api.anthropic.com` を許可する設計なので測定していない。

検証用の sbx sandbox は削除し、`sbx ls` と `sbx secret ls` が空で、global policy が検証前と同じであることを確認した。

## nas

同じ要求を、インストール済みの nas（プリセット変更前）のコンテナから送った。HTTP 200 が返り、応答に `mcp_tool_use` と `mcp_tool_result` があった。当時の Anthropic 向けプリセットは `/v1/messages` の本文で content block の型を検査していたが、`mcp_tool_use` を許可しており、`mcp_servers` を検査していなかった。

プリセットに `BodyExpect { absent { "/mcp_servers" } }` を加え、`mcp_servers` を持つ要求を承認に回さず拒否するようにした。本物の mitmproxy に変更後の addon を載せた統合テスト（`nas_addon_integration_test.ts` の `an MCP connector request is refused without review`）で、この要求が upstream への接続前に 403 になり、承認待ちに入らないことを確認した。変更後の nas でのセッション全体の実測はしていない。
