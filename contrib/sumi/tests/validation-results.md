# Claude Code での検証記録

Claude Code 2.1.268 で、sumi の shell prefix 方式を検証しました。Read と Bash の出力はマスクされましたが、HTTP MCP の失敗本文は平文でモデルへ届きました。stdio MCP は接続に失敗しました。

専用の設定と作業ディレクトリで、公開デコイ値を使って確認しています。デコイ値はプロンプトやツールの説明には含めていません。実ツールの検証では `claude -p`、`--setting-sources ''`、`--no-session-persistence` を使用しました。

## 結果

| 確認したこと | 結果 | 検証日（JST） |
| --- | --- | --- |
| `Read sample.txt` | `password=****************` にマスクされた | 2026-09-12 |
| `Bash: cat sample.txt` | `Bash(cat:*)` の許可で実行され、出力は `password=****************`、終了コード 0 | 2026-09-12 |
| `Bash: cat sample.txt && false` | 出力は同じくマスクされ、終了コード 1 とエラー状態を保持 | 2026-09-12 |
| `Bash: git --version` | `Bash(git:*)` の deny により拒否され、`permission_denials` に元のコマンドが記録された | 2026-09-12 |
| `Bash: echo ok && git --version` | 別セッションで実際に呼び出し、同じ deny により拒否された | 2026-09-12 |
| HTTP MCP の正常なテキスト応答 | `PostToolUse` により `success: credential=********************` にマスクされた | 2026-09-14 |
| HTTP MCP の `isError: true` | `PostToolUseFailure` が発火し、`tool_error: credential=McpFailureDecoy_7429` が平文で届いた | 2026-09-14 |
| HTTP MCP の JSON-RPC エラー（code `-32603`） | `PostToolUseFailure` が発火し、`Intentional protocol failure: credential=McpFailureDecoy_7429` が平文で届いた | 2026-09-14 |
| stdio MCP の起動（`init` の生成設定） | 引数付き prefix 全体が1つの実行ファイル名として `posix_spawn` に渡され、`ENOENT` で接続失敗 | 2026-09-14 |
| stdio MCP の起動（単一ラッパーパスへ変更） | サーバーは起動するが、初期化応答が完結せず30秒で接続タイムアウト | 2026-09-14 |
| Read・Edit の失敗本文 | 未検証 | — |

## 検証条件と観測内容

2026-09-12 は sumi `77e344e6` とデコイ値 `PrefixDecoy_7429` を使用しました。`init` が生成した exec 形式の hook と `CLAUDE_CODE_SHELL_PREFIX` をそのまま使い、`--permission-mode default` と検証用 settings の allow／deny で確認しました。拒否2件はモデルが呼び出しを省略した結果ではありません。Read と実行された Bash のツール結果にはデコイの平文がなく、元のコマンド文字列も書き換えられていません。

2026-09-14 は作業ツリーの shell prefix 方式の sumi バイナリとデコイ値 `McpFailureDecoy_7429` を使用しました。localhost の HTTP サーバーが返す3種類の応答を各1回呼び出し、hook の入力・sumi の出力・Claude Code の `tool_result` を照合しました。prefix は `init` の生成値のまま有効で、hook は観測用ラッパーを介して sumi を実行しました。`--strict-mcp-config`、`--tools ''`、`--allowedTools 'mcp__decoy__*'`、`--permission-mode dontAsk` により、検証用の3ツールだけを利用可能にしました。認証は既存環境を利用しており、`CLAUDE_CONFIG_DIR` の隔離は行っていません。

成功時は sumi が `updatedToolOutput` を返してマスクされました。失敗2件では `systemMessage` だけを返し、ツール結果とモデルの最終返答にデコイ値の平文が残りました。HTTP 通信は shell prefix を通らないため、prefix を有効にしてもこの失敗経路は保護されません。

stdio サーバーの起動には prefix が適用されます。生成設定での起動失敗後、`sumi run --secrets-file … --shell /bin/bash "$@"` を呼ぶ単一ラッパーパスに変更しても接続がタイムアウトしました。同じサーバーへの初期化要求を直接実行と sumi 経由で比較すると、直接実行では改行を含む158バイトが届き、sumi 経由では139バイトだけが届きました。ストリームマスクが、次のチャンクにまたがる値を検出するために末尾19バイト（登録値20バイト − 1）を保持し、応答を区切る改行も保留していました。ツール呼び出しまで進んでいないため、この経路の成功・失敗本文がマスクされるかは未検証です。
