# コーディングエージェントのセキュリティ対策の選定

## 想定する被害

* A: 情報の持ち出し
  * 1: third party への流出（厳格、コードやシステム情報もだめ）
  * 2: second party への流出（寛容、コードやシステム情報はいいけどシークレットはだめ）
    * GitHubの自user/orgへのpushやAnthropicへのinputなど
      * （当然ながらAnthropicにAnthropicのアクセストークンを送るのは許容する）
  * 3: 意図しない保存（将来的に1,2に繋がりうる）
    * コミットログにシークレット書いちゃったとか
* B: 破壊
  * 1: 本番環境の破壊
    * 本番DBに書き込んだ、メール送信した、とか
  * 2: 開発環境の破壊
    * `rm ./ -rf`

## 脅威の経路

* X: 敵対的エージェント
  * プロンプトインジェクションでエージェント自体が敵対的になった
* Y: エージェントの過失
  * エージェントの書いたコマンドにバグがあった
* Z: サプライチェーン
  * 依存関係に攻撃的なコードが含まれる
  * Coding Agent特有の問題ではないが、脅威が増しているので検討に入れておく

## 被害と経路のマッピング

各セルはリスク（高中低）と典型的なシナリオを示す。

| 被害 \ 経路 | X: 敵対的エージェント | Y: エージェントの過失 | Z: サプライチェーン |
|---|---|---|---|
| A1: third party への流出 | （高🔴）`.env` や `~/.aws` の内容を `curl` で攻撃者のサーバへ送信する | （低🔵）単独では起きにくい。A3経由で後から発生することはあるかも | （高🔴）`npm install` の postinstall や `pip` の setup.py が環境変数やホームディレクトリを収集して送信する |
| A2: second party への流出 | （中🟡）publicリポジトリ狙いでAWSのシークレットを`git push`させるとか | （高🔴）設定ファイルやログを読んだらシークレットが含まれていて、そのままコンテキストに混入する。シークレットをコミットして`git push`する | （中🟡）依存パッケージが標準出力にトークンをダンプし、ツール出力としてコンテキストに混入する |
| A3: 意図しない保存 | （中🟡）シークレットを README、テストフィクスチャ、チケットに書き込む。後日 A1 や A2 につながる | （高🔴）`.env` を `git add -A` でコミットする。デバッグ用にトークンをハードコードしたまま残す | （低🔵）依存がキャッシュやロックファイルに認証情報を書き出す |
| B1: 本番環境の破壊 | （高🔴）本番の接続情報が手に入れば、DB への書き込み、メール送信、デプロイを実行する | （中🟡）`.env` が本番を指していた、テストが本番エンドポイントに向いていた、`terraform apply` を間違った workspace で実行した | （低🔵）依存コードが実行環境の認証情報を使って外部サービスを操作する |
| B2: 開発環境の破壊 | （高🔴）`rm -rf`、`git push --force`  | （高🔴） `rm -rf ./` の cwd 間違い、`git checkout .` による未コミット変更の消失、`git clean -fdx` | （低🔵）破壊を目的にすることはなさそう |

※例えばthird partyへの情報流出を目論んだ`settings.json`の改竄はB2ではなくA1として扱う

## 要求（仮）

被害と経路のペアのうち、どれを許容し、どれを許容しないか検討する。  
X（敵対的エージェント）による攻撃は、少なくとも事後的には気付けるだろうと考えると、こんな感じでよいのでは

* A1: 絶対に起きてはならない
* B1: 絶対に起きてはならない
* A2:
  * X: 許容
  * Y: 起きてはならない
  * Z: 許容
* A3:
  * X: 許容
  * Y: 起きてはならない
  * Z: 許容
* B2:
  * X: 許容
  * Y: 起きてはならない
  * Z: 許容

## 対策

要求で「起きてはならない」とした 5 項目（A1-*、B1-*、A2-Y、A3-Y、B2-Y）は、以下に挙げる対策の組み合わせで満たせる。単独で要求を満たす対策はなく、隔離層の選択で分かれる次の 5 系統がそれぞれ要求を満たす。

* 系統 1: settings.json（`permissions` + `sandbox`）+ sumi + auto mode
* 系統 2: srt + sumi + auto mode
* 系統 3: Dev Container + firewall + sumi + auto mode
* 系統 4: nas + auto mode（sumi は任意）
* 系統 5: Docker Sandbox + sumi + auto mode

組み合わせがこの形になる理由を「組み合わせの形」で述べ、続いて系統ごとに設定例、残存リスク、その他の pros / cons を記す。対策ごとの詳細な根拠と既知の回避経路は付録に記す。

### 検討した対策

* Claude Code settings.json [`$.permissions`](https://code.claude.com/docs/ja/permissions) + [`$.sandbox`](https://code.claude.com/docs/ja/sandboxing)
* [Claude Code auto mode](https://code.claude.com/docs/ja/auto-mode-config)
* manual approve on tool call
* [Dev Container](https://code.claude.com/docs/ja/devcontainer)
  * Anthropic の例のように iptables を制限する前提で考える
* [Docker Sandbox](https://www.docker.com/products/docker-sandboxes/)
* [Anthropic srt](https://github.com/anthropics/sandbox-runtime)
* Hooks でシークレットマスク
  * [sumi](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/contrib/sumi/README.md) （手前味噌ではございますが）
* Docker製のsandbox
  * [nix-agent-sandbox](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/README.md) （手前味噌ではございますが2）

### 組み合わせの形

対策が被害と経路の組を防げるかは、

* ◎（防御が成立する）
* ○（典型的には成立するが防御できない経路が存在する）
* ×（成立しない）

の 3 段階で評価する。より具体的には

* ○ と × は、その機構が被害の主な経路に適用されるかどうかで分け、典型シナリオの一部にしか適用されないものは × とする。
* A1 は Claude Code 本体を含む全プロセスの送信先が allowlist で閉じることを以て ◎ とする
* B1 は本番環境への接続性をなくせること、またはワークスペースにあるパスワードが入手不可能にできることを以て ◎ とする
* B2 はワークスペース外のホスト領域への書き込みを止められることを以て ◎ とする

◎ に運用上の前提（root へ昇格できない、本物の認証情報を配置しない、など）が付く場合、前提が崩れたときの評価は各系統の残存リスクで扱う。

検討した対策が防御に用いる仕組みは、次の 4 種類の機構に分けられる。1 つの対策が複数の機構を持つこともある（srt は隔離、読取拒否、mask の 3 つを持ち、sumi は mask だけを持つ）。どの被害を防げるかは対策の名前ではなく機構で決まるので、系統の選択は「どの機構をどのツールで実現するか」の問題になる。

| 機構     | 動作                                                            | どの被害に対する防御か                                       | その機構を持つツール                                                                                                                    |
| ---      | ---                                                             | ---                                                          | ---                                                                                                                                     |
| 隔離     | 本体を含む全プロセスの送信先と書き込み先を allowlist で制限する | A1、B1、B2（ワークスペース外）。X、Y、Z のすべてに適用される | srt、Docker Sandbox、Dev Container、nas、settings.json（`sandbox` が Bash を、`permissions` が本体ツールを制限する）                    |
| 読取拒否 | 列挙したパスの読み取りを拒否する                                | A2、A3。実行に使用しない秘密に限定される                     | srt `denyRead`、permissions `Read()` deny（Read ツールと一部コマンドのみ）                                                              |
| mask     | 値を番兵値に置換し、許可先への送信時だけ本物に復元する          | A2、A3、B1（本物を配置しない）                               | srt と `$.sandbox` の `credentials`、nas の proxy mask と注入、Docker Sandbox の `sbx secret`（注入のみ）、sumi（出力のみ。X には無効） |
| 審査     | ツール呼び出しを人か分類器が判定する                            | Y 全般。Anthropic への input は対象外                        | auto mode、manual approve、permissions                                                                                                  |

組み合わせは次の制約の下で選ぶ。

* A1-\* と B1-\* を ◎ にできる機構は隔離だけである
* A2-Y、A3-Y を充足しうるのは読取拒否と mask だけである。
* B2-X のうちワークスペース自体の破壊を阻止する対策はない。書き込みを許可する前提だからで、どの対策でも止められないので評価に含めず、git と外部バックアップによる回復が前提になる。
* Z に適用される機構は隔離だけである。審査を主軸にした構成は Z に無防備である。

必須となる隔離機構をベースに考えると、要求を満たすのは以下に述べる 5 系統になる。

5 系統の設定例は、次の状況を共通に扱う。系統ごとの差は、同じ状況をどの機構で保護するかに現れる。

* 送信先は Anthropic API（`api.anthropic.com`）、GitHub（`github.com` と `api.github.com`。`git push` と `gh` が使用する）、業務 API（`api.example.com`）の 3 つに限定する。
* 実行に使用する秘密は、環境変数 `GH_TOKEN` と、`.env` の `API_PASSWORD`（`api.example.com` の認証）の 2 つである。エージェントには本物を見せず、送信時に本物へ置換するか注入する。
* 実行に使用しない秘密は、`~/.ssh`、`~/.aws`、`~/.config/gh/hosts.yml`（`gh auth login` の保存先）である。読み取り自体を拒否するか、隔離環境に持ち込まない。`gh auth token` を実行されても本物が出力に現れないことを、この項目の確認方法にする。
* 書き込み先はワークスペースに限定する。
* auto mode を使用する系統では、上の送信先を `autoMode.environment` に登録する。

### 系統 1: settings.json（`permissions` + `sandbox`）+ sumi + auto mode

Claude Code 単体で構成する系統である。Bash とその子プロセスは `sandbox` が OS レベルで隔離し、本体の Write / Edit / WebFetch は `permissions` が制限する。sumi をツール出力の墨消しに、auto mode を審査に使用する。

#### 設定例

設定は managed settings（Linux では `/etc/claude-code/managed-settings.json`）に配置する。`~/.claude/settings.json` は Write ツールで改竄できるためである。

```jsonc
// /etc/claude-code/managed-settings.json
{
  "permissions": {
    "defaultMode": "auto",
    "deny": [
      "WebFetch",                 // bare 指定でツール自体を除去する。HTTP MCP は設定しない
      "Read(~/.ssh/**)",          // 実行に使用しない秘密は Read ツールでも拒否する
      "Read(~/.aws/**)",
      "Read(~/.config/gh/**)",    // gh auth login の保存先
      "Read(./.env)",             // mask は Bash 側だけ。Read ツールと @ 指定は deny で拒否する
      "Edit(~/.claude/**)"        // ユーザー設定を Write / Edit の射程から外す
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,           // 初期化失敗時に非 sandbox 実行へ fallback しない
    "allowUnsandboxedCommands": false,   // 両方揃えて fail-closed になる
    "network": {
      "allowedDomains": ["api.anthropic.com", "github.com", "api.github.com", "api.example.com"],
      "tlsTerminate": {}                 // 番兵値の置換に必要
    },
    "filesystem": {
      "allowWrite": ["."],
      "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh"]   // Bash 側の読取拒否
    },
    "credentials": {
      "envVars": [
        { "name": "GH_TOKEN", "mode": "mask", "injectHosts": ["github.com", "api.github.com"] }
      ],
      "files": [
        { "path": "./.env", "mode": "mask", "extract": "API_PASSWORD=(\\S+)", "injectHosts": ["api.example.com"] }
      ]
    }
  },
  "autoMode": {
    "environment": ["$defaults", "Source control: GitHub 上の自組織の org", "Internal API: api.example.com"]
  }
}
```

```sh
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt   # hooks を ~/.claude/settings.json に追加する
```

この設定で `gh auth token` を実行すると、gh は `GH_TOKEN` を保存済み認証情報より優先するので、番兵値 `fake_value_<uuid>` を印字する。`~/.config/gh/hosts.yml` は Bash からも Read ツールからも読めない。

`credentials` の mask と `filesystem.denyRead` は sandbox 内の Bash にしか適用されず、Claude Code 本体が読む Read ツールとプロンプトの `@` 指定には適用されない。そのため `.env` のように mask で運用するファイルも `Read()` の deny に列挙する。公式ドキュメントは Read の deny を Read ツール、Grep、Glob、`@` 指定に best-effort で適用すると述べている。sumi の secrets file に `API_PASSWORD` を登録すれば、`@.env` は sumi の `UserPromptSubmit` hook でも拒否される。

要求の各項目をどの設定が充足するかは次のとおりである。

* A1-*: `sandbox.network.allowedDomains` が Bash と子プロセスの送信先を OS 強制で制限する。本体側は `WebFetch` の deny でツールを除去し、HTTP MCP を設定しない。`failIfUnavailable` と `allowUnsandboxedCommands: false` で fail-closed にする。
* A2-Y: `credentials` に登録した環境変数とファイルは Bash 側で番兵値になる。Read ツールと `@` 指定は `Read()` の deny で拒否する。未登録の値は sumi がツール出力から墨消しする。
* A3-Y: `credentials.files` に登録したファイルは `cp` も `git add` も番兵値を複製する。Read ツールと `@` 指定は `Read()` の deny で拒否する。sumi によりモデルが値を知らないので書き写しは発生しない。auto mode のソフト deny が承認の層として重なる。
* B1-*: 同じ allowlist に本番へ作用しうる送信先を含めない。認証情報は `credentials` の mask で番兵値にし、`injectHosts` の宛先への送信時だけ proxy が本物に置換する。
* B2-Y: `filesystem.allowWrite` がワークスペース外への書き込みを拒否し、`Edit()` の deny が本体ツール側を制限する。auto mode の破壊的操作ソフト deny が承認に回す。

#### 残存リスク

* Write と Edit は OS 強制の外にある。`Edit()` の deny は保護するパスを列挙する方式なので、B2-X は ○ にとどまる。
* Read ツールと `@` 指定も OS 強制の外にある。`Read()` の deny は列挙式で、適用は best-effort なので、列挙から漏れたファイルは mask に登録していても本物のまま読める。srt（系統 2）では本体の読み取りも sandbox 内なのでこの差はない。
* 改竄耐性は設定の配置場所に依存する。`mask` と `tlsTerminate` はリポジトリ側の `.claude/settings.json` では無視されるが、`~/.claude/settings.json` は Write ツールの射程内にある。managed settings に全設定を配置しない構成では、A1-* と B1-* の前提が成立しない。
* 番兵値方式は「どのホストへ本物を送るか」は制御しても「そのホストのどこへ送るか」は制御しない。proxy は Authorization ヘッダとボディを区別せず、リクエスト中の番兵値をすべて置換する。GH_TOKEN の置換先である api.github.com に対して、issue のボディに番兵値を書いて POST すれば、public リポジトリに本物が保存される（A2-X）。`injectHosts` で置換先を本来の宛先に限定しても、その宛先自体への書き込みは残るので、A2-X と A3-X は ○ が上限になる。
* sumi の hooks は `~/.claude/settings.json` にあり、X は hook の無効化やエンコードで回避できる。要求の A2-Y には影響しない。

#### その他の pros / cons

* pros
  * Claude Code 単体で完結し、導入コストは 5 系統で最小である。
* cons
  * `credentials.files` にディレクトリ、glob、8 MiB 超、非 UTF-8 のファイルを登録すると deny 扱いになり、そのファイルを読むビルドが停止する。
  * `Read()` の deny と `denyRead` は、拒否したファイルを実行に使用する場面で作業が停止するので、登録できるのは実行に使用しない秘密に限定される。
  * auto mode のソフト deny のたびに承認が発生する。送信先を `autoMode.environment` に登録しないと誤検知が増加する。

### 系統 2: srt + sumi + auto mode

srt（Anthropic sandbox-runtime）で Claude Code 本体ごと隔離する系統である。系統 1 と同じ sandbox エンジンだが、対象が Bash だけでなく全プロセスに拡大する。sumi と auto mode の役割は系統 1 と同じである。

#### 設定例

```jsonc
// ~/.srt-settings.json
{
  "network": {
    "allowedDomains": ["api.anthropic.com", "github.com", "api.github.com", "api.example.com"],
    "tlsTerminate": {}                   // 番兵値の置換に必要
  },
  "filesystem": {
    "allowWrite": ["."],
    "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh"]   // Read ツールにも Bash にも適用される
  },
  "credentials": {
    "envVars": [
      { "name": "GH_TOKEN", "mode": "mask", "injectHosts": ["github.com", "api.github.com"] }
    ],
    "files": [
      { "path": "./.env", "mode": "mask", "extract": "API_PASSWORD=(\\S+)", "injectHosts": ["api.example.com"] }
    ]
  }
}
```

```sh
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt   # hooks を ~/.claude/settings.json に追加する
srt claude                                                            # Claude Code 本体を sandbox 内で起動する
```

auto mode は `~/.claude/settings.json` の `permissions.defaultMode: "auto"` と `autoMode.environment` で、系統 1 と同様に設定する。`gh auth token` の結果も系統 1 と同じで、番兵値を印字し、`~/.config/gh/hosts.yml` は読めない。

要求の各項目をどの設定が充足するかは次のとおりである。

* A1-*: `network.allowedDomains` が本体を含む全プロセスの送信先を制限する。Write / WebFetch / HTTP MCP も対象になる。
* A2-Y: `credentials` の mask で登録した環境変数とファイルは sandbox 内で番兵値になり、`filesystem.denyRead` で実行に使用しない秘密は読取自体を拒否する。未登録の値は sumi が墨消しする。
* A3-Y: `credentials.files` に登録したファイルは `cp` も `git add` も番兵値を複製するので、誤コミットしても本物は残らない。`denyRead` のパスは git からも読めず commit が停止する。sumi によりモデルが値を知らないので書き写しは発生しない。auto mode の「コミットへのシークレット混入」ソフト deny が承認の層として重なる。
* B1-*: 同じ allowlist と、HTTP 以外の TCP に対する SOCKS5 制御で本番への接続を遮断する。本番の認証情報は mask で番兵値にし、`injectHosts` の宛先への送信時だけ proxy が本物に置換する。
* B2-Y: `filesystem.allowWrite` がワークスペース外への書き込みを拒否する。auto mode の破壊的操作ソフト deny が承認に回す。

#### 残存リスク

* 番兵値方式の限界は系統 1 と同じである。mask のエンジンが同一なので、置換先へのボディに番兵値を書けば本物に戻り、A2-X と A3-X は ○ が上限になる。
* `credentials` は README に記載がなく、schema と実装を読んで 0.0.76 で動作を確認した機能である。版の更新で挙動が変わる可能性は他の対策より高い。
* sumi の hooks は X が回避できる（系統 1 と同じ）。

#### その他の pros / cons

* pros
  * 導入コストは小さい部類である。設定ファイル 1 つと `srt` の prefix で済む。
  * allowlist の強制点が Claude Code の外側にあり、設定の改竄耐性に依存しない。
* cons
  * `denyRead` は拒否したファイルを実行に使用する場面で作業が停止する。
  * auto mode のソフト deny のたびに承認が発生する（系統 1 と同じ）。
  * Claude Code の `$.sandbox` の mask を内側で併用する構成は srt の seccomp と衝突するので、mask は srt 側で設定する（付録に記録）。

### 系統 3: Dev Container + firewall + sumi + auto mode

Anthropic の参照実装（claude-code リポジトリの `.devcontainer/`）をベースにする系統である。コンテナ内の iptables で送信先を allowlist に制限し、sumi と auto mode をコンテナ内の Claude Code に設定する。

#### 設定例

```jsonc
// .devcontainer/devcontainer.json（参照実装から関係する部分を抜粋）
{
  "build": { "dockerfile": "Dockerfile" },
  "runArgs": ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"],   // iptables の操作に必要
  "remoteUser": "node",                                       // 非 root。sudoers は init-firewall.sh の再実行だけを許可する
  "postStartCommand": "sudo /usr/local/bin/init-firewall.sh",
  "remoteEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }         // 本物がそのままコンテナに入る（後述）
}
```

`init-firewall.sh` は参照実装のものを次のように変更する。

* allowlist の宛先を `api.anthropic.com`、`github.com`、`api.github.com`、`api.example.com` に限定する。
* 22/tcp と 53/udp を全宛先に許可している規則を削除し、DNS は必要なリゾルバだけに限定する。参照実装のままでは SSH、scp、DNS による持ち出しと、22 番の本番サーバへの到達が allowlist の外に残る。

`~/.ssh`、`~/.aws`、`~/.config/gh` はコンテナにマウントしないので、コンテナ内に存在しない。一方、mask も注入もないので、`GH_TOKEN` と `.env` の `API_PASSWORD` は本物のままコンテナに入る。この 2 つの値は sumi の secrets file に登録する。`gh auth token` は本物を印字するが、sumi の hook がツール出力から墨消しするので、モデルには到達しない。

コンテナ内の `~/.claude/settings.json` に auto mode（`permissions.defaultMode: "auto"`、`autoMode.environment`）を設定し、`sumi init` で hooks を追加する。

要求の各項目をどの設定が充足するかは次のとおりである。

* A1-*: iptables の allowlist が全プロセスの送信先を制限する。コンテナ内で root へ昇格できないことが前提になる。
* A2-Y: sumi がツール出力を墨消しする。Dev Container 自体に A2 の機構はない。
* A3-Y: sumi によりモデルが値を知らないので書き写しは発生しない。`git add -A` は auto mode のソフト deny で承認に回す。
* B1-*: 同じ allowlist に本番へ作用しうる送信先を含めない。注入機能がないので、認証情報をコンテナ内に配置しない運用と組み合わせる。
* B2-Y: ホスト FS はワークスペースのみマウントする。auto mode の破壊的操作ソフト deny が承認に回す。

#### 残存リスク

* allowlist の強制点がエージェントと同じコンテナの netns にある。他の 4 系統は Bash の境界の外側で強制するので root 昇格の前提が不要だが、この系統だけがその前提に依存する。前提が崩れると firewall を flush でき、A1-* と B1-* の評価がそのまま崩れる。
* 認証情報を環境変数のまま渡す。実行中に本物を使用する業務では、B1 の「本物を配置しない」前提が崩れる。5 系統のうち mask も注入も持たないのはこの系統だけである。
* B2-X にコンテナ脱出の脆弱性クラスが残る。
* sumi の hooks は X が回避できる（系統 1 と同じ）。

#### その他の pros / cons

* pros
  * 参照実装があり、導入コストは小さい。
  * エディタの Dev Container 機能でそのまま起動できる。
* cons
  * firewall の中身が利用者の構成に依存し、`NET_ADMIN` が必要になる。
  * auto mode のソフト deny のたびに承認が発生する（系統 1 と同じ）。

### 系統 4: nas + auto mode（sumi は任意）

nas（nix-agent-sandbox）で Claude Code を `internal` ネットワークのコンテナに隔離し、唯一の出口である proxy が allowlist、シークレットの mask、ヘッダ注入を担う系統である。auto mode を審査に使用する。

#### 設定例

```pkl
// .nas/config.pkl
amends "modulepath:/global.pkl"

profiles {
  ["claude"] = (super["claude"]) {
    secrets {                 // ホスト側で読み取る。コンテナには渡らない
      ["github-token"] { from = "env:GH_TOKEN"; required = true }
      ["api-password"] { from = "dotenv:.env#API_PASSWORD" }
    }
    env {
      new { key = "GH_TOKEN"; val = "nas-injected" }   // gh に認証済みと認識させる偽値。ヘッダは proxy が上書きする
    }
    extraMounts {
      new { src = "/dev/null"; dst = ".env"; mode = "ro" }   // ワークスペースの .env をコンテナから隠す
    }
    mask = new MaskConfig {
      maskfs = false        // シークレットが git にコミットされている環境では使用できない
      proxy = true          // 全 upstream へのリクエストから登録済みシークレットを除去する
      filter = true         // Bash の stdout/stderr をマスクする
    }
    network {
      fallback = "deny"     // 出荷時の既定。allow しない送信先には経路がない
      // network.defaults.secrets は既定で ["*"] = "mask"。登録した全シークレットが mask 対象になる
      scopes {
        ["anthropic"] = (module.presets.anthropic.v1) { fallback = "deny" }
        ["github"] {
          targets { "github.com"; "api.github.com" }
          secrets { ["github-token"] = "inject" }
          inject {
            new Inject { name = "authorization"; value = #"template:Bearer ${github-token}"# }
          }
          rules { ["all"] { match { paths { "/**" } }; onMatch = "allow" } }
        }
        ["example-api"] {
          targets { "api.example.com" }
          secrets { ["api-password"] = "inject" }
          inject {
            new Inject { name = "x-api-key"; value = "secret:api-password" }
          }
          rules { ["all"] { match { paths { "/**" } }; onMatch = "allow" } }
        }
      }
    }
  }
}
```

```sh
nas config trust   # 設定を承認する
nas claude         # コンテナ内で Claude Code を起動する
```

`~/.ssh`、`~/.aws`、`~/.config/gh` は既定でマウントされないので、コンテナ内に存在しない。`gh auth token` は `env` で渡した偽値を印字する。実際の Authorization ヘッダは proxy が上書きして本物を注入する。

auto mode は Claude Code 側の設定で、系統 1 と同様に有効にする。

要求の各項目をどの設定が充足するかは次のとおりである。

* A1-*: `internal` ネットワークと proxy の allowlist が全プロセスの送信先を制限する。`fallback = "deny"` で allow しない送信先には経路がない。
* A2-Y: proxy が allow した全 upstream へのリクエストを検査し、登録済みシークレットを `****` に置換する。Anthropic への input も GitHub への push も同じ層が対象になる。Y は二重エンコードのような変形を伴わないので通過しない。
* A3-Y: proxy mask によりモデルが登録済みの値を知らないので書き写しは発生しない。`git add -A` は auto mode のソフト deny で承認に回す。
* B1-*: 本番の認証情報は `inject` で proxy がヘッダ注入し、コンテナ内に値を置かない。HTTP 以外の TCP は転送しないので本番 DB に到達できない。
* B2-Y: ホスト側で RW なのはワークスペースと `/nix`、`~/.cache/nix` に限定される。auto mode の破壊的操作ソフト deny が承認に回す。

sumi が任意なのは、proxy がエージェントとモデルの間に位置するからである。モデルへ渡る経路は必ず proxy を経由するので、どのツールで読んでも登録済みの値はマスクされる。sumi を追加すると変わるのは、値がコンテナ内に残留する範囲である。`filter` は Bash の stdout/stderr だけを対象にするので、Read ツールで読んだ値はエージェントプロセスとローカルの履歴に残る。sumi は Read と Grep も hook で対象にするので、そこまで限定できる。

#### 残存リスク

* 登録していないシークレットには proxy の mask が適用されない。
* 値がモデルを経由せず移動する経路（`git add -A`、`cp config/prod fixtures/`）は proxy を経由しないので、auto mode の分類器が唯一の層になる。`git push` の pack も検査できないので、誤コミットを proxy で阻止することはできない。
* mask は固定パターンの単一パス置換で、二重 base64 と hex は通過する（A2-X は ○）。
* 要求の範囲外だが、B2-X にはコンテナの hardening（`cap-drop`、`no-new-privileges`）が未実施であることと、DinD 併用時に `--privileged` サイドカーと network namespace を共有することが残る。

#### その他の pros / cons

* pros
  * sumi なしで A2-Y と A3-Y を単一の層で充足する。
  * 本番の認証情報の注入を、mask と同じ proxy 設定で記述できる。
* cons
  * 出荷時にはスコープが無いので、業務に必要な送信先を自分で列挙してプロファイルを整備する必要がある。導入コストは中。
  * proxy の `review` が実行前に承認を要求する。
  * hostexec を許可する範囲が広いと、隔離を迂回するホスト実行経路になる。`extraMounts` と `remoteForwards` を広く設定すると隔離が弱くなる。
  * auto mode のソフト deny のたびに承認が発生する（系統 1 と同じ）。

### 系統 5: Docker Sandbox + sumi + auto mode

Docker Sandbox（`sbx`）の microVM で Claude Code を隔離し、ホスト側 proxy が allowlist とシークレット注入を担う系統である。既定の起動コマンドは `claude --dangerously-skip-permissions` だが、これは既定値であって設計上の制約ではないので、起動コマンドを差し替えて auto mode を審査に使用する。A2 は sumi だけに依存する。

#### 設定例

```sh
sbx policy init deny-all                                      # 既定の Balanced プリセットは広いので、deny-all から allow を追加する
sbx policy allow network "api.anthropic.com,github.com,api.github.com,api.example.com"
sbx secret set anthropic                                      # proxy が api.anthropic.com への送信時に注入する。VM 内には番兵値だけを置く
sbx secret set github --command 'gh auth token'               # ホスト側の gh からトークンを取得して登録する
sbx secret set-custom --host api.example.com --env API_PASSWORD --value "$API_PASSWORD"   # experimental
sbx run --clone claude .                                      # ホスト側リポジトリには書き込まない。成果は git remote sandbox-<name> から取得する
```

既定の起動コマンドは `claude --dangerously-skip-permissions` である。`--` 以降の最初の引数がフラグなら既定フラグの後ろに追加され、bare word なら既定を置き換える。auto mode を確実に効かせるには sandbox kit の `sandbox.entrypoint` で起動コマンドを `claude --permission-mode auto --settings <path>` のように定義し、既定フラグ自体を外す。`-- --permission-mode auto` のように後ろへ追加した場合にどちらのフラグが優先されるかは未確認である。

VM はホストのホームディレクトリを見ないので、`~/.ssh`、`~/.aws`、`~/.config/gh` は VM 内に存在しない。`--clone` は git の内容だけを複製するので、追跡外の `.env` も VM に入らない。`API_PASSWORD` は `set-custom` で番兵値として環境変数に置き、proxy が `api.example.com` への送信時に置換する。VM 内で `gh auth token` を実行すると、GitHub 用の番兵値が印字される。

VM はホストの `~/.claude` を見ない。VM 内の `~/.claude/settings.json` と `~/.claude.json` は組み込み claude kit が管理するパスで、kit から上書きしないよう明記されているので、sumi の hooks と auto mode（`permissions.defaultMode: "auto"`、`autoMode.environment`）は `--settings` で渡す別ファイルか、ワークスペース側の `.claude/settings.json` に書く。`sumi` バイナリと secrets file は VM 内へ配置する。secrets file はプロジェクト外に置く前提なので、kit（`spec.yaml`）でイメージに含めるなどの対応が必要になる（未検証）。

要求の各項目をどの設定が充足するかは次のとおりである。

* A1-*: ホスト側 proxy の default deny allowlist が VM からの送信先を制限する。
* A2-Y: sumi がツール出力を墨消しする。Docker Sandbox 自体に A2 の機構はない。
* A3-Y: sumi によりモデルが値を知らないので書き写しは発生しない。`git add -A` は auto mode のソフト deny で承認に回す。
* B1-*: `sbx secret` の proxy 注入で VM 内に本物を配置しない。非 HTTP TCP もホスト単位で制御する。
* B2-Y: `--clone` でホスト側リポジトリへ書き込まず、ワークスペース自体の破壊もホストに及ばない。

#### 残存リスク

* 既定のまま `sbx run claude` で起動すると `--dangerously-skip-permissions` が付き、審査の層が消える。auto mode の成立は起動コマンドを差し替える運用に依存し、既定に戻せば A3-Y は sumi 単独になる。
* A2-Y は sumi 単独に依存する。sumi は hook 方式なので X には突破されるが、A2 の要求は Y だけなので満たす。
* direct mount では git hooks や `package.json` の scripts の改変がホストで後日実行される。`--clone` で回避する。
* SSH agent forwarding が既定で有効で、署名を要求できる。

#### その他の pros / cons

* pros
  * 隔離の境界がコンテナではなく VM である。
  * 認証情報はホスト側 proxy の注入方式で、注入が壊れたときは認証失敗に倒れる。
* cons
  * `~/.claude` をマウントせず、VM 内の `~/.claude/settings.json` は sandbox-managed なので、sumi の hooks、auto mode、skills、CLAUDE.md を `--settings` や kit で VM 内へ配置する手間が環境構築に追加される。導入コストは中。
  * 既定の起動コマンドを差し替えないと審査の層が消える。
  * auto mode のソフト deny のたびに承認が発生する（系統 1 と同じ）。
  * 既定の Balanced プリセットの広い wildcard を絞る作業が必要になる。
  * Linux では KVM が必要になる。Windows では WSL ではなく Windows Hypervisor Platform 上で動作する（Windows 11 が必要）。
  * `--clone` の成果はホストへ git 経由で取得する必要がある。

### 除外した組み合わせ

* `sandbox` 単独: A1-X が ○ にとどまり、要求の ◎ に達しない。本体の WebFetch と HTTP MCP が対象外だからで、`permissions` との併用で系統 1 になる。
* sumi 単独、permissions 単独、auto mode 単独: A1-X と B1-X が × で、Z にも適用されない。

### 比較

| 観点 | 系統 1: settings.json | 系統 2: srt | 系統 3: Dev Container | 系統 4: nas | 系統 5: Docker Sandbox |
| --- | --- | --- | --- | --- | --- |
| A1-*、B1-* の隔離層 | OS（bubblewrap / Seatbelt、Bash のみ）+ permissions | OS（bubblewrap） | Docker コンテナ + iptables | Docker コンテナ + `internal` ネットワーク | microVM |
| allowlist の強制点 | Bash は外側、本体ツールはプロセス内の permissions | エージェントの外側 | 同じ netns の内側 | エージェントの外側 | エージェントの外側 |
| A2-Y の手段 | `credentials` mask + `Read()` deny + sumi | `credentials` mask + `denyRead` + sumi | sumi のみ | proxy mask + `filter`（sumi 併用可） | sumi のみ |
| A3-Y の充足 | `credentials.files` + `Read()` deny + sumi + auto mode | `credentials.files` + `denyRead` + sumi + auto mode | auto mode + sumi | auto mode + proxy mask（sumi 併用可） | auto mode + sumi |
| 本番認証情報の扱い | 番兵値と proxy 置換 | 番兵値と proxy 置換（`credentials` mask。README 未記載、0.0.76 で動作確認） | 環境変数のまま（配置しない運用に依存） | proxy 注入（配置しない運用に依存） | proxy 注入 |
| 既知の欠陥 | Write / Edit が OS 強制の外。改竄耐性が managed settings に依存 | 番兵値は置換先へのボディでも本物に戻る | allowlist が root 昇格の前提に依存する | 未登録シークレットは mask 対象外 | 既定起動が `--dangerously-skip-permissions`。A2-Y が sumi 単独 |
| 導入コスト | 最小（Claude Code 単体） | 小 | 小（参照実装がある） | 中（プロファイル整備） | 中（設定の持ち込み） |
| 実装の提供元 | Anthropic + sumi（個人） | Anthropic + sumi（個人） | Anthropic 参照実装 + sumi（個人） | 個人（nas） | Docker + sumi（個人） |
| `gh auth token` の出力 | 番兵値 | 番兵値 | 本物（sumi が出力を墨消し） | 偽値（proxy がヘッダを上書き） | 番兵値 |

系統の選択は、残存リスクのどれを許容するかと、日常の作業にどれだけ手間が追加されるかの 2 点で決まる。まずリスクの側を比較する。

本番の認証情報を実行中に使う業務があるかで分かれる。ない場合は系統 1、2、3 が候補になり、いずれも導入コストが小さい。ある場合、系統 3 は認証情報を環境変数のまま渡すので B1 の前提が崩れ、番兵値と proxy 置換を備える系統 1、2、4、5 が候補になる。

系統 1 と系統 2 の差は、OS 強制の対象範囲である。系統 1 は Bash だけをカーネルが制限し、Write / Edit / WebFetch はプロセス内の permissions が制限するので、本体側の経路は設定の改竄耐性に依存し、managed settings への配置が前提になる。系統 2 は Claude Code 本体を含む全プロセスをカーネルが制限する。mask のエンジンは同一なので番兵値方式の性質は同じで、差は強制点の範囲と、srt の `credentials` が README 未記載である点に集約される。

系統 2 と系統 3 の差は、allowlist をどこで強制するかである。系統 3 だけが強制点をエージェントと同じ netns に置くので、コンテナ内で root へ昇格できないという前提に A1-* と B1-* が依存する。系統 2 はカーネルが sandbox 化したプロセスに対して強制するので、その前提が要らない。

系統 4 と系統 5 の差は A2 の厚みと隔離の境界である。系統 4 は proxy が Anthropic への input を含む全 upstream のボディを検査して mask するのに対し、系統 5 の proxy は注入だけで送信内容を見ないので、A2-Y は sumi 単独に依存する。A3-Y はどちらも auto mode を重ねられるが、系統 5 は既定の起動コマンドを差し替える運用が前提になる。一方、隔離の境界は系統 5 が VM で系統 4 がコンテナであり、要求の範囲外の B2-X では系統 5 が厚い。

手間の側では、5 系統に共通する分と系統ごとに異なる分がある。共通するのは allowlist の運用で、業務に必要な送信先を最初に列挙する作業と、新しい送信先が必要になるたびに追加する作業はどの系統でも発生する。

系統ごとの差は、隔離層よりも追加する層の側で発生する。auto mode を追加する 5 系統すべてで、ソフト deny のたびに承認が発生する。読取拒否を持つ系統 1、2 は、拒否したファイルを実行に使用する場面で作業が停止する。系統 5 は `~/.claude` を持ち込めないので、auto mode と sumi の設定を `--settings` や kit で配置する手間が最初に加わる。個別の手間は各系統の cons に記した。

### 付録: 各対策の補足

各系統の節で述べた判断の根拠を、対策ごとに記す。既知の回避経路も対策ごとに列挙する。読む必要はない。

* settings.json `permissions`: コマンド、パス、ドメインのパターンで許可・拒否・確認を決める。公式ドキュメント自身が Bash パターンは security boundary ではないと明記しており、絶対パス、サブシェル、`git -C . push` のような書き換えで回避できる。送信側で A2 に届かないのは、permissions が送信先を選ぶ仕組みであって送信内容を見ないからである。A2 は業務上許可した送信先に秘密が混ざる問題なので、送信先の指定では分離できない。読取側の `Read(./secrets/**)` の deny は Read ツールに加えて `cat`、`head`、`tail`、`sed`、`tee` とリダイレクト先にも適用されるので、列挙したパスについては Y の典型経路（設定ファイルを読んで混入）を止める。ただしコマンド単位の個別対応なので、対象外のコマンドやスクリプト経由の読み取り、ログ出力への混入で通過し、A2-Y は ○ にとどまる。
* settings.json `sandbox`: 対象は Bash とその子プロセス（stdio の MCP サーバーを含む）だけで、Claude Code 本体はホスト上で利用者の権限のまま実行される。本体の Write / Edit / WebFetch と HTTP の MCP サーバーからの書き込みと送信は permissions の管轄に戻るので、sandbox 単独では境界が成立しない。`credentials.envVars` と `credentials.files` の mask は Bash コマンドに番兵値を提示し、`injectHosts` に列挙したホストへの送信時だけ proxy が本物に置換する（`network.tlsTerminate` が必要）。初期化に失敗した場合は既定で非 sandbox 実行に fallback し、mask も消える。`failIfUnavailable` と `allowUnsandboxedCommands: false` の両方を指定すると fail-closed になる。回避経路は allowlist の広さに集約され、`github.com` のような広いドメインを許可するとそこ経由で持ち出せる。`credentials.files` はパスと `extract` 正規表現を列挙する方式で、グループ 1 に一致した範囲だけを置き換える。ディレクトリ、glob、8 MiB 超、非 UTF-8 のファイルは mask できず deny に落ちるので、そのファイルを読むビルドは止まる。Linux と WSL2 でのみ働き、macOS では読み取り禁止になる。permissions と併用する場合、bare の `WebFetch` deny はツール自体を除去し、`WebFetch(domain:*)` の deny は sandbox 側の全ホストも拒否する。`mask` entry、`network.tlsTerminate`、`credentials.allowPlaintextInject` はユーザー設定、managed settings、`--settings` からのみ有効で、リポジトリ側の `.claude/settings.json` と `.claude/settings.local.json` では無視される。managed settings が `sandbox.filesystem` を設定すると、他の階層は `filesystem.disabled` を変更できない。`Read()` deny は Read ツールと、`cat` 等の認識されるコマンドとリダイレクト先に適用され、Grep と Glob には best-effort で適用される。
* Anthropic srt: `settings.json` の `sandbox` と同じエンジンだが、Claude Code 本体を丸ごと内包するので Write / Edit / WebFetch、HTTP の MCP サーバーへの通信、stdio の MCP サーバーもすべて対象になる。Linux では network namespace を除去して Unix socket 経由の proxy だけを bind-mount する。A2 は `filesystem.denyRead` に列挙したパスについて Read ツールにも Bash にも適用されるが、deny なのでそのファイルを実行に使う場面では作業が停止する。列挙したパスは git からも読めなくなるので commit も止まり、その範囲では A3 にも効く。系統 2 の A3-Y の項はこれを数えている。README が記述する機能は deny までだが、認証情報の扱いは、パッケージをライブラリとして使う場合と CLI として使う場合で分けて考える。ライブラリ側には `credentials.envVars` と `credentials.files`（`mode: deny | mask`、`extract`、`injectHosts`）、`allowPlaintextInject` の設定と、番兵値を sandbox 内に置いて proxy が許可先への送信時に本物へ置換する実装があり、Claude Code の `$.sandbox` の mask はこれを呼んでいる。CLI 側は `~/.srt-settings.json` を同じ schema で読み、`credentials` を含む設定をそのまま `SandboxManager.initialize` に渡す。0.0.76 の CLI で Linux ホスト上で確認した挙動は次のとおりである。`mode: mask` の環境変数は sandbox 内で `fake_value_<uuid>` になり、`network.tlsTerminate` を有効にした HTTPS の許可先では Authorization ヘッダの番兵値が本物に置換され、平文 HTTP では番兵値のまま届く（`allowPlaintextInject` の既定は false）。`injectHosts` を別ドメインに絞ると、許可先であっても番兵値のまま届く。`credentials.files` に登録したファイルは `cat` も `cp` も `extract` のグループ 1 を番兵値にした内容を返し、そのファイルを POST ボディで許可先へ送ると本物に置換される。`injectHosts` を省略した場合の既定は allow した全ドメインなので、認証情報ごとに宛先を絞る必要がある。README が列挙する既知の回避経路は、`github.com` のような広いドメイン許可、domain fronting、`allowUnixSockets` で Docker socket を渡した場合のホスト到達、親から継承した fd 経由の Unix socket、`enableWeakerNestedSandbox` を有効にした構成である。
* srt の内側で `$.sandbox` の `credentials` mask を併用する構成: srt の README に認証情報の mask が見当たらなかったため、Claude Code 側の mask を内側で使えるかを検証した（srt 1.0.0、Claude Code 2.1.270、Linux）。その後 srt 自体の `credentials` 設定が CLI で働くことを確認したので、この入れ子は不要になった。記録として残す。bubblewrap の入れ子自体は srt の既定設定で起動でき、`enableWeakerNestedSandbox` は不要である。阻害要因は srt の seccomp フィルタで、`AF_UNIX` socket の作成を EPERM で遮断するため、内側の sandbox proxy が Unix socket を listen できず初期化に失敗する。srt に `network.allowAllUnixSockets: true` を設定すると内側の sandbox が初期化され、Bash コマンドには番兵値が提示される。ただしこの設定は README が Docker socket 経由のホスト到達を回避経路として挙げるもので、外側の srt の隔離を弱める。内側の sandbox は初期化失敗時に既定では fail-open で、「Sandboxing is disabled for the rest of this session」として以降の Bash を非 sandbox で実行し、本物の環境変数が渡る。`failIfUnavailable: true` と `allowUnsandboxedCommands: false` の両方を指定した場合に限り Bash 自体が実行不能になり fail-closed になる。片方だけでは、前者は escape hatch による再実行で、後者はセッション単位の無効化で、いずれも非 sandbox 実行に至る。非 sandbox 実行は通常の permission モードでは permission 審査に回るが、`--dangerously-skip-permissions` や auto mode の許可で通過する。結論として、併用は成立するものの外側の隔離を弱めるので、認証情報を deny で足りるなら `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` で全サブプロセスから除去するほうが安全である。
* auto mode: 分類器の判定である。ハード deny は分類器が危険と判定した時点で実行を拒否し、ソフト deny は利用者の承認に回す。組み込みのハード deny はデータ持ち出しの 1 件だけで、シークレットのコミット、本番デプロイ、force push、`curl | bash`、auto mode 自体の回避はいずれもソフト deny である。ソフト deny の到達点は人の承認なので、表では manual approve と同じ ○ に揃えている。「auto mode 自体の回避」をソフト deny に含めている点で X は意識されている。分類器はユーザーメッセージ、読み取り以外のツール呼び出し、`CLAUDE.md` を見るが、ツール結果は除去される。送信先を `autoMode.environment` に登録しないと誤検知も多い。A2 のうち Anthropic への input はツール呼び出しではないので審査に回らず、`git push` や API 呼び出しのような明示的な送信だけが対象になる。
* manual approve: 件数が増えると承認疲れで形骸化する。A2 のうち Anthropic への input は承認の対象にならず、Read の承認も実行前に行われるので、読んだ内容にシークレットが含まれるかは判断できない。
* Dev Container: A1 と B1 は `init-firewall.sh` 相当の iptables allowlist を前提とする。iptables の allowlist なので OS が強制するが、他の隔離層と違って強制点がエージェントと同じ netns の中にある。srt はカーネルが sandbox 化したプロセスに対して、nas は Docker の `internal` ネットワークが、Docker Sandbox はホスト側 proxy が、いずれもエージェントの制御範囲の外側で強制する。Dev Container で X に対して allowlist が成立するのは、エージェントがコンテナ内で root へ昇格できないことを前提とする。iptables の操作には root か `CAP_NET_ADMIN` が要り、権限はプロセス単位なので、非 root のエージェントが昇格できなければルールに触れない。この前提が崩れると firewall を flush できるので、A1 と B1 の評価はそのまま崩れる。参照実装の sudoers は `node` に `init-firewall.sh` の再実行だけを NOPASSWD で許し、汎用の root シェルへの経路は置いていない。`NET_ADMIN` は初期化に必要で、firewall を無効にした構成では隔離そのものが消える。設定ミスも残存する。設定時の注意として、上流の参照実装は HTTPS 系の宛先を allowlist にする一方で 22/tcp と 53/udp を全宛先に許可しているので、そのまま使うと SSH、scp、DNS による持ち出しと 22 番の本番サーバへの到達が allowlist の外に残る。系統 3 の A1-* と B1-* の充足はこの 2 つを閉じた構成を前提にしている。A2 はコンテナ内に配置した認証情報をエージェントが読め、送信内容の検査機能もないので防御が成立しない。
* Docker Sandbox: 外向き TCP はすべてホスト側 proxy を経由し、allowlist にないものは default deny。HTTPS は既定の経路（credential proxy 経由）で proxy が TLS 終端し、SSH などの非 HTTP TCP もホスト単位で制御、UDP と ICMP は遮断。API キーを `sbx secret` に登録すると proxy が番兵値を本物に置換し、VM 内の環境変数には `proxy-managed` のような番兵値しか置かない。置換はリクエスト中に番兵値が現れた箇所すべてに掛かる。A2 はワークスペース内のシークレットをそのまま送るので防御が成立せず、本物の値を検知して除去する機能はない。既定の起動コマンドは `claude --dangerously-skip-permissions` だが、`--` 以降の最初の引数が bare word なら既定を置き換え、sandbox kit の `sandbox.entrypoint` でも起動コマンドを定義できるので、auto mode の併用は成立する（公式ドキュメント自身が auto mode の使用を案内している）。VM 内の `~/.claude/settings.json` と `~/.claude.json` は組み込み kit が管理するパスで、追加設定は `--settings` の別レイヤで渡す。ワークスペースの渡し方には、ホストのディレクトリをそのまま見せる direct mount と、複製を渡す `--clone` がある。残存するのは、既定の Balanced プリセットの allowlist が広いこと、SSH agent forwarding が既定で有効で署名を要求できること、direct mount 時に git hooks や `package.json` の scripts を改変してホストで後日実行させられることである。
* sumi: Read / Grep / Bash の出力からシークレットを墨消しする。モデルが値を知らなくなるので、値を書き写す経路（A1 の一部、A2、A3）を塞ぐ。Bash が `curl -d @.env` のようにファイルを直接渡す経路は、モデルに値を提示しないまま送信できるので残る。README が回避手段を列挙しており、hook の無効化、二重 base64 などのエンコード、`settings.json` の編集、`CLAUDE.md` 経由の読み込みがある。シークレット一覧ファイル自体も sandbox 内から `xxd` 等で読める（`docs/todo/sumi.md`）。X に対して成立しないのはこのためである。付属の `sumi scan` はワークスペースを走査して `$.sandbox` の `credentials.files` に登録する機能だが、走査から除くのは `.git` ディレクトリ、シンボリックリンク、secrets ファイル自体だけで、git 追跡下のファイルは除かない。コミット済みの秘密を含む追跡ファイルを登録すると、読み取りが番兵値を返して index と食い違うため、ワークツリーが常に dirty に見えるはずである（未検証）。nas の `maskfs` を切っているのと同じ理由が当てはまる。
* nas: コンテナは `internal` ネットワークにいて経路が存在せず、唯一の出口である proxy が allowlist と、実行前に利用者へ承認を求める `review` で制御する。出荷時のテンプレートにはスコープが 1 つもなく `fallback` は `deny` なので、業務に必要な送信先を利用者が足していく形になる。本番の認証情報は proxy がヘッダ注入するので、コンテナ内に値は置かれない。ただし proxy が注入する接続先には、エージェントが値を知らないまま認証済みで到達できる。HTTP 以外の TCP は転送しない。proxy は allow した全 upstream へのリクエストについて URL・ヘッダ・ボディを検査し、登録済みシークレットが生値、URL エンコード、base64（標準と URL-safe）のいずれかで現れたら `mask`（`****` に置換）または `forbid`（403 で拒否）を適用する。検知は固定パターンの単一パス置換で、再帰的な復号はしないため、二重 base64 と hex は通過する。8 文字未満の短い値には base64 の検知が働かない。展開できない Content-Encoding のボディは 403 で拒否する。`forbid` は `network.defaults`、スコープ、ルールの 3 段で設定でき、既定は全件 `mask` である。proxy とは別に、`mask.filter`（既定 true）が bash をラッパーに差し替え、全コマンドの stdout/stderr をホスト側のマスクデーモンへ中継して登録済みシークレットをマスクする。中継先に接続できないときは bash の起動自体を拒否する。これは sumi の Bash 出力マスクと同じ層だが、対象は Bash の出力だけで、エージェントが Read ツールで直接読む経路には掛からない。ただしモデルが何を知るかには影響しない。エージェントはコンテナ内でモデルは proxy の向こうなので、Read の出力もモデルへ届く前に proxy mask を通る。`filter` が狭めるのは、値がコンテナ内とローカルの履歴に留まる範囲である。ワークスペースを FUSE で覆う `maskfs`（既定 true）は Read 経路もそこに含められるが、シークレットが git にコミットされている環境ではマスク後の内容が index と食い違ってワークツリーが常に dirty に見えるため使えない。ホスト側の RW マウントは、ワークスペース、`/nix`、`~/.cache/nix` と nas 自身のセッション用ディレクトリで、`~/.config/gcloud` や `~/.aws` は opt-in である。既知の欠陥は、コンテナ側で `cap-drop` や `no-new-privileges` などの hardening が未実施であること、ホストのコマンドを条件付きで実行させる hostexec の `argRegex` が未アンカーであること（`docs/todo/security.md` M8）である。
* nas の運用上の注意: 「コンテナ内には偽値しか配置しない」は機構ではなく設定の書き方で担保される。nas は環境変数の値を検証しないので、利用者が本物を書けば本物が入る。`network.remoteForwards` を設定すると proxy を通らないホスト TCP 経路ができる（コンテナ側から自発的に増やす手段はない）。`extraMounts` で RW にしたディレクトリもホスト側の書き込み範囲に加わる。Docker を使う開発では `--privileged` の DinD サイドカーが同居し、エージェントがその network namespace を共有するので、B2-X の境界はサイドカーの分だけ弱くなる。


