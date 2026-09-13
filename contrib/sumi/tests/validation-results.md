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

## 検証条件

| 検証日（JST） | sumi | 登録したデコイ値 | 設定 |
| --- | --- | --- | --- |
| 2026-09-12 | `77e344e6` | `PrefixDecoy_7429` | `init` の生成設定。`--permission-mode default`、`Bash(cat:*)` を allow、`Bash(git:*)` を deny |
| 2026-09-14 | 検証時の作業ツリーのバイナリ | `McpFailureDecoy_7429` | `init` の生成設定に hook 入出力の記録を追加。stdio の再試行だけ prefix を単一ラッパーパスに変更 |

2026-09-14 の HTTP 試験では、localhost の検証用サーバーを使い、`--strict-mcp-config --tools '' --allowedTools 'mcp__decoy__*' --permission-mode dontAsk` で3ツールだけを許可しました。認証は既存環境を利用し、`CLAUDE_CONFIG_DIR` は変更していません。

## 不具合の確認根拠

HTTP の失敗2件では、hook の入力・sumi の出力・Claude Code の `tool_result` を照合しました。sumi が返したのは警告の `systemMessage` だけで、モデルの最終返答にもデコイ値の平文が残りました。HTTP 通信は shell prefix を通りません。

stdio のタイムアウトは、初期化応答を直接実行と sumi 経由で比較しました。直接実行では改行を含む158バイト、sumi 経由では139バイトが届きました。ストリームマスクがチャンク境界の検査用に末尾19バイト（登録値20バイト − 1）を保持し、応答を区切る改行も保留していました。ここで使用したラッパーは `sumi run --secrets-file … --shell /bin/bash "$@"` を実行します。ツール呼び出しには進めていないため、この経路の出力マスクは未検証です。
