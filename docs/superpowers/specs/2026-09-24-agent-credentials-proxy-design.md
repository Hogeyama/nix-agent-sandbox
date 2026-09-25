# エージェントの認証情報をホスト側で管理し、proxy で注入する

## 背景

Claude Code は OAuth の access token と refresh token を `~/.claude/.credentials.json` に保存する。
nas は現在、このファイルを container と read-write で共有している。
そのため、次の2つの問題がある。

- 許可済みの送信先に、攻撃者が自分の credential を付けて request を送れる。
  - プロンプトインジェクション等でエージェントに攻撃者の OAuth token や API key が渡ると、エージェントはそれを付けて `api.anthropic.com` へ request を送れる。
  - Messages API の request には、server 側に会話を保存する指示（`"thread": {"type": "create"}`）を含められる。攻撃者の credential で送った会話は攻撃者のアカウントに残り、後から読まれる可能性がある。
  - nas の anthropic preset は `inject` を持たず、エージェントが付けた header をそのまま通す。
- エージェントが共有ファイルへ攻撃者の token を書き込める。
  - 書き込まれると、ホストの Claude Code が以後の会話を攻撃者のアカウントで送る。

## 目的

- `api.anthropic.com` と `mcp-proxy.anthropic.com` へ送る request の認証情報を、ホストが持つ本物の credential に揃える。エージェントが付けた credential は、どの header に入れても上流へ届かないようにする。
- OAuth の access token と refresh token を container から見えないようにする。
- container からホストの `.credentials.json` へ書き込む経路をなくす。
- Claude の subscription（OAuth）での利用を、機能を減らさずに続けられるようにする。

## 対象外

- Codex、Copilot の認証情報。設定キーは共通にするが、実装は Claude だけとする。
- API key での利用。API key を使う利用者は `"shared"` で opt-out する。
- Anthropic の server tool（MCP connector、web fetch 等）を介した第三者への送信。別の変更で扱う。

## 設定

`agentState` に `auth` を追加する。

```pkl
class AgentStateConfig {
  /// エージェント自身のログイン情報の扱い。
  /// - `"proxy"`: ホスト側で保持・更新し、proxy が許可した request にだけ注入する。
  ///   container にはダミー値を見せる。
  /// - `"shared"`: ホストのファイルを container と共有する。
  /// - 未指定: エージェントごとの既定値。Claude は `"proxy"`、それ以外は `"shared"`。
  auth: ("proxy"|"shared")? = null
}
```

設定の解決では次を検証し、違反は設定エラーとしてセッションを開始しない。

- `"proxy"` を明示したエージェントが Claude 以外である。
- 解決結果が `"proxy"` で、profile の `env` に `ANTHROPIC_API_KEY` または `ANTHROPIC_AUTH_TOKEN` がある。
  - 判定の対象は `key` を静的に書いたエントリだけとする。`keyCmd` のキー名はホストでコマンドを実行するまで決まらないためである。
  - エラーメッセージで `auth = "shared"` による opt-out を案内する。

network proxy は常に有効なので、proxy の有無は検証しない。

既定値の変更によって、既存の Claude profile の挙動が変わる。リリースノートに記載する。

## 構成

解決結果が `"proxy"` のとき、次の4つの部品が協調して動く。

### 1. ダミーの `.credentials.json`

セッション開始時に、ホストの `~/.claude/.credentials.json` を読み、ダミーのファイルをセッション専用のディレクトリに作る。

- `claudeAiOauth.accessToken` と `claudeAiOauth.refreshToken` には、固定の接頭辞を持つ sentinel 文字列を入れる。
- `claudeAiOauth.expiresAt` と `claudeAiOauth.refreshTokenExpiresAt` は十分遠い未来にする。Claude Code が自分で更新を始めないようにするためである。
- `scopes`、`subscriptionType`、`rateLimitTier`、`organizationUuid` はホストのファイルからコピーする。Claude Code が subscription でログインした状態として動作するために必要である。
- MCP サーバーの OAuth token（`mcpOAuth`）と、その refresh に使う client の登録情報（`mcpOAuthClientConfig`）もホストのファイルからコピーする。Claude Code はこれらを同じファイルに置くので、コピーしないと OAuth で認証する MCP サーバーが container で使えなくなる。
  - コピーするのはセッション開始時の値だけで、container での変更はホストへ書き戻さない。書き戻すと、container が MCP の token を攻撃者のものに差し替え、ホストの Claude がそのアカウントへデータを送る経路になる。
  - 代わりに、container 内での MCP の認証はセッション終了とともに消え、container 内で refresh すると、refresh token を使い捨てにする MCP サーバーではホスト側の token が失効しうる。
  - 企業 IdP の token（`mcpXaaIdp`）はコピーしない。MCP 以外にも使える credential だからである。
- それ以外の項目はコピーしない。未知の項目が秘密を含む可能性があるためである。

container の `~/.claude` は、`protectSettings` の有無にかかわらず、セッション専用のディレクトリにする。これは `protectSettings` で既に使っている構成である。
- ホストの `~/.claude` の各エントリを、このディレクトリの中に1つずつ bind mount する。
- `protectSettings` が false なら、すべてのエントリを read-write で mount する。true なら、従来どおり設定類を read-only にする。
- ホストの `.credentials.json` は mount しない。代わりにダミーファイルを、このディレクトリの中の `.credentials.json` の位置に bind mount する。

ホストの `~/.claude` をそのまま mount し、その中の `.credentials.json` にダミーを被せる構成は取らない。ホストの Claude Code は、一時ファイルを書いて rename することで `.credentials.json` を置き換える。Linux では、別の mount namespace で mount point になっているファイルを rename で置き換えると、その mount が外れる。外れた後は、read-write で mount されたホストの `~/.claude` を通して、本物の `.credentials.json` が container から読み書きできてしまう。セッション専用のディレクトリの中なら、ホストはダミーの mount point に触れない。

ダミーファイルの生成は pure な関数とし、ホストのファイルの読み取りは probe で行う。
ダミーファイルはセッション終了時に削除する。

### 2. ホスト側の credential source

broker と同じホスト側のプロセスで、Claude の OAuth credential を保持する。

- `current()` は、保持している access token を同期的に返す。broker の判定処理を非同期にしないためである。
- 期限の5分前に、バックグラウンドで更新処理を始める。

更新処理は次の順に行う。

1. Claude Code と同じ2つのロックを取る。
   - `~/.claude/.oauth_refresh.lock`
   - `<realpath(~/.claude)>.lock`
   - どちらも proper-lockfile と同じ形式（ディレクトリの mkdir で取得し、5秒ごとに mtime を更新する）とする。mtime が60秒以上更新されていないロックは stale とみなして奪う。
2. ロックを取った後にホストのファイルを読み直す。access token が保持している値から変わっていれば、他のプロセスが更新済みなので、その値を採用して終わる。
3. 変わっていなければ、`https://platform.claude.com/v1/oauth/token` に refresh の request を送る。
   - body は `{"grant_type": "refresh_token", "refresh_token": ..., "client_id": ..., "scope": ...}` とする。
   - `client_id` はファイルの `clientId` を使い、なければ Claude Code の既定値 `9d1c250a-e61b-44d9-88ed-5944d1962f5e` を使う。
   - `scope` はファイルの `scopes` を空白で連結する。
   - response の `refresh_token` がなければ、元の refresh token を使い続ける。
4. 結果をホストのファイルへ書き戻してから、ロックを解放する。
   - 書き戻しは、同じディレクトリの一時ファイルに全体を書いてから rename で置き換える。読み手が書きかけのファイルを読むことはない。ホストの Claude Code も同じく rename で置き換えるので、このファイルを bind mount しているセッションへの影響は、ホストの Claude Code が更新したときと変わらない。
   - 書き戻すのは `claudeAiOauth` のうち access token、refresh token、期限の項目だけとし、他の項目は読み直した内容のまま残す。

この通信はホストから直接行い、proxy を通さない。

### 3. broker による認証 header の差し替え

broker は、解決結果が `"proxy"` のセッションで、次の request の判定を変える。

- 宛先が `api.anthropic.com` または `mcp-proxy.anthropic.com` で、最終的な帰結が allow の request
  - `Authorization: Bearer <current()>` を注入する。
  - `x-api-key` を削除する指示を載せる。
  - 利用者の設定がこの2つのホストに `Authorization` の `inject` を持っていても、こちらを優先する。
- 宛先が `platform.claude.com` で、`POST /v1/oauth/token` の request
  - policy の評価より前に deny とする。container が持つ refresh token はダミー値なので、通しても失敗するだけである。deny にしておけば、proxy が本物の token を扱う経路を作らずに済む。

拒否した request には注入しない。これは既存の `decorateAllow` と同じ扱いである。

### 4. addon の header 削除

broker の判定結果に `removeHeaders`（header 名の配列）を追加する。
addon は、`injectHeaders` の適用より前に、`removeHeaders` に挙がった header を request から削除する。

## エラー時の扱い

- セッション開始時にホストのファイルがない、または `claudeAiOauth` の access token と refresh token がない
  - セッションを開始しない。ホストで `claude /login` するか、`auth = "shared"` で opt-out するよう案内する。
- 更新処理が失敗した（ネットワーク障害、refresh token の失効等）
  - 保持している access token を注入し続ける。
  - 30秒後に更新処理をやり直す。やり直しのたびにホストのファイルを読み直すので、ホストで再ログインすれば新しい token が採用される。
  - 失敗は nas のログに出す。
- ロックが取れない
  - stale でなければ、1〜2秒の間隔で最大5回やり直す。やり直しの前にホストのファイルを読み直し、他のプロセスが更新済みならその値を採用する。
  - 5回で取れなければ、更新処理の失敗と同じ扱いにする。

## 既知の制限

- Bedrock（`CLAUDE_CODE_USE_BEDROCK`）、Vertex（`CLAUDE_CODE_USE_VERTEX`）、`apiKeyHelper`、`ANTHROPIC_BASE_URL` による gateway を使う profile は、設定の検証で検出しない。これらを使う場合は `auth = "shared"` を指定する。
- inject は request が TLS かどうかを見ないので、平文の HTTP の request にもホストの token が付きうる。これは inject 全体の問題であり、`docs/todo/security.md` に記録して別に扱う。
- `"proxy"` では、container の `~/.claude` がセッション専用のディレクトリになる。そのため、container の Claude Code が `~/.claude` の直下に新しく作ったファイルやディレクトリは、ホストに残らずセッション終了とともに消える。セッション開始時にホストに存在したエントリの中への書き込みは、ホストに残る。
- `protectSettings` が false のとき、`~/.claude` の直下の symlink は bind mount せず、同じ参照先の symlink をセッション専用のディレクトリに作る。参照先は container の中で解決されるので、直接 mount していたときと同じく、container に mount されていない場所を指す symlink はたどれない。
- container 内の Claude Code が 401 を受けると、ダミーの refresh token で更新を試み、deny される。このとき Claude Code がダミーファイルを消去してログインを求める可能性がある。消えるのはセッション専用のファイルなので、ホストには影響しない。そのセッションはやり直しが必要になる。
- container 内で `/login` すると、本物の token がダミーファイルに書き込まれ、container から見える。上流へ送られる `Authorization` は broker が上書きするので、使われる credential はホストのものになる。ログインはホストで行う。
- refresh の request の形式と `client_id` の既定値は、Claude Code の実装に合わせたものである。Claude Code がこれを変えると更新処理が失敗する。その場合も、ホストの Claude Code が更新したファイルを読み直すことで、ホストで Claude Code を使っていれば動き続ける。

## テスト

`.claude/skills/test-policy/SKILL.md` に従う。

- unit test（`*_test.ts`、Docker なし）
  - 設定の解決と検証。既定値、opt-out、Claude 以外への `"proxy"` の明示、API key の env との組み合わせ。
  - ダミーファイルの生成。コピーする項目としない項目、sentinel の形式。
  - credential source の更新処理。ファイル読み取り、ロック、refresh の request を fake に差し替え、期限内、他プロセスによる更新済み、自分で更新して書き戻し、更新失敗とやり直し、ロックの競合と stale の分岐を確認する。
  - ロックの実装。一時ディレクトリで、mkdir による取得、mtime の更新、stale の判定、解放を確認する。
  - 書き戻し。一時ディレクトリで、内容が新しいテキストと一致し、mode が 0600 で、成功後も失敗後も一時ファイルが残らないこと、`claudeAiOauth` の対象外の項目が残ることを確認する。
  - broker の判定。対象ホストへの allow で `Authorization` の注入と `x-api-key` の削除指示が載ること、deny では載らないこと、利用者の `inject` より優先されること、`POST /v1/oauth/token` が deny になること、`"shared"` では何も変わらないことを確認する。
  - Claude の mount の組み立て。`"proxy"` ではセッション専用のディレクトリが `~/.claude` になり、ホストの `.credentials.json` が mount されず、ダミーファイルがそのディレクトリの mount より後に並ぶことを確認する。ホストの `~/.claude` のディレクトリの上にダミーを被せる組み立てになったら失敗することも確認する。
- addon の unit test（python）
  - `removeHeaders` の header が削除され、`injectHeaders` がその後に適用されること。

## Why — なぜこのアプローチを選んだか

- ホスト側で token を更新すれば、container は本物の token を一切持たずに済む。攻撃者の credential の差し替えに加え、共有ファイルへの書き込み経路も同時になくなる。
- 更新の協調は、Claude Code が既に使っているロックとファイルの読み直しに合わせた。ホストの Claude Code や複数の nas セッションと、既存の仕組みのまま共存できる。
- `current()` を同期にし、更新をバックグラウンドで行うことで、broker の判定処理（`decorateAllow`）を同期のまま保てる。
- 設定キーを `agentState.auth` とエージェント共通にしたのは、既存の `agentState.protectSettings` と同じ形にするためである。Codex 等に広げるときも設定の形を変えずに済む。未指定時の既定値をエージェントごとに決めることで、未実装のエージェントの挙動を変えずに Claude だけを既定で `"proxy"` にできる。

## Why Not — なぜ他の案を選ばなかったか

- 案 A: `claude setup-token` の長期 token を静的な secret として注入する — 更新処理は不要になるが、token の scope が推論用に限られる。`/api/oauth/*` を使う機能（claude.ai の connector、skill や plugin の配布、usage 表示）が使えなくなる可能性がある。
- 案 C: container からの更新 request を proxy が横取りし、ダミー値と本物を対応付ける — Claude Code から見た動作は今と同じになるが、proxy が response を書き換え、ダミー値と本物の対応表を持つ必要がある。proxy の責務が大きくなりすぎる。
- 案 D: 共有と container 内での更新は残し、broker がホストのファイルを読み直して `Authorization` だけを上書きする — 変更は小さいが、token は container から見えたままで、共有ファイルへの書き込み経路も残る。
- 案 E: API key を使い、静的な secret として注入する — 実装は今の nas のままで済むが、利用料金が subscription の約100倍になり、採用できない。
- 設定キーを Claude 固有（`agentState.claudeOAuth`）にする案 — 意味は明確だが、Codex に広げるたびにキーが増える。
- キー名を `credentials` にする案 — 廃止した network の `credentials` と同じ語になる。設定の読み込み前に旧識別子を検出する処理（`src/network/authz/validate.ts` の `LEGACY_IDENTIFIERS`）がどのブロックの中かを区別しないので、新しいキーまで旧設定として弾かれる。
- ダミーのファイルだけを bind mount し、ホストの `~/.claude` はそのまま mount する案 — mount の数は増えないが、ホストの Claude Code が `.credentials.json` を rename で置き換えた時点で mount が外れ、本物のファイルが container から読み書きできるようになる。エントリを1つずつ mount しても、`docker run` の時間は DinD での計測で約 30ms 増えるだけだった。
- Claude Code の `CLAUDE_SECURESTORAGE_CONFIG_DIR` で container の credential の保存先を変える案 — 増える mount は1つだが、ホストの `~/.claude` がそのまま見えているので、上の案と同じく本物のファイルが読み書きできるようになる。
- 書き戻しを同じ inode への上書きで行う案 — bind mount しているセッションからも新しい内容が見えるが、書き込みと切り詰めの間に読んだプロセスは壊れた JSON を読む。ホストの Claude Code 自身が rename で置き換えるので、inode を保っても bind mount しているセッションの状況は良くならない。
