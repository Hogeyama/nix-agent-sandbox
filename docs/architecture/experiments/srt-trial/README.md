# srt で Claude Code を起動する試行

[脅威モデルの選定](../../threat-model.md)の系統2を実機で動かすため、Claude Code 本体を srt で隔離して起動した。[設定例](../../threat-model-configurations.md#系統2)をそのまま使うと起動・通信できなかったため、動いた構成と、原因を切り分けた結果を残す。

観測日は 2026-09-29。環境は Linux、Claude Code 2.1.284、srt 0.0.77（`srt --version` は 1.0.0 と表示）、bubblewrap 0.11.2、socat 1.8.0.3。

## 構成

- [srt.sh](srt.sh): ホストのリポジトリ内で実行する。状態の保存先を `.local/srt-state` に分け、環境変数 `CLAUDE_OAUTH_TOKEN_CMD` に指定したコマンドの出力を OAuth token として srt に渡す（例: `CLAUDE_OAUTH_TOKEN_CMD='pass claude_code_oauth_token'`）。
- [srt-settings.json](srt-settings.json): 設定例の系統2を基に、以下の問題を直した設定。
- [dummy.env](dummy.env): ファイル内の値のマスクを確かめるためのダミー。

`srt.sh` は `--permission-mode bypassPermissions` で起動する。系統2が前提とする auto mode と共通設定の managed settings は使っていないので、この試行は OS sandbox の挙動の確認に限られる。

## 設定例から変えた点と理由

1. **`//` コメントを除いた。** srt は設定を `JSON.parse` で読み、読めなければ終了する。
2. **`srt` と `claude` の引数を `--` で区切った。**
3. **`denyRead` の `/tmp` に `allowRead: ["/tmp/claude-http-*.sock"]` の例外を足した。** srt は proxy への bridge socket を `/tmp/claude-http-*.sock` に置いて sandbox に bind するが、その後の filesystem 制限が `/tmp` を空の tmpfs で覆い、socket を隠す。sandbox 内の socat が proxy に繋げず、CONNECT は無応答で切れる。Claude Code には `ECONNRESET` として現れた。ホストから proxy と bridge socket に直接送った CONNECT には 407 が返り、`/tmp` を `denyRead` から外すと api.anthropic.com に届いたことで切り分けた。例外を足した後も、`/tmp` に置いた他のファイルは sandbox から読めなかった。
4. **`CLAUDE_CONFIG_DIR` を作業領域内に置いた。** 指定しないと `~/.claude` への書込みが EROFS で失敗し、しかも `~/.claude/.credentials.json` が sandbox 内から読める。
5. **状態の `.claude.json` に `"hasCompletedOnboarding": true` を入れた。** 新しい保存先では onboarding の接続確認が platform.claude.com へ行き、許可外として `ERR_PROXY_TUNNEL` で起動できない。疑似端末での起動で比べると、この値を入れた場合の接続先は api.anthropic.com だけだった。
6. **保護するパスを起動前に作る。** Linux の srt は、wrap 時点で存在するパスにしか `denyWrite` を適用しない。作業領域の `.claude`、状態の `settings.json`・`settings.local.json` を先に作る。この実験ディレクトリも作業領域内にあるので `denyWrite` に含め、エージェントが次回の設定を書き換えられないようにした。

## 観測結果

ホストで srt 経由のコマンドを実行して確認した。

| 確認 | 結果 |
| --- | --- |
| 許可先 api.github.com / api.anthropic.com | 200 / 404（ホストから直接叩いた場合と同じ） |
| 許可外 example.com | proxy が 403 |
| `~/.ssh` の読取り | 空に見える |
| `.claude`・ホーム・`.git/hooks` への書込み | read-only で失敗 |
| `.env`（`mode: deny`） | 読取り拒否 |
| `dummy.env` の `API_PASSWORD` | ダミー値に置換 |
| TLS 終端下の GitHub API | 到達 |
| 偽の token を付けた GitHub API 要求 | そのまま届き 401。[A1b が ○](../../threat-model.md#系統2-srt) にとどまる評価と一致 |

`GH_TOKEN` のマスクと代理注入、本物の token での対話セッションの継続利用は確認していない。
