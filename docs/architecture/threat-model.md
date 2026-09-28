# コーディングエージェントのセキュリティ対策の選定

この文書では、Claude Code を使う開発作業を例に、5つの隔離構成を比較する。判断するのは、どの被害を強制的に防ぐか、どこまでを過失の低減にとどめるか、各構成がその要求を満たす条件は何かである。

比較対象は製品単体ではなく、[設定例](threat-model-configurations.md)と本稿の共通条件を組み合わせた構成である。示していない設定や保護機能には加点しない。**現時点では、全必須要求を満たすと確定できる構成はない**。許可済みサービスを攻撃者の credential で利用する経路について、系統1〜3は防御が不足し、系統4・5は評価が残る。

## 防ぐ被害と許容する被害

### 敵対的な操作と過失を分ける

**X: 敵対的な操作**では、エージェントまたは隔離環境内のプロセスが、利用可能な権限と経路を使い、制約の回避を含む任意の操作を試みると仮定する。直接・間接のプロンプトインジェクション、悪意のある／侵害された MCP server や依存パッケージ、エージェント自身の制約回避を想定する。攻撃者の credential の持込みや、エージェントの判断を介さないプロセスからの直接攻撃も含む。

**Y: 非敵対的な過失**では、エージェントは利用者の意図に従おうとするが、コマンド・引数の誤り、パスや環境の取り違え、文脈の誤認識によって誤動作すると仮定する。

操作審査で Y を減らせても、それだけで X を防げるとは評価しない。

### 被害ごとの要求

| 被害 | 何を防ぐか | 必要な防御 |
| --- | --- | --- |
| **A1a: 未許可送信先への第三者流出** | 攻撃者サーバなど、許可していない外向き経路へのソースコード・環境情報・シークレットの送信 | X を含め、エージェントが迂回できない境界で fail-closed に阻止する。hostname、IP、別 protocol、別 tool も対象 |
| **A1b: 許可済みサービス経由の第三者流出** | 利用を許可した GitHub 等の中で、公開 repo、公開 Issue、攻撃者管理 repo 等へ情報を書き込むこと | X を含め、対象・操作を限定するサービス側権限、credential、通信 proxy、または強制的な人間承認で阻止する |
| **A2: 正規連携先への不要な送信** | 業務上の連携先である LLM プロバイダや自組織の非公開 repo に、不要な secret まで送ること | Y を低減する。X は後述の条件で許容 |
| **A3: 意図しないローカル保存** | `.env` の commit、token のコード埋め込み、secret を含む API response のログ保存など、後続の A1・A2 につながる永続化 | Y を低減する。X は後述の条件で許容 |
| **B1: 高影響な外部操作** | 本番 DB の変更、deploy、意図しないメール送信、GitHub Actions 経由の本番変更など | X を含め、到達不能、権限不足、または強制的な承認により、エージェント単独では完遂不能にする |
| **B2a: ホストへの破壊・改変波及** | 作業領域外の変更や、ホストが使う設定・hook・plugin・skill・script 等の改変による後続実行への影響 | X を含め、許可領域外への永続的な書き込みを filesystem・container・VM 等の境界で阻止する。共有の例外は下記で定める |
| **B2b: 作業領域・開発 repo の破壊** | `rm -rf`、`git checkout .`、`git clean -fdx`、`git push --force`、意図しない大規模変更など | Y を低減する。X は後述の条件で許容 |

A1b と A2 は、情報を受け取る相手で区別する。GitHub や Anthropic の FQDN を許可しても、攻撃者のアカウントやリソースへの送信を許可したことにはならない。また、正規連携先にも任意の情報を送ってよいわけではない。A1b では、利用者が渡す credential の権限に加え、別の credential への差替えも評価する。

A2-Y・A3-Y・B2b-Y には、secret masking、読取拒否、認証情報の代理注入、操作審査、Git 保護等で対処する。A2-X・A3-X・B2b-X は隔離境界内で起こり得るものとして許容し、review、rollback、credential rotation 等で対処する。ただし、次の条件が必要である。

- 作業領域の重要データは Git、snapshot、backup 等から復旧でき、唯一のコピーをそこに置かない。
- 開発 repo への変更だけでは本番権限を得られず、本番反映には独立した承認や権限制御がある。

### ホスト保護の範囲と共有の例外

B2a では隔離機構とホスト管理者を信頼する。ホストが既に使っている設定、hook、plugin、skill、command、script とその参照先は、作業領域内にあっても改変を防ぐ。新しく生成した repo・設定をホストで使うときは、ソース変更を実行するときと同じく review を前提とする。

運用上必要な認証情報・履歴等の共有は例外として認める。この例外は、共有内容の改変や後続実行への影響を無害と評価するものではない。とくに nas は履歴や auto memory を含む状態を read-write で共有するため、B2a の ◎ を「ホストが後で読むあらゆる状態の完全性を保証する」という意味には使わない。保護する設定と共有する状態の内訳、および Nix 連携の留保は[系統4](#系統4-nas)に示す。

### P1: 未信頼情報源の無人取り込みを減らす

P1 は、プロンプトインジェクションの入口を減らすための要求である。目標は、信頼済み情報源だけを自動取得し、それ以外の内容をモデルへ渡す操作を人間承認または拒否にすること。ただし、本比較の最低水準としては classifier による低減も認め、境界・人間承認による強制には追加点を与える。

信頼済み情報源は、内容を自動的にエージェントへ渡してよいと事前に定めた情報源を指す。repo なら公開範囲に加え、誰が書き込めるかで判断する。第三者の repo、Web、外部ユーザーが投稿できる Issue・PR・comment、外部 package 等は未信頼であり得る。判定には FQDN だけでなく owner、repository、endpoint、operation 等を使う。

local / remote の別は信頼性を決めない。外部 repo の README はローカルに保存した後も未信頼であり得る。反対に、ネットワーク越しでも信頼済みと定めた情報源なら自動取得を認める。

P1 の達成後も **X の仮定は維持し、A/B の被害防止評価には加点しない**。nas の P1 ◎ の根拠は、提示した GitHub REST / Git / GraphQL の取得制限である。設定例で自動許可する業務 API の応答の信頼性は未定義であり、ローカルに保存済みの内容も含めた全入力の制御は示していない。この範囲まで網羅した P1 の達成は未評価とする。

## 比較結果と選定

A/B の評価記号は次の意味で使う。

- **◎**: X を仮定しても、fail-closed な境界、サービス側権限、または強制的な人間承認で阻止できる。
- **○**: 一般的な Y や典型経路を阻止・低減できるが、X が回避可能な経路は残る。
- **×**: 典型シナリオを防げない、または対象外。
- **保留**: 追加の強制境界はあるが、必要な経路の確認が済まず、◎と判定できない。

P1 では、◎ は設定例で示す取得制限を境界・人間承認で強制する評価、○ は classifier 等に依存する評価、× は制限なしを表す。auto mode の classifier は X に対する強制境界には数えない。

| 要求 | 必要水準 | 系統1 settings | 系統2 srt | 系統3 Dev Container | 系統4 nas | 系統5 Docker Sandbox |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A1a: 未許可送信先への流出 | ◎ | ◎* | ◎ | ○ | ◎ | ◎ |
| A1b: 許可済みサービス経由の第三者流出 | ◎ | ○ | ○ | ○ | 保留 | 保留 |
| B1: 本番等への高影響な操作 | ◎ | ◎† | ◎† | ◎† | ◎† | ◎† |
| B2a: ホストへの破壊・改変波及 | ◎ | ○ | ◎ | ○ | ◎ | ◎ |
| A2-Y: 正規連携先への不要な secret 混入 | ○以上 | ○ | ○ | ○ | ○ | ○ |
| A3-Y: secret の意図しない保存 | ○以上 | ○ | ○ | ○ | ○ | ○ |
| B2b-Y: 作業領域・開発 repo の破壊 | ○以上 | ○ | ○ | ○ | ○ | ○ |
| P1: 未信頼情報源の無人取り込み防止 | ○以上 | ○ | ○ | ○ | ◎ | ○ |

`*` 系統1の A1a は、user / project settings から sandbox 外実行経路を追加できない運用が必要。

`†` B1 は、共通条件で定める本番への到達制限と独立した承認・権限制御についての評価。利用者が本番 credential を渡さないだけでは、持込み credential に対する強制にならない。許可サービス上で別の本番 credential を使う場合の評価は残る。

**系統2・4・5を、そのまま要求充足済みとは選定できない。** 隔離範囲や P1 の違いに加え、A1b の次の不足・未確認点を解消する必要がある。

| 構成 | 検討する理由 | 選定前に必要な確認 |
| --- | --- | --- |
| **系統2: srt** | Claude Code 全体を OS sandbox に入れる。導入コストは小さく、P1 は ○ | hostname allowlist と credential masking だけでは、攻撃者の token による許可サービスへの送信を防げない |
| **系統4: nas** | GitHub の REST・Git・GraphQL の取得先を proxy が判定し、P1 は ◎。Anthropic の endpoint と認証 header も制限する | 業務 API を含め、別の認証 header・body 等で第三者の主体を選べないか確認する |
| **系統5: Docker Sandbox** | microVM 内の private clone を使い、ホストの作業ツリーを直接変更しない。service-based 注入では認証 header を上書きする | 上書き対象以外の認証経路と、custom secret を使う業務 API の認証主体を確認する |

系統1は A1b に加え、本体のホスト書込を OS 境界で制限できず B2a も不足する。系統3は A1b、DNS 等の持ち出し経路、共有する設定・hook の改変が残り、A1a・B2a も不足する。

系統1+2の[併用実験](experiments/srt-settings/README.md)では、既定の組合せは内蔵 sandbox の初期化に失敗した。Unix socket を許可した診断では拒否側を遮断できたが、許可側の対照も通信に失敗し、`enableWeakerNestedSandbox` を有効にしても改善しなかった。正常通信を維持した選別は確認できず、系統1+2を要求充足済みにはしない。いずれの構成でも、作業領域の復旧と新しいコード・設定の採用前 review は必要である。

## 比較の共通条件

### 通信先・権限・信頼済み情報源

必要な通信先は Anthropic API の `api.anthropic.com`、GitHub の `github.com`・`api.github.com`、業務 API の開発環境 `devapi.example.com` とする。GitHub では `gh` による REST / GraphQL の取得・更新、Git の clone / fetch / push、Issue / PR / comment の参照を行う。

情報共有先は自組織の非公開 repo `my-org/private-repo` に限定する。そこへ書き込める人・bot・GitHub App 等を信頼境界内とみなし、P1 の信頼済み情報源とする。公開 repo と他 owner の repo は未信頼とする。

利用者が与える権限は、全系統で次のように限定する。

- GitHub は fine-grained token 等を使い、resource owner を自組織、repository を必要な対象、permission を必要最小限に限定する。SSH credential や別の広い GitHub credential は渡さない。
- 業務 API は開発環境だけを使い、本番 API / DB の credential は渡さない。
- 対象 repo に本番 deploy 用 Actions があっても、エージェントの GitHub credential だけでは本番変更を完遂できない独立した保護を置く。

fine-grained token の scope はその token を使った操作だけを制限する。攻撃者の token を持ち込める構成では、第三者 repo への書込みをそれだけで防げない。また、公開 repo の read 権限は残るため P1 の取得制限にもならない。

この違いは Anthropic API にも当てはまる。Files API のファイルは認証した workspace に属し、同じ workspace の別 key からも参照できる。したがって、許可した `api.anthropic.com` に攻撃者の key でアップロードできれば A1b の経路になる。secret の代理注入と、利用できる認証主体・endpoint の固定は別に評価する。[Files API](https://platform.claude.com/docs/en/build-with-claude/files)

### 操作審査とモデル入力

全系統で [Claude Code auto mode](https://code.claude.com/docs/ja/auto-mode-config) と必要に応じた手動承認を使う。共通の managed settings では、許可済みを含む全 shell コマンドを classifier で審査し、信頼済み repo 以外への read を含むアクセスを `hard_deny` に記す。これは自然言語のルールであり、強制境界ではないため P1 は ○ とする。[ルール設定](https://code.claude.com/docs/en/auto-mode-config#override-the-block-and-allow-rules)

WebSearch はツール自体を除去する。検索が Anthropic API 側で実行され、結果も `api.anthropic.com` から戻るため、network allowlist や proxy では検索先を判定できない。

手動承認の増加で確認が形骸化する問題はあるが、本稿ではこれを強く問題視しない。具体的な設定は[共通設定](threat-model-configurations.md#共通設定)に示す。

### シークレットと作業領域

必要なシークレットは GitHub 用の `GH_TOKEN` と、`.env` 内の業務 API 用 `API_PASSWORD` とする。不要な `~/.ssh`、`~/.aws`、`~/.config/gh/hosts.yml` は持ち込まないか、読取を拒否する。

既存のソース・設定・ログ等から secret を除去できず、ファイル全体の読取拒否もできない場合は、登録済みの値を墨消ししてモデルへの混入を減らす。代理注入やファイルのマスクで隠せない入力経路には [sumi](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/contrib/sumi/README.md) を併用する。既存機構で必要な経路を保護できる場合は省略し、評価には各構成に必要な墨消しを含める。

エージェントは作業領域内を読み書きする。各環境で `.local/tmp` を作って Git 管理から除外し、作業領域を起点に起動する。[CLAUDE_CODE_TMPDIR](https://code.claude.com/docs/en/env-vars) は `.local/tmp` とするが、この指定自体は隔離境界ではない。系統1・2は sandbox の読取・書込拒否と Unix socket 制限を併用し、系統3〜5にはホストの `/tmp` や操作用 socket を mount・転送しない。

作業領域のパスは symlink を経由しない。既存 hook の実体は作業領域の `.git/hooks`・`.claude` またはホストの `~/.claude` 配下に置く。

## 各方式の評価理由と成立条件

以下では、隔離範囲、許可先サービス内の制限、secret の扱い、P1 の違いを示す。B1 の本番保護と B2b-Y の操作審査は、共通条件を前提とする。

### 系統1: settings.json

Claude Code 本体はホストで動かし、内蔵 sandbox で Bash と子プロセスを隔離する。本体側の Read / Write / Edit 等には `permissions` を適用する。[設定例](threat-model-configurations.md#系統1)

- **A1a: ◎*** — Bash の通信を hostname allowlist で閉じ、許可外は自動承認へ回さず拒否する。別経路となる WebFetch と MCP も閉じる。ただし `excludedCommands` は managed settings だけに固定できず、エージェントが user / project settings を変更して sandbox 外実行を追加できないことを別途保証する必要がある。
- **A1b: ○** — 許可した hostname 内の認証主体・endpoint を限定していない。credential masking と利用者の token scope は、持込み token を使う経路の強制境界にならない。
- **B2a: ○** — Bash の作業領域外への write は制限できるが、本体は OS sandbox の外にいる。`Edit(path)` の deny は使えるものの、提示例には本体による作業領域外の書込を一律に拒否する設定がない。
- **A2-Y・A3-Y: ○** — sandbox 内の `GH_TOKEN` と `API_PASSWORD` はダミー値とし、許可先への通信時に本物へ置換する。本体の Read には `.env` の deny を置く。不要な secret は Bash と本体の両方で読取拒否し、残る入力経路は sumi で補い、auto mode で誤保存を減らす。

Claude Code 単体で構成でき、導入コストは小さい。ただし、本体への制御と sandbox 外実行経路の固定が別に必要となる。

### 系統2: srt

[Anthropic srt](https://github.com/anthropics/sandbox-runtime) で Claude Code 本体ごと隔離し、Read / Write / Edit を含む全プロセスに OS sandbox の filesystem / network policy を適用する。[設定例](threat-model-configurations.md#系統2)

- **A1a: ◎** — 本体も含めた外向き通信を hostname allowlist で制限する。
- **A1b: ○** — `credentials` の mask はダミー値を本物へ置換する機能で、別の token を拒否する機能ではない。提示した JSON 設定には認証主体・endpoint の制限がない。request 単位の `filterRequest` は library consumer が実装する JavaScript 関数であり、この JSON 設定には追加できない。[srt の設定定義](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/sandbox-config.ts)
- **B2a: ◎** — 作業領域外への write を制限し、[標準保護](https://github.com/anthropics/sandbox-runtime#mandatory-deny-paths-auto-protected-files)で `.git/config`・`.git/hooks` 等を保護する。作業領域の `.claude` は `denyWrite` に追加する。hook 実体を共通条件と異なる場所へ置くなら、その参照先も `denyWrite` に追加する。
- **A2-Y・A3-Y: ○** — credential masking と `denyRead` を本体にも適用する。残る入力経路は sumi で補い、auto mode で誤保存を減らす。
- **P1: ○** — この構成の network policy は hostname 単位であり、GitHub 内の情報源の判定は classifier に依存する。

設定・認証・履歴は作業領域内の `.claude-state` に分離し、Git 管理から除外する。これは隔離実行専用で、ホストでは使わない。導入コストは小さい。

### 系統3: Dev Container

[Anthropic の Dev Container 参照実装](https://code.claude.com/docs/ja/devcontainer)を基に、filesystem を container で隔離し、外向き通信を container 内の iptables で制限する。[設定例](threat-model-configurations.md#系統3)

- **A1a: ○** — TCP 443 の接続先を IP で制限するが、許可している UDP 53 に DNS トンネリングが残る。resolver を限定しても、再帰解決が攻撃者の権威サーバへ問い合わせを届ける。また、許可先が共有 IP 上にあれば、同じ IP 上の攻撃者の hostname にも接続できる。今回の `api.anthropic.com` は専用 IP 範囲を公開しており、この共有 IP の問題は起きない。
- **A1b: ○** — IP と port の制限では、許可サービス内で攻撃者の token を使う操作を区別できない。
- **B2a: ○** — ホストからは作業領域だけを RW mount し、Claude Code の状態は container 用 volume に置く。ただし、共有作業領域内の Git / Claude Code の設定・hook 等を保護していない。
- **A2-Y・A3-Y: ○** — `GH_TOKEN` と `.env` の `API_PASSWORD` は本物を container 内で使う。sumi が必要で、モデルへの混入と auto mode による誤保存の低減にとどまる。

既存 Dev Container の運用に載せやすく、アプリの secret 利用方法も変えずに済む。導入コストは小〜中だが、IP allowlist の保守が必要で、起動後に許可先の IP が変わると通信できなくなる。DNS 経由の持ち出しを閉じるには DNS を拒否し、許可先の IP を `/etc/hosts` 等に固定する必要がある。それでも共有 IP の問題は残る。

### 系統4: nas

[nas](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/README.md) で Claude Code を container に隔離し、外部通信を container 外の proxy に集約する。method、path、repository、GraphQL 本文に基づき、許可・拒否・人間承認を決める。[設定例](threat-model-configurations.md#系統4)

**通信と入力の制限**

A1a は ◎。agent container は `--internal` network だけに接続し、Docker 内蔵 DNS は外部名を解決しない。proxy は `connection_strategy=lazy` で動き、request の許可判定後にだけ上流の名前解決・接続を行う。拒否した送信先の名前は解決せず、DNS 経由の持ち出しも閉じる。

GitHub は既定を `review` とし、信頼済み repo の REST read、Git fetch、許可した GraphQL query だけを自動許可する。GraphQL では取得経路と owner / repo 引数まで検査する。許可外の取得や書込み、判定不能な要求は、その都度人間承認を求める。この取得制限で P1 を ◎ とし、B2b-Y も proxy で補う。

**A1b は保留**。GitHub には上記の操作制限に加え、`Authorization` の上書きがある。Anthropic では提示例の preset と `fallback = "deny"` が Files API を許可せず、許可 request でも `x-api-key` を削除して `Authorization` をホストの値に上書きする。一方、業務 API は全 path を許可し、`x-api-key` だけを上書きするため、別の認証 header や body 等による第三者の主体選択は未確認である。[Anthropic preset](../../src/config/Schema.pkl)、[agent credential](../../src/network/agent_credential.ts)、[header 注入](../../src/docker/mitmproxy/nas_addon.py)

**シークレットの扱い**

A2-Y・A3-Y は ○。maskfs、HTTP request の proxy mask、`mask.filter`、credential injection と auto mode で混入・誤保存を減らす。`mask.filter = true` では nas が sumi を自動配置し、Bash の stdout/stderr のマスクと Claude Code の managed hooks を設定する。秘密一覧はホスト側に保持し、container 内の sumi はマスク用 socket に処理を依頼するため、別途 sumi のインストールや `sumi init` は不要。

Read / Grep 等の成功ツール結果は、モデルへの送信とローカル会話履歴への保存より前にマスクする。成功結果のマスクは、利用者が実機の Claude Code と会話履歴で確認済み。失敗結果は hook から差し替えられないが、Bash の出力は実行時にマスクする。secret の複製・commit に対する限界は[未評価事項](#未評価確認が必要な点)に示す。

Claude のログイン情報は container へ共有せず、既定の `agentState.auth = "injected"` でホスト側が OAuth token を保持・更新する。container にはダミーの `.credentials.json` を見せ、Anthropic の許可した request にだけ本物を注入する。注入は上流が TLS の request に限り、上流証明書を検証するため、平文 HTTP で送らせても注入値は経路上に出ない。一方、TLS を傍受する社内 proxy や自己署名証明書の接続先には対応せず、検証を回避する設定もない。

**ホスト保護と共有の例外**

B2a は ◎だが、既存設定が下記の保護範囲に収まる配置を条件とする。作業領域はホストと RW 共有するため、設定・hook を保護しなければ、ホストで Git や Claude Code を実行したときにエージェントの書いたコードが動く。

| 対象 | 保護と条件 |
| --- | --- |
| Git と nas の既存設定 | `.git/config`、`.git/hooks`、`core.hooksPath` の参照先、`config.worktree`、linked worktree の `.git` ポインタ、`.nas` を自動で read-only にする。`.git/hooks` がなければホストに空で作る |
| 保護対象までの親ディレクトリ | 作業領域 root から `.git` 等の途中のディレクトリも mount point にする。rename 後の再作成で保護を外せないようにする |
| 作業領域の `.claude` | 自動保護の対象外なので明示的に read-only mount する。起動前に存在することが必須。存在しないパスは mount されず、新規作成できてしまう |
| ホストの Claude Code 設定 | `agentState.protectSettings = true` で `~/.claude/settings.json`、plugin、skill、agent、command 等を read-only 共有する。hook 実体も `~/.claude` 配下に置く |
| MCP 設定 | `~/.claude.json` は RW 共有するため、ホスト・container 双方の managed settings で MCP server を制限する |
| 共有状態の例外 | `~/.claude.json`、`~/.claude/history.jsonl`、`projects/` 内の auto memory を含む状態、`file-history/` は RW。ログ・キャッシュとホストにない項目はセッション専用 |

`.git/config` の保護は、`core.hooksPath` の変更による迂回に加え、`core.fsmonitor`、`filter.*`、`diff.*.textconv` 等からの実行も防ぐために必要である。`git config`、`git remote add`、`git push -u` 等の設定更新は container 内では失敗するので、ホストで行う。共有する設定・plugin の更新もホスト側で行う。

自動保護の対象外は、サブディレクトリに新しく作った `.git`、submodule の `.git/modules`、起動後の `config.worktree`。作業領域のパスが symlink を経由すると `core.hooksPath` や worktree のポインタが保護から漏れる場合もある。ホストが既に使う設定がこれらの範囲にあれば B2a は未達となる。

agent container は一般ユーザーで動き、`no-new-privileges` と、entrypoint に必要な6つ以外の capability の削除で権限昇格を制限する。ただし **Nix 連携を有効にすると `/nix` を RW mount し、container 内で root を奪われれば store 経由でホストに波及し得る**。B2a の ◎ は、この root 奪取後の波及や共有状態の改変まで防ぐという保証ではない。root 奪取を X の範囲に含めるか、信頼する隔離機構の破綻と扱うかは未整理である。

導入コストは中程度で、API ごとの rule 設計が必要になる。広い rule にすると repo 単位の境界が失われる。

### 系統5: Docker Sandbox

[Docker Sandbox](https://www.docker.com/products/docker-sandboxes/) の microVM に Claude Code を隔離し、ホスト側 proxy で network policy と credential injection を適用する。提示例は hostname 単位で許可する。[設定例](threat-model-configurations.md#系統5)

- **A1a: ◎** — VM 外の network policy / proxy が未許可先への通信を阻止する。default kit の不要な network allow rule を削除し、許可先を共通条件の4つの hostname の TCP 443 に限る。
- **A1b: 保留** — `sbx secret set` による Anthropic / GitHub の service-based 注入は、環境変数の値によらず指定の認証 header を上書きする。srt のダミー値置換とは異なる。ただし、他の認証 header・body・API 経路までの固定は未確認である。業務 API に使う `set-custom` は placeholder を含む要求だけを置換するため、別の credential の使用をそれだけで防ぐことはできない。[Docker の credential 注入](https://docs.docker.com/ai/sandboxes/configuration/credentials/)
- **B2a: ◎** — clone mode で VM 内に private clone を作り、ホスト repo は `/run/sandbox/source` に read-only mount する。shared skills と SSH agent forwarding も無効にする。ホスト作業ツリーからの分離は B2b-Y の低減にもなる。
- **A2-Y・A3-Y: ○** — secret store と代理注入を使う。ただし、ホスト repo の mount には untracked / `.gitignore` 対象も含まれ、`.env` 等の secret は VM 内から読める。代理注入だけでは隠せないため、[設定例](threat-model-configurations.md#系統5)の secret の移動・読取拒否・sumi 併用と auto mode を組み合わせる。

`gh` の [GraphQL API](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql) は query / mutation とも `POST /graphql` の本文で対象を指定する。[Docker Sandbox の HTTP ルール](https://docs.docker.com/ai/sandboxes/governance/concepts/#http-method-and-path)の公開仕様は method/path までで、取得先を区別できない。GraphQL 全拒否では共通の作業条件を満たせず、許可すれば classifier に依存するため P1 は ○。

ホストとの境界が明快で、作業領域を使い捨てにしやすい。導入コストは中程度。Claude Code は既定の起動方法を使わず、approval が有効になるよう VM 内で `claude --permission-mode auto` を起動する必要がある。

## 未評価・確認が必要な点

- **secret の複製・commit**: Git packfile は proxy で墨消しできない。`cp .env foo && git add foo && git commit -m 'malicious'` に対し、`.env` の read-only mount だけでは読取・複製の防止根拠にならない。この操作を防ぐための追加対策は未確認で、保護として評価しない。
- **代理注入で管理する秘密の A2-X / A3-X**: 将来の加点候補で、現時点の比較には含めない。秘密を隔離環境へ持ち込まない構成なら X に対しても ◎ になり得るが、持ち込んで sumi だけで保護する構成は ○ にとどまる。対象は代理注入する秘密の値に限る。注入先に token 発行 API や認証情報を返す API があれば、本物が隔離環境へ入る。
- 上記の評価には、系統1の本体プロセスの環境変数と、系統4の maskfs が元ファイルを読む位置について、秘密が隔離環境の外にあるかの確認が必要。系統4の Claude ログイン情報は、既定の `agentState.auth = "injected"` で代理注入の対象になる。
