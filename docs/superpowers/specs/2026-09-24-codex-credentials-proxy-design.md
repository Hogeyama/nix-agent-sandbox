# Codex の認証情報をホスト側で管理し、proxy で注入する

## 背景

Codex CLI は、ChatGPT アカウントでログインすると `~/.codex/auth.json` に OAuth の token を保存する。

- `tokens.access_token`：`chatgpt.com` への request に `Authorization: Bearer` として付ける。
- `tokens.refresh_token`：`https://auth.openai.com/oauth/token` で access token を更新する。更新のたびに新しい値に変わる（rotation）。
- `tokens.id_token`：アカウントの情報（email、plan、account id）を持つ JWT。
- `tokens.account_id`：`chatgpt-account-id` header に付ける。

nas は現在、ホストの `~/.codex` をディレクトリごと container と read-write で共有している。
そのため、Claude で [2026-09-24-agent-credentials-proxy-design.md](2026-09-24-agent-credentials-proxy-design.md) が挙げた2つの問題が、Codex にもそのまま当てはまる。

- container から本物の access token と refresh token を読める。refresh token は長期間有効で、container の外へ持ち出されるとアカウントを使い続けられる。
- container から `auth.json` に攻撃者の token を書き込める。書き込まれると、ホストの Codex が以後の会話を攻撃者のアカウントで送る。

Codex の token は、ファイルに保存する代わりに OS のキーリングにも保存できる（`cli_auth_credentials_store = "keyring"`）。
しかし container からキーリングを使うには、Secret Service の呼び出しを DBus で許可する必要があり、Codex 以外の秘密も取得できてしまう。

## 目的

- `chatgpt.com` へ送る request の認証情報を、ホストが持つ本物の credential に揃える。
- OAuth の access token、refresh token、id token を container から見えないようにする。
- container からホストの `auth.json` へ書き込む経路をなくす。
- `~/.codex` のそれ以外の中身（履歴、セッション、SQLite の DB、skills、plugins、設定）は、今と同じくホストと共有する。

## 対象外

- API key での利用。API key を使う利用者は `"shared"` で opt-out する。
- ホストがキーリングに保存している場合。`"shared"` とキーリングの設定（既存）を使う。
  - Codex はキーリングに保存するたびに `~/.codex/auth.json` を削除する（キーリングの2つの保存方式のどちらも）。ホストに `auth.json` が無い状態でダミーを mount すると、Docker がホストに空のファイルを作り、ホストの Codex が token を更新するたびにそれを削除して mount が外れる。キーリングへの対応には別の設計が要るので、別の変更で扱う。
- Dev Container。Dev Container の Codex は VS Code 拡張機能が起動し、状態の扱いが異なるので、別の変更で扱う。
- Copilot。Copilot の token はホストのキーリングにあり、`~/.copilot` には無い。container で使う `GITHUB_TOKEN` は、既存の secrets と header 注入でダミー値にできる。

## 設定

`agentState.auth` の意味は変えない。変えるのは、どのエージェントに適用するかである。

- Codex も `"proxy"` に対応する。未指定のときの既定値は `"proxy"` とする。ただし Dev Container では `"shared"` とする。
- `agentState.auth` は、起動するエージェントだけでなく `extraAgents` のエージェントにも適用する。
  - 解決はエージェントごとに行う。未指定なら、そのエージェントの既定値になる。
  - `"proxy"` を明示したとき、対応していないエージェント（Copilot）は `"shared"` として扱う。Copilot は `~/.copilot` に token を持たないので、これで保護が弱まることはない。
  - `"proxy"` を明示し、起動するエージェントも `extraAgents` も `"proxy"` に対応していないときは、設定エラーとする。

設定の解決では、Claude の既存の検証に加えて次を検証する。

- Codex の解決結果が `"proxy"` で、profile の `env` に `OPENAI_API_KEY` または `CODEX_API_KEY` がある。
  - 判定の対象は `key` を静的に書いたエントリだけとする（Claude と同じ理由）。
  - エラーメッセージで `auth = "shared"` による opt-out を案内する。

既定値の変更によって、既存の Codex profile の挙動が変わる。リリースノートに記載する。

## 構成

Codex の解決結果が `"proxy"` のとき、次の部品が協調して動く。
broker による header の差し替えと addon の header 削除は、Claude の仕組みを複数の credential に広げて使う。

### 1. ダミーの `auth.json`

セッション開始時に、ホストの `~/.codex/auth.json` を読み、ダミーのファイルをセッション専用のディレクトリに作る。
Codex はファイルを読み込むときに `id_token` を JWT として解析するので、ダミーにも JWT の形をした値が要る。
Codex は署名を検証しないので、署名なしの JWT を nas が作る。

| 項目 | 値 |
| --- | --- |
| `auth_mode` | `"chatgpt"` |
| `OPENAI_API_KEY` | `null` |
| `tokens.id_token` | nas が作る署名なしの JWT。payload はホストの id token から下の claim だけをコピーする |
| `tokens.access_token` | nas が作る署名なしの JWT。`exp` を十分遠い未来にし、ホストの access token から下の claim だけをコピーする |
| `tokens.refresh_token` | 固定の接頭辞を持つ sentinel 文字列 |
| `tokens.account_id` | ホストのファイルからコピーする |
| `last_refresh` | ファイルを作った時刻 |

- id token からコピーする claim は `email`、`https://api.openai.com/profile` の `email`、`https://api.openai.com/auth` の `chatgpt_plan_type`、`chatgpt_user_id`、`user_id`、`chatgpt_account_id`、`chatgpt_account_user_id`、`chatgpt_account_is_fedramp` とする。Codex が plan の表示や workspace の判定に使う値である。それ以外の claim はコピーしない。
- access token からコピーする claim は `https://api.openai.com/auth` の `chatgpt_account_id` と `chatgpt_account_user_id` とする。Codex は access token からこの2つを読み、workspace のメンバーかを確かめる。
- access token の `exp` を遠い未来にするのは、Codex が自分で更新を始めないようにするためである。Codex は access token を JWT として読めればその `exp` の5分前に、読めなければ `last_refresh` の8日後に更新を始める。
- 署名の部分には sentinel を入れ、nas が作った値だと分かるようにする。
- それ以外の項目はコピーしない。未知の項目が秘密を含む可能性があるためである。

ダミーファイルの生成は pure な関数とし、ホストのファイルの読み取りは probe で行う。
ダミーファイルはセッション終了時に削除する。

### 2. mount

ホストの `~/.codex` は、今と同じく read-write で mount する。`protectSettings` による `config.toml` の read-only の上乗せも今と同じである。
その後に、ダミーファイルを container の `~/.codex/auth.json` の位置に bind mount する。

Claude では、container の `~/.claude` をセッション専用のディレクトリにし、ホストのエントリを1つずつ mount した。Codex では同じ構成を取らない。

- Codex は `~/.codex` の直下に SQLite の DB（`state_5.sqlite`、`logs_2.sqlite` 等）を置く。
- SQLite の `-wal` と `-shm` は、接続の開始と終了に応じて作られ、消える。
- セッション専用のディレクトリでは、セッション開始時にホストに無かった直下のエントリは、そのディレクトリの中に作られる。DB 本体はホストにあり、WAL だけが container の中に置かれる。WAL にしか無い書き込みはセッション終了とともに消え、ホストの Codex が同じ DB を使っていれば、別々の WAL を使うことになって DB が壊れうる。

この構成の弱点は、ホストで `auth.json` が消えるか別のファイルに置き換わると、ダミーの mount が外れることである。
Linux では、別の mount namespace で mount point になっているファイルを unlink や rename で置き換えると、その mount が外れる。
外れた後にホストで本物の `auth.json` が作られると、read-write で mount したホストの `~/.codex` を通して、container から読み書きできてしまう。

- ホストの Codex 自身は、token を更新するとき `auth.json` を同じファイルに上書きする（truncate して書く）。inode が変わらないので、mount は外れない。
- mount が外れるのは、ホストで `codex logout`（ファイルの削除）をした場合と、別のツールがファイルを rename で置き換えた場合である。

これを次の監視で扱う。

### 3. ホストの `auth.json` の監視

ホスト側の credential source が、セッションの間、ホストの `~/.codex/auth.json` を監視する。

- セッション開始時に、ダミーを mount した時点のホストのファイルの inode（device と inode 番号）を記録する。
- `~/.codex` を `fs.watch` で監視し、`auth.json` に関するイベントのたびに inode を確かめる。イベントの取りこぼしに備え、5秒ごとにも確かめる。
- ファイルが無くなった、または inode が変わったら、次のことを行う。
  - `chatgpt.com` の `/backend-api` の下への request への注入をやめ、以後その request を deny する。
  - セッションを止める。
    - container をまだ起動していなければ、準備の pipeline を中断し、container を起動しない。監視は proxy の段階で始まり、DinD の起動などが container の起動より前にあるので、この間に置き換わることがある。
    - container を起動した後なら、container を猶予なしで kill する（SIGKILL）。`docker stop` の SIGTERM の後の猶予（既定で10秒）を与えると、SIGTERM を無視する agent がその間に本物のファイルを読める。
    - `docker run` を始めた直後は、container がまだ動いていないため kill が失敗する。kill が通るか、セッションが終わるまで、やり直す。失敗は warn として nas のログに出す。
  - 理由を nas のログに出し、ホストでの logout や置き換えが原因であることを示す。

`codex logout` はまずファイルを削除するので、再び `codex login` で本物が書かれる前に container を止められる。
rename で置き換えられた場合は、置き換えから container の停止までの間、本物のファイルが container から見える。この間隔は既知の制限とする。

### 4. ホスト側の credential source

broker と同じホスト側のプロセスで、Codex の OAuth credential を保持する。Claude の credential source と同じ interface を持つ。

- `current()` は、保持している access token と account id を同期的に返す。
- access token の `exp`（JWT の claim）の2分前に、バックグラウンドで更新処理を始める。

更新処理は次の順に行う。

1. nas 用のロックを取る。
   - Codex 自身はファイルのロックを使わない（同じプロセスの中でだけ排他する）。このロックは、複数の nas セッションどうしの更新を排他するためのものである。
   - ロックはホストの `~/.codex` の外、nas のホスト側の状態ディレクトリに置く。container から read-write で見える `~/.codex` に置くと、container がロックを握ったまま離さないことで、更新を止められるためである。
   - 形式は Claude と同じく、ディレクトリの mkdir で取得し、mtime を更新し続けるものとする（`src/lib/oauth_refresh_lock.ts`）。
2. ロックを取った後にホストのファイルを読み直す。access token が保持している値から変わっていれば、他のプロセスが更新済みなので、その値を採用して終わる。
3. 変わっていなければ、`https://auth.openai.com/oauth/token` に refresh の request を送る。
   - body は JSON で `{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "grant_type": "refresh_token", "refresh_token": ...}` とする。Codex 0.155.1 の実装に合わせた。
   - response の各 token は省略されうる。省略された token は元の値を使い続ける。
4. 結果をホストのファイルへ書き戻してから、ロックを解放する。
   - 書き戻しは、Codex と同じく同じファイルへの上書き（truncate して書く）で行う。rename で置き換えると、inode が変わり、実行中の各セッションの container でダミーの mount が外れ、監視がそのセッションを止めてしまうためである。
   - 書き戻すのは `tokens` の `id_token`、`access_token`、`refresh_token` と `last_refresh` だけとし、他の項目は読み直した内容のまま残す。
   - 書き戻しの後、記録している inode が変わっていないことを確かめる。

refresh token は rotation するので、2つのプロセスが同じ refresh token で同時に更新すると、後の方は `refresh_token_reused` で失敗する。
ホストの Codex とはロックを共有できないため、次のようにしてこの競合を起きにくくする。

- ホストの Codex は `exp` の5分前に更新する。nas はそれより遅い2分前に更新する。ホストの Codex が動いていれば先に更新し、nas は手順2でその値を採用する。
- 更新の前に必ずファイルを読み直す。

この競合は、今のようにホストと container が同じ `auth.json` を共有して、それぞれの Codex が更新する場合にも起きる。この変更で新たに生じるものではない。

この通信はホストから直接行い、proxy を通さない。

### 5. broker による header の差し替え

broker は、Codex の解決結果が `"proxy"` のセッションで、次の request の判定を変える。

- 宛先が `chatgpt.com` で、path が `/backend-api` か `/backend-api/` で始まり（query を除いて比べる）、最終的な帰結が allow の request
  - `Authorization: Bearer <access token>` を注入する。
  - `chatgpt-account-id: <account id>` を注入する。container が付けた値はダミーファイルからのものなので同じ値になるが、ホストの token と異なる account を指定できないよう、上書きする。
  - 利用者の設定がこのホストに同じ header の `inject` を持っていても、こちらを優先する。
- 宛先が `auth.openai.com` で、`POST /oauth/token` の request
  - policy の評価より前に deny とする。container が持つ refresh token はダミー値なので、通しても失敗するだけである。

拒否した request には注入しない。

`chatgpt.com` の他の path（ChatGPT の画面や、consumer 向けの API）には注入せず、通常の policy のとおりに扱う。
Codex が ChatGPT のアカウントで使う API は `/backend-api/` の下にあり、それ以外の path にホストの token を付ける理由がない。
path が分からない request（CONNECT など）にも注入しない。

Claude と Codex の両方が `"proxy"` のセッション（`extraAgents` で両方を用意した場合）では、broker はそれぞれの credential source を持ち、宛先のホストで使い分ける。
注入するホスト、削除する header、deny する更新の request を、エージェントごとの定義にまとめる。

## エラー時の扱い

- セッション開始時にホストのファイルがない、`auth_mode` が ChatGPT でない、または `tokens` の access token か refresh token がない
  - セッションを開始しない。ホストで `codex login` するか、`auth = "shared"` で opt-out するよう案内する。
  - ホストがキーリングに保存している場合もファイルがないので、この扱いになる。案内に、キーリングの場合は `agentState.auth = "shared"` とキーリングの設定を使うことを含める。
  - 既定値が `"proxy"` なので、キーリングや API key を使う既存の Codex profile は、`"shared"` を指定するまで起動しなくなる。リリースノートに記載する。
- 更新処理が失敗した、またはロックが取れない
  - Claude と同じく、保持している access token を注入し続け、30秒後にやり直す。やり直しのたびにホストのファイルを読み直すので、ホストの Codex が更新するか、ホストで再ログインすれば、その token が採用される。
- ホストの `auth.json` が消えた、または置き換わった
  - 「3. ホストの `auth.json` の監視」のとおり、セッションを止める。

## 既知の制限

- ホストで `auth.json` を rename で置き換えると、container を止めるまでの間、本物のファイルが container から見える。
- ホストの Codex との間で refresh token の更新が競合すると、片方が `refresh_token_reused` で失敗する。nas が失敗した場合は、ホストの Codex が更新したファイルを読み直して回復する。ホストの Codex が失敗した場合は、ホストで再ログインが必要になることがある。
- container の Codex が 401 を受けると、ダミーの refresh token で更新を試み、deny される。Codex はこれを回復できない失敗として扱い、ログインを求める可能性がある。そのセッションはやり直しが必要になる。
- container 内で `codex login` すると、本物の token がダミーファイルに書き込まれ、container から見える。上流へ送る `Authorization` は broker が上書きするので、使われる credential はホストのものになる。ログインはホストで行う。
- 注入するのは `chatgpt.com` の `/backend-api` の下だけである。Codex は `*.chatgpt.com` も ChatGPT の通信として扱うが、既定の送信先は `https://chatgpt.com/backend-api/` である。他のホストや path への認証付きの通信が必要になれば、定義に追加する。
- refresh の request の形式と `client_id` は、Codex の実装に合わせたものである。Codex がこれを変えると更新処理が失敗する。その場合も、ホストの Codex が更新したファイルを読み直すことで、ホストで Codex を使っていれば動き続ける。
- inject が平文の HTTP の request にも適用されうる問題は、Claude と同じく `docs/todo/security.md` で扱う。

## テスト

`.claude/skills/test-policy/SKILL.md` に従う。

- unit test（`*_test.ts`、Docker なし）
  - 設定の解決と検証。Codex の既定値、Dev Container での既定値、opt-out、`extraAgents` への適用、`"proxy"` の明示と Copilot の組み合わせ、API key の env との組み合わせ。
  - ダミーファイルの生成。コピーする claim としない claim、JWT の形（3つの部分、base64url）、access token の `exp`、sentinel の形式。生成した id token と access token を、Codex と同じ手順（payload の base64url decode と JSON の解析）で読めること。
  - credential source の更新処理。ファイル読み取り、ロック、refresh の request を fake に差し替え、期限内、他プロセスによる更新済み、自分で更新して書き戻し、更新失敗とやり直し、response で token が省略された場合を確認する。
  - 書き戻し。一時ディレクトリで、inode が変わらないこと、`tokens` の対象外の項目と他の項目が残ること、mode が保たれることを確認する。
  - 監視。一時ディレクトリで、ファイルの削除、rename による置き換え、同じファイルへの上書きのそれぞれで、停止の通知が出る・出ないことを確認する。
  - broker の判定。`chatgpt.com` の `/backend-api` の下への allow で `Authorization` と `chatgpt-account-id` の注入が載ること、他の path には載らないこと、deny では載らないこと、利用者の `inject` より優先されること、`POST auth.openai.com/oauth/token` が deny になること、Claude と Codex の両方がある場合にホストで使い分けること、監視が停止を通知した後は deny になることを確認する。
  - Codex の mount の組み立て。`"proxy"` ではダミーファイルがホストの `~/.codex` の mount より後に並ぶこと、`"shared"` では並ばないことを確認する。

## Why — なぜこのアプローチを選んだか

- ホストの `~/.codex` をそのまま共有し、`auth.json` だけを差し替えることで、履歴、セッション、SQLite の DB、skills、plugins を今と同じく使える。
- ダミーの mount が外れる条件は、ホストでの logout と rename による置き換えに限られる。Codex 自身の更新は同じファイルへの上書きなので、普段の利用では外れない。外れた場合も監視でセッションを止める。
- 更新をホストで行い、ダミーファイルでは Codex が更新を始めないようにすることで、container は本物の token を一切持たずに済む。
- broker の差し替えは Claude と同じ仕組みを使い、エージェントごとの定義を足すだけで済む。

## Why Not — なぜ他の案を選ばなかったか

- 案 A: Claude と同じく、container の `~/.codex` をセッション専用のディレクトリにし、ホストのエントリを1つずつ mount する — mount が外れる弱点はなくなるが、SQLite の WAL がホストの DB と別の場所に作られ、書き込みが消えるか DB が壊れる。
- 案 B: Docker Sandboxes（sbx）と同じく、ホストの `~/.codex` を共有せず、container に `{"OPENAI_API_KEY": "proxy-managed"}` だけの `auth.json` を置く — 実装は最も簡単だが、履歴、セッション、skills、plugins、設定がホストと共有されなくなる。また Codex が API key のモードで動くので、ChatGPT のアカウントに紐づく機能（cloud requirements 等）が使えない（docker/sbx-releases#153）。
- 案 C: container からの更新 request を proxy が横取りし、上流で本物を更新して、応答をダミー値に差し替えて返す（sbx の OpenCode 用の設定が取る方式） — Codex から見た動作は今と同じになるが、proxy が response を書き換える必要がある。Claude で採らなかった理由と同じである。
- 案 D: ホストをキーリングに切り替え、container には DBus で Secret Service を許可する（既存の設定） — Codex 以外の秘密も取得できてしまう。
- ダミーの `access_token` を JWT でない sentinel にする案 — Codex は JWT として読めない access token では `last_refresh` を基準に更新を判断する。`last_refresh` を未来の日時にすれば更新は抑えられるが、Codex は access token から `chatgpt_account_user_id` を読むので、JWT でないとその確認ができなくなる。
- 書き戻しを rename で行う案 — 読み手が書きかけのファイルを読むことはなくなるが、inode が変わって各セッションのダミーの mount が外れる。ホストの Codex 自身も同じファイルへの上書きで保存しているので、読み手への影響は今と変わらない。
