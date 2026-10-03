# コーディングエージェントのセキュリティ対策の選定

Claude Code に開発作業を任せる際、どの被害を隔離境界で防ぎ、どの被害を復旧・審査で引き受けるかを決めるために、5つの構成を比較する。

## 脅威モデルと要求水準の決め方

### 敵対的な操作と過失を分ける

**X: 敵対的な操作**では、エージェントまたは隔離環境内のプロセスが、実行できるコマンド、読み書きできるファイル、接続できるサービスを使い、制限を回避する操作も試みると仮定する。直接・間接のプロンプトインジェクション、悪意のある／侵害された MCP server や依存パッケージ、エージェント自身の制約回避を含む。隔離環境内のプログラムが攻撃者の用意した認証情報を使う操作や、エージェントの判断を介さずに直接攻撃する場合も対象となる。

**Y: 非敵対的な過失**では、エージェントは利用者の意図に従おうとするが、コマンド・引数の誤り、パスや環境の取り違え、文脈の誤認識によって誤動作すると仮定する。

Claude Code の auto mode は、実行予定の操作を classifier で審査する。この審査は過失を減らす対策として評価する。敵対的な操作への防御には、エージェントが迂回できない実行制限を要求する。隔離機構、制限を管理する仕組み、人間の承認を受け付ける仕組みは信頼する。

### 被害ごとに求める防御の水準

防御水準は、開発のために変更・利用を許した範囲を基準に決める。エージェントには、作業対象のソースやテスト、履歴・memory の更新と、指定した連携先との通信を許可する。

**その権限を使って、変更を許していないホスト設定や hook を書き換えること、許可していない相手へ情報を送ること、本番を変更することは、敵対的な操作でも阻止する。** これらは、開発のために任せた範囲を越え、別の実行環境や相手に影響するためである。ホスト設定をバックアップから戻せる場合も、この要求は同じである。情報流出や本番変更には、作業ファイルを復旧しても被害を取り消せないという事情もある。

編集を許した作業ファイルや履歴・memory では、その権限を悪用した改変が残る。ここでは、開発に必要な編集を保ちながら、過失による被害を減らすことを求める。悪意ある変更を加えられることは、これらのデータを編集可能にする以上、残るリスクとして扱う。

通信についても、相手への接続許可と、送ってよい情報の範囲を分ける。許可していない相手への送信は敵対的な操作でも阻止する。一方、許可した相手への不要な秘密の送信や、作業ファイルへの秘密の保存については、過失による被害を減らすことを求める。

## 被害と必要な防御

被害ごとに、敵対的な操作も阻止することを求めるか、過失による被害を減らすことを求めるかを示す。

| 被害 | 何を防ぐか | 求める防御水準 |
| --- | --- | --- |
| **A1a: 未許可送信先への流出** | 攻撃者のサーバなど、接続を許可していない相手へソースコード・環境情報・シークレットを送ること | X 敵対的な操作による被害も阻止する |
| **A1b: 許可済みサービス内で、共有を許可していない相手への流出** | GitHub 等の公開 repo、攻撃者管理 repo、同じ organization 内でも共有を許可していない repo・team 等への送信 | X 敵対的な操作による被害も阻止する |
| **A2: 正規連携先への不要な送信** | LLM プロバイダや共有を許可した非公開 repo に不要な secret まで送ること | Y 過失による被害を減らす |
| **A3: 意図しないローカル保存** | `.env` の commit、token の埋め込み、secret を含む API response のログ保存等 | Y 過失による被害を減らす |
| **B1: 本番変更・公開・権限の変更** | 本番 DB の変更やデプロイ、メール送信、repo の公開範囲・権限・branch protection の変更、deploy key・webhook・App・secret・environment の設定変更、token の発行、package・container・release の公開。エージェントが変更した成果物を、強い権限を持つ CI やサービスが実行する場合も含む | X 敵対的な操作による被害も阻止する |
| **B2a: ホストのファイルや実行設定の破壊・改変** | 変更を許可していないホストファイルの改変。作業領域内でも、ホストが使う既存の設定・hook・plugin・skill・script とその参照先を含む | X 敵対的な操作による被害も阻止する |
| **B2b: 作業ファイル・履歴・memory の破壊・汚染** | 誤ったコマンドによるファイルや Git 履歴の削除、誤った一括置換や上書き、force push による履歴の消失、テストの誤った無効化・削除 | Y 過失による被害を減らす |

A1b は、送信先のアカウントや repo に情報を渡してよいかを扱う。A2 は、正規の相手に送る情報の内容を扱う。サービスへの接続を許可したうえで、共有先と情報の範囲をそれぞれ定める。fine-grained token の権限制限は、その token を使う操作に適用される。A1b では、隔離環境内のプログラムが攻撃者の用意した別の token を使い、攻撃者の repo などへ情報を書き込めるかも確認する。

一つの操作が複数の被害につながることもある。CI workflow への悪意ある変更は B2b、その自動実行で本番が変わる被害は B1 として評価する。履歴や memory への悪意ある書込みも B2b に含め、その内容を読んだ次のエージェントによる情報流出や本番変更は、それぞれ A1・A2 や B1 で評価する。

### ホスト・作業領域・履歴への被害の違い

B2a と B2b は、ファイルの置き場所ではなく、開発のために変更を許可した対象かどうかで分ける。

B2a は、変更を許可していないホストファイルや既存の実行設定への被害を扱う。作業領域内の `.git/config` や hook も、ホストでの実行を左右する既存設定として保護する場合はこちらに含む。設定が読み込むスクリプト等も同じ扱いとする。

B2b は、開発のために編集を許可したソースやテスト、repo への被害を扱う。ホストと共有する作業領域でも、この区別は変わらない。エージェントが新しく作った repo や設定は作業成果物として扱い、ホストで採用する前にレビューする。

履歴や memory も、書込みを許可し、後の作業で再利用するデータなので B2b に含める。コンテナや VM 内に保存していても、次の実行で読めば改変の影響を引き継ぐ。保存先の分離で防げるのは別の保存先への書込みであり、再利用する内容自体の改変ではない。

より強い権限を持つエージェントが、改変された作業ファイルや memory を読むと、被害が広がる可能性がある。これは保存場所にかかわらず、成果物や履歴を別の環境で利用するときの条件として扱う。

## 予防的要求 P1: 未信頼情報源の無人取り込みを減らす

P1 は、プロンプトインジェクション等で X が生じる機会を減らす予防的な要求である。信頼済み情報源だけを自動取得し、それ以外は人間承認または拒否とするのが目標となる。最低水準として、classifier が情報の取得元を審査する構成を認める。さらに proxy 等が通信を検査して未許可の取得を止める構成では、その制限が働く範囲を示す。

信頼済みとは、内容を自動的にエージェントへ渡してよいと事前に定めた情報源を指す。repo なら公開範囲に加え、誰が書き込めるかで判断する。第三者 repo、Web、外部ユーザーが投稿できる Issue・PR・comment、外部 package 等は未信頼であり得る。取得後にローカルへ保存した内容も、取得元の信頼性に従って扱う。

GitHub への接続を許可した後も、情報源は repo や投稿者ごとに選ぶ。A1b が送信先を絞るのに対し、P1 は取得元を絞る。そのために、要求先のアカウントや repo、API の URL、読み書きの操作、GraphQL の要求本文を検査する。

制限を越える操作をその場で拒否する構成と、人間が承認するまで止める構成は、同じ防御水準として評価する。後者では、人間が対象と操作を確認して許可することで、エージェントに任せられる作業を増やせる。承認処理をエージェントから保護し、承認が届くまで実行を止めることを条件とする。

P1 達成後も **X を仮定し、A/B の被害防止は独立に評価する**。

## 比較結果と構成ごとの条件

### 評価記号の読み方

- **◎**: X を仮定しても、隔離機構やサービスの権限設定が対象の操作を阻止する。人間の承認を使う場合は、承認が届くまで必ず実行を止める。
- **○**: 一般的な過失や、よくある方法による被害を防ぐか減らす。敵対的なプログラムは制限を回避できる場合がある。
- **×**: 想定した被害を防ぐ対策を提示構成に含めていない。

### 被害防止と予防の比較

B1 は方式毎で差が出ないため、共通する[導入条件](#本番変更公開権限変更への対策)として扱い、この表の採点対象から外す。

後述する比較条件の元で、

| 要求 | 必要水準 | 系統1 settings | 系統2 srt | 系統3 Dev Container | 系統4 nas | 系統5 Docker Sandbox |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A1a: 未許可送信先への流出 | ◎ | ◎ | ◎ | ○ | ◎ | ◎ |
| A1b: 許可済みサービス内で、共有を許可していない相手への流出 | ◎ | ○ | ○ | ○ | ◎ | ○ |
| B2a: ホストのファイルや実行設定の破壊・改変 | ◎ | ○ | ◎ | ○ | ◎‡ | ◎ |
| A2-Y: 正規連携先への不要な secret 混入 | ○以上 | ○ | ○ | ○ | ○ | ○ |
| A3-Y: secret の意図しない保存 | ○以上 | ○ | ○ | ○ | ○ | ○ |
| B2b-Y: 作業ファイル・履歴・memory の破壊・汚染 | ○以上 | ○ | ○ | ○ | ○ | ○ |

`‡` nas の B2a は、既存設定を保護対象のパスに置くことが条件となる。履歴や memory のように書込みを許可するデータへの被害は B2b で評価する。

| 予防的要求 | 必要水準 | 系統1 | 系統2 | 系統3 | 系統4 | 系統5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| P1: 未信頼情報源の無人取り込み低減 | ○以上 | ○ | ○ | ○ | ◎（GitHub の指定経路） | ○ |

系統1〜3では、隔離環境内のプログラムが攻撃者の token を使い、接続を許可したサービス上の攻撃者の repo などへ情報を書き込める。系統2は srt の検査関数を組み込んでも、SOCKS 等の経路で検査を[迂回できる](experiments/srt-filter-bypass/README.md)。系統5でも、proxy による認証情報の上書きを通らず、プログラムが指定した token を GitHub に[送れる](experiments/sbx-a1b/README.md)。いずれも提示構成は ○ とし、必要な追加制御を各方式の節で示す。

### 選定時に残る条件と負担

| 構成 | 保護範囲と成立条件・負担 |
| --- | --- |
| **系統1: settings.json** | Bash を内蔵 sandbox で隔離する。履歴・memory は専用の保存先に分ける。本体によるその他のホストファイルへの書込みには追加の対策が必要。読み込まれる設定ファイルをすべて書込み禁止の対象にする |
| **系統2: srt** | 本体を含め OS sandbox で隔離する。A1b・P1 のためにサービス内の読み書き先を制限するには、srt の変更が必要になる。srt 0.0.77 の検査関数 `filterRequest` は SOCKS 等の経路で迂回できる |
| **系統3: Dev Container** | 既存 container 運用に載せやすい。DNS の問合せを使った情報送信を防ぎ、共有作業領域にある設定や hook への書込みを制限する追加対策が必要 |
| **系統4: nas** | 提示条件では A1a・A1b・B2a と GitHub の P1 を強制する。API ごとに許可する操作を設定・保守し、ホストと共有する設定を保護する必要がある。履歴や memory はホストと共有する |
| **系統5: Docker Sandbox** | VM 内の専用 clone で作業し、ホストの作業ツリーを保護する。提示した v2 構成には A1b の対策が必要。v3 の HTTP 制限を使う構成は今後の検証候補 |

nas の proxy は、サービス内のどの repo 等を読み書きできるかを制限する。履歴や memory はホストと共有する。この組合せを受け入れられるかが選定上の判断となる。

## 比較の共通条件

### 通信先・権限・信頼済み情報源

必要な通信先は Anthropic API の `api.anthropic.com`、GitHub の `github.com`・`api.github.com`、業務 API の開発環境 `devapi.example.com` とする。GitHub では `gh` による REST / GraphQL の取得・更新、Git の clone / fetch / push、Issue / PR / comment の参照を行う。

情報共有先は自組織の非公開 repo `my-org/private-repo` に限定する。そこへ書き込める人・bot・GitHub App 等が提供する内容を、自動取得してよいものとして扱う。これを P1 の信頼済み情報源とする。同じ organization 内でも指定外の repo・team は共有先として許可しない。公開 repo と他 owner の repo は未信頼とする。信頼済み repo に外部投稿者や未審査の内容を取り込む場合は、この P1 の前提を見直す。

利用者が与える権限は、全系統で次のように限定する。

- GitHub は fine-grained token 等を使い、resource owner を自組織、repository を必要な対象、permission を必要最小限に限定する。SSH の鍵や、より広い権限を持つ GitHub の認証情報は渡さない。
- 業務 API は開発環境だけを使い、本番 API や DB の認証情報は渡さない。

  `devapi.example.com` は比較用の架空の API で、次の仕様を前提とする。認証は `x-api-key` のみで行い、header の重複は拒否する。他の header・query・body による認証や認証主体の切替は提供しない。有効な key は自組織の開発環境にだけアクセスでき、第三者のアカウント・保存先や外部への転送機能は持たない。これは比較条件であり、実在 API の検証結果ではない。

fine-grained token の scope はその token を使った操作だけを制限する。隔離環境内のプログラムが攻撃者の用意した別の token を使えば、その token の権限で第三者の repo へ書き込める。また、公開 repo の read 権限は残るため P1 の取得制限にもならない。

この違いは Anthropic API にも当てはまる。Files API のファイルは認証した workspace に属し、同じ workspace の別 key からも参照できる。したがって、許可した `api.anthropic.com` に攻撃者の key でアップロードできれば、攻撃者の workspace に情報が保存される。利用者の認証情報を proxy が付ける機能に加え、攻撃者のアカウントで通信する操作や、許可していない API への接続を拒否できるかも評価する。

### 本番変更・公開・権限変更への対策

B1 の本番変更・公開・権限変更は、重要な防御対象である。ただし、例えば Git push を受けた CI が本番を変更できるかは、主に CI に与えた権限と承認手続きで決まり、エージェントの隔離方式だけでは決まらない。

そのため、B1 は系統別の評価から外し、全方式に共通する導入条件として扱う。CI の権限を開発用途に限定するか、本番変更や公開につながる操作に人間の承認を必須とする。CI を起動する操作を承認対象にする場合は、Git push に加え、API によるブランチ更新や workflow の実行も含める。承認手続きは、エージェントが編集する workflow 等から変更できない場所で管理する。

各方式がその操作をどこまで細かく制限できるかは、開発作業への支障や承認の負担として比較する。

### 操作審査とモデル入力

全系統で [Claude Code auto mode](https://code.claude.com/docs/ja/auto-mode-config) と必要に応じた手動承認を使う。管理者が配布する設定（managed settings）で、許可済みのものも含めて全 shell コマンドを classifier の審査対象にする。`hard_deny` には、信頼済み repo 以外へのアクセスを、読取りも含めて拒否するよう記述する。これは自然言語のルールであり、強制境界ではないため P1 は ○ とする。[ルール設定](https://code.claude.com/docs/en/auto-mode-config#override-the-block-and-allow-rules)

WebSearch はツール自体を除去する。検索は Anthropic API 側で実行され、ページ内容の要約を含む結果が `api.anthropic.com` の応答としてモデルに届く。network allowlist や proxy では取得元を判定できず、未信頼の Web ページの内容が P1 の制限を経ずに取り込まれる。AI 検索の結果に仕込んだ指示で利用者の質問1回からエージェントを乗っ取れることは、ChatGPT の検索機能で[実証されている](https://www.tenable.com/blog/hackedgpt-novel-ai-vulnerabilities-open-the-door-for-private-data-leakage)。

手動承認の増加で確認が形骸化する可能性がある。審査精度・負担の比較実測はしておらず、強制的に承認を待つ機構と、承認判断の正しさは区別する。具体的な設定は[共通設定](threat-model-configurations.md#共通設定)に示す。

### シークレットと作業領域

シークレットは、作業でどう使うかによって扱いを分ける。

| 作業での必要性 | 扱い | 対応する構成 |
| --- | --- | --- |
| 作業に不要 | ファイルを `/dev/null` で覆う、共有対象から外す、読取りを拒否するなどして、内容を見せない | 全系統 |
| 作業に本物の値が必要 | HTTP(S) の認証なら、エージェントにはダミーを渡し、proxy が送信時に本物を付ける。この方法を「代理注入」と呼ぶ | srt・nas・Docker Sandbox。settings.json の内蔵 sandbox でも、Bash の通信に利用する |
| ファイルや設定項目は作業に必要だが、値はダミーでよい | ファイル等の形を保ち、秘密の値だけをマスクする | srt の mask、nas の mask。settings.json の内蔵 sandbox では Bash 側に適用する |

本物の値を HTTP(S) 以外の処理に渡す必要がある場合は、今回の構成では、処理を実行しながらその値をエージェントから隠すことを諦める。ダミーで動く作業と、本物を必要とする作業を区別する。

比較例では、GitHub 用の `GH_TOKEN` と業務 API 用の `API_PASSWORD` は HTTP(S) 通信で本物が必要な値として扱う。作業に不要な `~/.ssh`、`~/.aws`、`~/.config/gh/hosts.yml` は内容を見せない。ツールの出力にも秘密の値が含まれる場合は、[sumi](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/contrib/sumi/README.md) でモデルに渡す前にマスクする。

#### Git が管理するファイルの差分

上の分類とは別に、Git が管理するファイルには差分への対策が必要になる。作業ファイルを空にしたりダミーへ置き換えたりしても、index に本物が残っていれば、`git diff` の削除側にその値が表示される。

対象ファイルをエージェントの編集対象から外し、通常の変更検出を抑える方法として、起動前に `git update-index --assume-unchanged -- <対象ファイル>` を設定する。ただし、このフラグは変更の検査を省くためのもので、Git が保存する値を隠す機能ではない。Git の公式文書も、操作によっては変更が検出されると説明している。[git update-index](https://git-scm.com/docs/git-update-index#_notes)

index や履歴に本物を含む場合は、`git show` や `git diff --cached` 等の出力もマスクする。エージェントから本物を読めない構成にするには、渡す Git 履歴にも本物を含めない。`assume-unchanged` は、通常の作業で差分に値を出さないための補助として扱う。

#### 作業領域

エージェントは作業領域内を読み書きする。各環境で `.local/tmp` を作って Git 管理から除外し、作業領域を起点に起動する。[CLAUDE_CODE_TMPDIR](https://code.claude.com/docs/en/env-vars) は `.local/tmp` とするが、書込み範囲は各隔離機構で制限する。系統1・2は sandbox の読取・書込拒否と Unix socket 制限を併用し、系統3〜5にはホストの `/tmp` や操作用 socket を mount・転送しない。

作業領域のパスは symlink を経由しない。既存 hook の実体は作業領域の `.git/hooks`・`.claude` またはホストの `~/.claude` 配下に置く。

## 各方式の評価理由と成立条件

以下では、隔離範囲、許可先サービス内の制限、secret の扱い、P1 の違いを示す。B2b-Y は全系統で共通条件の auto mode を使い、`rm -rf`、`git reset --hard`、force push 等の破壊的な操作を審査して誤操作を減らす。履歴や memory への書込みも B2b に含める。系統ごとに追加の対策がある場合だけ、各節に記す。

### 系統1: settings.json

Claude Code 本体はホストで動かし、内蔵 sandbox で Bash と子プロセスを隔離する。本体側の Read / Write / Edit 等には `permissions` を適用する。[設定例](threat-model-configurations.md#系統1)

- **A1a: ◎** — sandbox 内の Bash の通信先を制限し、WebFetch ツールと MCP server も無効にする。`excludedCommands` による sandbox 外での実行を防ぐため、起動前に例外を除去し、managed settings で Edit／Write と Bash の両方から設定ファイルへの書込みを禁止する。[公式仕様](https://code.claude.com/docs/en/sandboxing#keep-developers-from-widening-the-policy)
- **A1b: ○** — 許可した hostname 内の認証主体・endpoint を限定していない。利用者の token をマスクして権限を絞っても、隔離環境内のプログラムは攻撃者の用意した別の token を使って通信できる。
- **B2a: ○** — Bash の作業領域外への write は制限できるが、本体は OS sandbox の外にいる。本体の Edit／Write は permission ルールで制限するが、ルールは deny、ask、allow の順に評価され、deny の中を allow で開け直せない（[公式仕様](https://code.claude.com/docs/en/permissions)）。そのため、全体を deny して作業領域だけを許可する書き方はできない。読取りの `blockReadsOutsideWorkingDirectories` に当たる、書込み用の設定もない。個別のパスを `Edit(path)` で deny することはできるが、作業領域外への書込みを一律には拒否できず、その判断は auto mode の classifier に依存する。
- **A2-Y・A3-Y: ○** — sandbox 内の `GH_TOKEN` と `API_PASSWORD` はダミー値とし、許可先への通信時に本物へ置換する。本体の Read には `.env` の deny を置く。不要な secret は Bash と本体の両方で読取拒否し、ツールの出力に残るシークレットは sumi でマスクし、auto mode の操作審査で誤保存を減らす。

履歴や memory は `CLAUDE_CONFIG_DIR` で作業領域内の `.claude-state` に保存し、同じ制限を適用する実行でだけ再利用する。元のホスト側の保存先は、managed settings で Edit／Write と Bash の両方から書込みを禁止する。専用の保存先でも、履歴や memory の改変は次の実行へ引き継がれる。

Claude Code 単体で構成でき、導入コストは小さい。設定ファイルへの書込みは制限するが、Claude Code 本体によるそれ以外のホストファイルへの書込みには追加の対策が必要となる。

### 系統2: srt

[Anthropic srt](https://github.com/anthropics/sandbox-runtime) で Claude Code 本体ごと隔離し、Read / Write / Edit を含む全プロセスに OS sandbox の filesystem / network policy を適用する。[設定例](threat-model-configurations.md#系統2)

- **A1a: ◎** — 本体も含めた外向き通信を hostname allowlist で制限する。
- **A1b: ○** — `credentials` の mask はダミー値を本物へ置換する。隔離環境内のプログラムが攻撃者の token を付けて送った request は、その token のまま許可先へ届く。srt をライブラリとして組み込めば `filterRequest` で要求ごとに判定できるが、SOCKS 経由などの TLS を終端しない経路には適用されない（本節末の拡張案を参照）。
- **B2a: ◎** — 作業領域外への write を制限し、[標準保護](https://github.com/anthropics/sandbox-runtime#mandatory-deny-paths-auto-protected-files)で `.git/config`・`.git/hooks` 等を保護する。作業領域の `.claude` は `denyWrite` に追加する。hook 実体を共通条件と異なる場所へ置くなら、その参照先も `denyWrite` に追加する。
- **A2-Y・A3-Y: ○** — 認証情報のマスクと `denyRead` による読取りの拒否を、Claude Code 本体にも適用する。ツールの出力に残るシークレットは sumi でマスクし、auto mode の操作審査で誤保存を減らす。
- **P1: ○** — この構成の network policy は hostname 単位であり、GitHub 内の情報源の判定は classifier に依存する。

状態は Claude Code の `CLAUDE_CONFIG_DIR` で作業領域内の `.claude-state` に保存する。これを隔離実行専用とし、srt の filesystem policy で元のホスト状態への書込みを拒否する。[実験](experiments/state-isolation/README.md)でこの分離を確認した。この保存先でも、状態の改変は次の実行へ引き継がれる。

**拡張案**: srt をライブラリとして組み込むと、`filterRequest` で HTTP の要求と、srt が TLS を終端した HTTPS の要求を JavaScript 関数で検査できる。ただし srt 0.0.77 の[実測](experiments/srt-filter-bypass/README.md)では、次の経路が TLS 終端を通らず、この関数も認証情報の代理注入も適用されずに許可先へ届いた。どれも sandbox 内でコマンドを実行できれば使え、ホストを先に侵害する必要はない。

- **SOCKS**: srt は同じ proxy のポートで HTTP と SOCKS を受け付け、SOCKS の接続は中身を見ずに中継する。sandbox 内のプログラムが、渡された proxy URL の scheme を `socks5h://` に変えるだけで、指定した token（実測では偽の token）が GitHub に届き、`Bad credentials` が返った。
- **TLS 以外のプロトコル**: 許可リストにポートがないと `github.com:22` への SSH が GitHub の sshd に届いた。`:443` に絞っても、`*.github.com:443` のように `ssh.github.com:443` を含む許可では SSH が届いた。使い捨ての鍵が拒否されるところまでを確認しており、攻撃者の鍵による push や未信頼 repo の fetch に使えると判断する。
- **`tlsTerminate.excludeDomains`**: 除外したホストへの HTTPS は検査されない。

そのため `filterRequest` を実装しても A1b・P1 は ○ のままである。◎ にするには、SOCKS 経路でも TLS 終端を強制するよう srt を変更する必要がある。そのうえで、許可リストはホスト名を完全一致で書いてポートを `:443` に限り、GitHub・Anthropic のように攻撃者もアカウントを持てるサービスを `excludeDomains` に入れない。`filterRequest` には、使えるアカウントの制限と GitHub の repo・操作・GraphQL 本文の検査を実装し、別の認証方法やリダイレクトを使う要求も検査され、判定できない要求は拒否されることを確認する。提示 JSON の導入負担は小さいが、この拡張には追加の開発が必要となる。

### 系統3: Dev Container

[Anthropic の Dev Container 参照実装](https://code.claude.com/docs/ja/devcontainer)を基に、filesystem を container で隔離し、外向き通信を container 内の iptables で制限する。[設定例](threat-model-configurations.md#系統3)

- **A1a: ○** — TCP 443 の接続先を IP で制限するが、UDP 53 で DNS の問合せを送れる。プログラムが情報をドメイン名に埋め込んで問い合わせると、その情報は攻撃者の DNS サーバへ届く。使用する DNS resolver を限定しても、resolver が外部へ問合せを転送するため、この方法で情報を送れる。また、許可先が共有 IP 上にあれば、同じ IP 上の攻撃者の hostname にも接続できる。個々の接続先が専用 IP を使う場合でも、IP 許可全体を hostname の強制制限と同一視しない。
- **A1b: ○** — IP と port の制限では、許可サービス内で攻撃者の token を使う操作を区別できない。
- **B2a: ○** — ホストからは作業領域だけを RW mount し、Claude Code の状態は container 用 volume に置く。ただし、共有作業領域内の Git / Claude Code の設定・hook 等を保護していない。
- **A2-Y・A3-Y: ○** — `GH_TOKEN` と `.env` の `API_PASSWORD` は本物を container 内で使う。sumi が必要で、モデルへの混入と auto mode による誤保存の低減にとどまる。

既存 Dev Container の運用に載せやすく、アプリの secret 利用方法も変えずに済む。導入コストは小〜中だが、IP allowlist の保守が必要で、起動後に許可先の IP が変わると通信できなくなる。DNS の問合せによる情報送信を止めるには、DNS 通信を拒否し、許可先の IP を `/etc/hosts` 等に固定する必要がある。それでも共有 IP の問題は残る。

### 系統4: nas

[nas](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/README.md) で Claude Code をコンテナに隔離し、外部通信をコンテナ外の proxy で検査する。[設定例](threat-model-configurations.md#系統4)

- **A1a: ◎** — コンテナから外部への接続は proxy を通す。proxy は要求を許可してから接続先の名前解決を行うため、禁止したドメインへの DNS の問合せも防ぐ。
- **A1b: ◎** — GitHub では repo と操作を検査し、許可範囲を越える要求には人間の承認を求める。認証情報も proxy が利用者のものに上書きする。Anthropic は Files API を拒否し、業務 API は共通条件で定めた認証方法と利用範囲に限定する。
- **B2a: ◎‡** — Git や Claude Code の既存設定を書込みから保護する。作業領域の `.claude` は追加の設定で読取り専用にする。既存の設定や hook が[保護対象](threat-model-configurations.md#nas-で保護するファイル)に収まる配置が条件となる。
- **A2-Y・A3-Y: ○** — ファイル、HTTP の要求、ツールの出力に含まれるシークレットをマスクする。ログイン情報はホストに保管し、proxy が通信時に付ける。auto mode の操作審査も使い、誤保存を減らす。
- **P1: ◎（GitHub の指定経路）** — 信頼済み repo の REST API、Git fetch、許可した GraphQL query だけを自動で通す。GraphQL は本文の取得先まで検査し、それ以外の取得には人間の承認を求める。

履歴や memory はホストと共有する。

導入コストは中程度で、API ごとに許可する操作を設定・保守する必要がある。

### 系統5: Docker Sandbox

[Docker Sandbox](https://www.docker.com/products/docker-sandboxes/) の microVM に Claude Code を隔離し、ホスト側 proxy で接続先を制限し、要求に認証情報を付ける。提示例は hostname 単位で許可する。[設定例](threat-model-configurations.md#系統5)

- **A1a: ◎** — VM 外の network policy / proxy が未許可先への通信を阻止する。default kit の不要な network allow rule を削除し、許可先を共通条件の4つの hostname の TCP 443 に限る。`sbx v0.45.1` の[実測](experiments/sbx-shared-ip/README.md)では、proxy を通らない接続も IP ではなく SNI や Host header の名前で判定され、上流への接続先もその名前から解決し直された。そのため、許可先と IP を共有する別の hostname へは接続できなかった。
- **A1b: ○** — `sbx v0.43.0` の[実測](experiments/sbx-a1b/README.md)では、GitHub への通常の proxy 通信は偽の Authorization header もホストの認証値へ上書きした。一方、`curl --noproxy '*'` は GitHub の公開証明書で TLS 接続し、指定した偽 token に対して `Bad credentials` が返った。ログは認証注入のない `transparent` 経路を示す。接続先のホスト名は制限されるが、この方法ではプログラムが指定した token が GitHub へ届く。実測した範囲は、偽の token に対する GitHub の認証エラーが返るところまでである。
- **B2a: ◎** — clone mode で VM 内に作業用の clone を作り、ホスト repo は `/run/sandbox/source` に read-only mount する。shared skills と SSH agent forwarding も無効にする。
- **A2-Y・A3-Y: ○** — secret store と代理注入を使う。ただし、ホスト repo の mount には untracked / `.gitignore` 対象も含まれ、`.env` 等の secret は VM 内から読める。代理注入だけでは隠せないため、[設定例](threat-model-configurations.md#系統5)の secret の移動・読取拒否・sumi 併用と auto mode を組み合わせる。
- **B2b-Y: ○** — auto mode の審査に加え、作業は VM 内の clone で行うため、誤った削除や上書きがホストの作業ツリーに及ばない。

`gh` の [GraphQL API](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql) は query / mutation とも `POST /graphql` の本文で対象を指定する。[Docker Sandbox の HTTP ルール](https://docs.docker.com/ai/sandboxes/governance/concepts/#http-method-and-path)の公開仕様は method/path までで、取得先を区別できない。この比較では GraphQL の利用が必要なので `POST /graphql` を許可する。その本文で指定される取得先は classifier が審査するため、P1 は ○ とする。

ホストとの境界が明快で、作業領域を使い捨てにしやすい。導入コストは中程度。Claude Code は既定の起動方法を使わず、approval が有効になるよう VM 内で `claude --permission-mode auto` を起動する必要がある。

**今後の見通し**

Docker Sandbox は、今後の対応次第で A1b を満たす構成を作れると期待している。v3 kit の [`network-policy@2`](https://github.com/docker/sandbox-kit-spec/blob/main/docs/spec/capabilities/com.docker.sandbox/network-policy%402.md) には HTTP method/path の制限があり、検査できない接続は拒否する仕様である。これが実装どおり働けば、proxy を通らない直接接続を拒否し、REST・Git の操作先を必要な非公開 repo に限定する道がある。ただし、他の kit や policy に hostname 全体の allow が残ると、狭い allow を追加しても制限にはならない。

参照した組込み `claude` は v2 kit で、v3 mixin を追加できない。[公式の互換性説明](https://docs.docker.com/ai/sandboxes/customize/#version-compatibility)では、workload と mixin をすべて v3 に揃える必要がある。したがって、組込み Claude の対応を待つか、Claude を動かす v3 workload を自分で用意することになる。公式対応の時期は不明で、v3 構成の HTTP 制限も本稿では未実測である。比較表は現在の提示構成の評価とし、この見込みでは加点しない。GraphQL 本文による対象・操作の判別は、method/path 制限だけでは解決しない。
