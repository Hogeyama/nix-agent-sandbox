# コーディングエージェントのセキュリティ対策の選定

## 想定するリスク

### A: 情報の持ち出し

#### A1: 第三者への流出

本来情報を渡してはいけない第三者が、ソースコード、環境情報、シークレット等を取得可能になる。

攻撃者のサーバへの直接送信だけでなく、公開リポジトリ、公開 Issue、攻撃者管理リポジトリ等への書き込みも含む。

経路によって次の2つに分ける。

* A1a: 未許可送信先への流出
  * 攻撃者サーバ等、許可していない外向き経路への送信
* A1b: 許可済みサービスを介した第三者への流出
  * GitHub 等、サービス自体へのアクセスは許可しているが、そのサービス上にある第三者のリソースへの書き込み

#### A2: 正規連携先への不要な流出

LLM プロバイダや自組織の非公開リポジトリ等、業務上一定の情報を渡すこと自体は認めている相手に、本来渡す必要のないシークレット等まで送信する。

正規連携先であることは、その相手に任意の情報を送ってよいことを意味しない。

#### A3: ローカルでの意図しない永続化

ソースコード、テストデータ、ログ、ローカルコミット等にシークレットが残り、後続操作による A1 や A2 の原因になる。

例:

* `.env` を誤ってコミットする
* token をデバッグコードへ埋め込んだまま残す
* secret を含む API response をログへ保存する

### B: 未許可の変更・権限行使

#### B1: 本番等への高影響な操作

エージェント単独では完遂させたくない外部操作を実行する。

例:

* 本番 DB の変更
* 本番へのデプロイ
* 意図しない外部メール送信
* GitHub Actions 等を介した本番変更

#### B2a: 開発環境からホストへの破壊・改変波及

作業領域外のホスト領域を削除・変更したり、後続のホスト実行へ影響する状態を書き換える。

例:

* `$HOME` 配下の別プロジェクトを変更する
* shell の設定を変更する
* ホストの Claude Code の設定や hook を変更する
* plugin、skill、script 等を書き換え、後続のホスト実行時にコードを動かす

#### B2b: 作業領域・開発リポジトリの破壊

隔離境界内の作業領域や開発リポジトリを破壊・改変する。

例:

* `rm -rf`
* `git checkout .`
* `git clean -fdx`
* `git push --force`
* 意図しない大規模変更

## 被害が起きるパターン

### X: エージェントの判断を信用できない状態

エージェントが制約を回避する操作を選択する可能性がある状態。

原因として、例えば次を含む。

* 直接・間接のプロンプトインジェクション
* 悪意ある外部コンテンツ
* 悪意のある、または侵害された MCP server
* 悪意のある、または侵害された依存パッケージ
* ツール出力に含まれる敵対的な指示
* エージェント自身による制約回避

### Y: 非敵対的エージェントの過失

利用者の意図に従おうとしているが、コマンドや引数の記述ミス、パスや環境の取り違え、文脈の誤認識等によって誤動作する状態。

## 入力元の信頼性

エージェントが読み取る情報源を、信頼済み情報源と未信頼情報源に分ける。

### 信頼済み情報源

内容を自動的にエージェントへ渡してよいと事前に定めた情報源。

リポジトリを信頼済みとする場合は、その公開範囲だけでなく、誰が内容を書き込めるかも含めて判断する。

### 未信頼情報源

投稿者、管理者、生成経路等を十分に信頼できず、敵対的な内容を含み得る情報源。

例:

* 公開リポジトリ
* 第三者が管理するリポジトリ
* Web ページ
* 外部ユーザーが投稿可能な Issue / PR / comment
* 外部から取得した package やその説明情報

信頼済みかどうかは、ローカルにあるかネットワーク越しに取得するかでは決めない。

外部リポジトリから取得した README は、ローカルに保存された後も未信頼であり得る。一方、ネットワーク越しに取得する情報でも、事前に信頼済みと定めた情報源の内容なら信頼済みとして扱える。

## 被害と発生パターンの対応

| 被害 \ パターン                       | X: 判断を信用できない                           | Y: 非敵対的な過失                                             |
| ---------------------                 | -------------------------------------           | -------------------------------------------------             |
| A1a: 未許可送信先への流出             | `.env` やソースコードを攻撃者サーバへ送信する   | URL や endpoint を取り違えて送信する                          |
| A1b: 許可済みサービス経由の第三者流出 | 公開 repo / Issue 等へ情報を書き込む            | push / API の対象を取り違える                                 |
| A2: 正規連携先への不要送信            | secret を LLM provider や自組織 repo へ送信する | config / log を読み、secret を context や commit に混入させる |
| A3: 意図しない保存                    | secret を source や commit に埋め込む           | `.env` の commit、token の hard-code                          |
| B1: 高影響な外部操作                  | 本番 DB / deploy / mail 等を実行する            | 本番 endpoint 等を取り違える                                  |
| B2a: ホストへの波及                   | host 設定や作業領域外を変更する                 | path 指定ミスで host 側を変更する                             |
| B2b: 作業領域・開発 repo の破壊       | destructive command や不正な変更を行う          | 未コミット変更を誤って消す                                    |

## 要求（仮）

### 必須防御

#### A1a: 未許可送信先への第三者流出

許可していない外向き経路への送信を、エージェントが迂回できない境界で fail-closed に阻止する。

hostname、IP、別 protocol、別 tool 等、利用可能な別経路も含めて評価する。

#### A1b: 許可済みサービスを介した第三者流出

GitHub 等の利用自体を許可したサービスについても、第三者が管理・閲覧できる対象への書き込みを完遂不能にする。

次のいずれかで強制する。

* サービス側の権限制御で対象や操作を限定する
* credential の権限を限定する
* リクエスト内容を判定できる gateway で制限する
* エージェントが迂回できない人間承認を要求する

FQDN の許可だけでは、そのサービス内の全対象を許可したものとは扱わない。

#### B1: 本番等への高影響な操作

本番その他の高影響操作を、

* 到達不能
* credential / permission 不足
* エージェントが迂回できない承認

のいずれかによって、エージェント単独では完遂不能にする。

本番への直接接続だけでなく、GitHub Actions 等を介した変更も含む。

#### B2a: 作業領域外のホストへの破壊・改変波及

filesystem / container / VM 等の境界によって、許可した領域以外への永続的な書き込みを fail-closed に阻止する。

`/tmp` や、運用上必要な認証情報・履歴等の共有は例外として認める。

ただし、共有する状態のうち、後続のホスト実行に影響する設定、hook、plugin、skill、command、script 等は書き換えを許可しない。

### ベストエフォート

次は典型的な Y を阻止・低減する。

* A2-Y: 正規連携先への不要な secret 混入
* A3-Y: secret の意図しない保存
* B2b-Y: 作業領域・開発リポジトリの破壊

secret masking、read restriction、認証情報の代理注入、操作審査、Git 保護等によって対処する。

### 許容

次は隔離境界内で発生し得るものとして許容し、review、rollback、credential rotation 等で対処する。

* A2-X
* A3-X
* B2b-X

ただし、これは次を前提とする。

* 作業領域の重要データは Git、snapshot、backup 等から復旧可能
* 作業領域に唯一のコピーしか存在しない重要データを置かない
* 開発リポジトリへの変更だけでは本番権限を得られない
* 本番反映には独立した承認や権限制御がある

## P1: 未信頼情報源の無人取り込みを制限する

プロンプトインジェクションの入口を減らすため、信頼済み情報源以外の内容をモデルへ渡す操作は、人間承認または拒否とする。

信頼済み情報源は自動取得を許可する。

判定には FQDN や local / remote の別ではなく、owner、repository、endpoint、operation 等を使う。

P1 は被害ではなく X の入口を減らす対策であり、A1a / A1b / B1 / B2a とは別に扱う。

必須防御は X を仮定しても成り立つように選ぶため、P1 が防ぐのは、許容とした A2-X / A3-X / B2b-X への入口に限られる。また、依存パッケージや MCP server 等、P1 では制限しない X の原因も残る。

そのため P1 には ○ 以上を求め、◎ は加点とする。

## 防御の機構と評価基準

### 検討する対策

* 危険なツール呼び出しの審査
  * [Claude Code auto mode](https://code.claude.com/docs/ja/auto-mode-config)
    * 敵対的エージェントなら迂回可能。過失防止と割り切るべき
  * 手動承認
    * 量が増えると形骸化する問題（Approval Fatigue）が知られている（が、本稿では強く問題視はしない）
* [Dev Container](https://code.claude.com/docs/ja/devcontainer)
  * Anthropic の参考実装のように iptables を制限する前提で考える
* [Docker Sandbox](https://www.docker.com/products/docker-sandboxes/)
* [Anthropic srt](https://github.com/anthropics/sandbox-runtime)
  * settings.json `$.sandbox` で使われているもの
* Hooks でシークレットマスク
  * [sumi](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/contrib/sumi/README.md) （手前味噌ではございますが）
* Docker製のsandbox
  * [nix-agent-sandbox](https://github.com/Hogeyama/nix-agent-sandbox/blob/main/README.md) （手前味噌ではございますが2）
* GitHub fine-grained token

### 防御の機構

| 機構                     | 動作                                                                    | 主な対象         |
| ------------             | -------------------------------------------------------------           | -------------    |
| 境界隔離                 | network、filesystem、mount 等を deny-by-default / allowlist で制限する  | A1a、B1、B2a     |
| サービス側の権限制御     | token / app の対象と操作を限定する                                      | A1b、B1          |
| リクエスト単位の通信制御 | method、path、repository、GraphQL operation 等を判定する                | A1b、B1、P1      |
| 読取拒否・持込禁止       | secret 等をエージェントから不可視にする                                 | A2、A3           |
| 認証情報の代理注入       | エージェントには dummy value を見せ、proxy が許可先にだけ本物を注入する | A2、A3           |
| 内容の墨消し             | model input、HTTP request、tool output 等から登録済み secret を除去する | A1、A2、A3       |
| 操作審査・承認           | 操作を人間または classifier が審査する                                  | A1b、B1、B2b、P1 |
| 復旧可能な作業領域       | 作業領域を使い捨て可能にし、巻き戻せるようにする                        | B2b              |

### 評価基準

* ◎: X を仮定しても、fail-closed な境界、サービス側の権限制御、または強制的な人間承認によって阻止できる
* ○: 一般的な Y や典型経路を阻止・低減できるが、X が回避可能な経路が残る
* ×: 典型シナリオを防げない、または対象外

A1a / A1b / B1 / B2a には ◎ を求める。

A2-Y / A3-Y / B2b-Y / P1 には ○ 以上を求める。P1 の ◎ は加点とする。

auto mode の classifier で対象操作を阻止・低減できる場合は ○ とし、X に対する強制境界とは扱わない。

## 比較する5系統

* 系統1: `settings.json` (`permissions` + `sandbox`) + sumi + auto/manual approval
* 系統2: `srt` + sumi + auto/manual approval
* 系統3: Dev Container + firewall + sumi + auto/manual approval
* 系統4: `nas` + managed settings + auto/manual approval
* 系統5: Docker Sandbox + sumi + auto/manual approval

## 設定例の共通条件

以降は次の条件で比較する。

### 通信先

次のサービスとの通信が必要である。

* Anthropic API: `api.anthropic.com`
* GitHub: `github.com`, `api.github.com`
* 業務 API の開発環境: `devapi.example.com`

### GitHub での作業

* REST API / GraphQL による情報の取得・更新と、Git による clone / fetch / push を行う。
* Issue / PR / comment も参照する。
* 自組織の非公開リポジトリを業務上の情報共有先とする。
* 自組織の対象リポジトリへ内容を書き込める人、bot、GitHub App 等は信頼境界内とみなし、そのリポジトリを P1 における信頼済み情報源とする。
* 公開リポジトリと他 owner のリポジトリは未信頼情報源とする。

### auto mode の審査ルール

各系統で、Claude Code が動く環境の managed settings に次を置き、各設定例と併用する。`my-org` は自組織名に置き換える。

```jsonc
// /etc/claude-code/managed-settings.json
{
  "autoMode": {
    "classifyAllShell": true, // 許可済みの shell コマンドも classifier で審査する
    "environment": [
      "$defaults",
      "Source control: github.com/my-org",
      "Internal API: devapi.example.com"
    ],
    "hard_deny": [
      "$defaults",
      "Never access GitHub repositories outside my-org, including read-only operations such as GET, clone, and fetch."
    ]
  }
}
```

`hard_deny` も classifier が読む自然言語のルールであり、P1 の過失低減（○）として扱う。[auto mode のルール設定](https://code.claude.com/docs/en/auto-mode-config#override-the-block-and-allow-rules)

### Web 検索の無効化

各系統で、Claude Code が動く環境の managed settings に次を置く。

```jsonc
// /etc/claude-code/managed-settings.json
{
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

WebSearch は Anthropic API 側で検索を実行し、結果を API レスポンスとしてモデルへ返す。通信先は `api.anthropic.com` だけなので、network の allowlist でも proxy でも取得先を判定できない。未信頼情報源である Web の内容が承認なしにモデルへ届くため、ツール自体を除去する。

### GitHub の認証

* GitHub の認証には fine-grained token 等を用いる。
* resource owner を自組織に限定する
* 必要な repository のみに限定する
* permission を必要最小限にする
* SSH credential や別の広い GitHub credential をエージェントに渡さない

### 本番環境

* 業務 API は開発環境のみを利用する。
* 本番 API / DB の credential はエージェントに渡さない。
* GitHub repository には本番 deploy 用の Actions が存在するが、エージェントが持つ GitHub credential だけでは本番変更を完遂できない独立した保護を置く。

### シークレット

実行時に必要なシークレット:

* GitHub 認証用の環境変数 `GH_TOKEN`
* 業務 API 認証用の `.env` 内 `API_PASSWORD`

今回の作業では不要なシークレット:

* `~/.ssh`
* `~/.aws`
* `~/.config/gh/hosts.yml`

不要なシークレットは隔離環境へ持ち込まないか、読み取りを拒否する。

### 作業領域

エージェントは作業領域内のファイルを読み書きする。

一時ファイルには `/tmp` を利用する。

# 系統1: settings.json + sumi + auto/manual approval

Claude Code 本体はホスト上で動かし、Bash とその子プロセスを内蔵 sandbox で隔離する。

Claude Code 本体側のツールには `permissions` を適用し、シークレットの墨消しに sumi、操作の審査に auto mode を併用する。

## 設定例

共通の `autoMode` と次の設定を、同じ managed settings に置く。

```jsonc
// /etc/claude-code/managed-settings.json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [],
  "permissions": {
    "defaultMode": "auto",
    "disableBypassPermissionsMode": "disable",
    "deny": [
      "WebFetch", // bare 指定でツール自体を除去する
      "WebSearch", // 共通条件
      "Read(~/.ssh/**)", // 実行に使用しない秘密は Read ツールでも拒否する
      "Read(~/.aws/**)",
      "Read(~/.config/gh/**)", // gh auth login の保存先
      "Read(./.env)" // mask は Bash 側だけ。本体の Read は deny で拒否する
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true, // 初期化失敗時に非 sandbox 実行へ fallback しない
    "allowUnsandboxedCommands": false, // sandbox 外での実行を許可しない
    "network": {
      "allowedDomains": [
        "api.anthropic.com:443",
        "github.com:443",
        "api.github.com:443",
        "devapi.example.com:443"
      ],
      "strictAllowlist": true,
      "allowManagedDomainsOnly": true,
      "tlsTerminate": {} // TLS inspection を行う（ダミー値の置換に必要）
    },
    "filesystem": {
      "allowWrite": ["/tmp"],
      "denyRead": [ // Bash 側の読取拒否
        "~/.ssh",
        "~/.aws",
        "~/.config/gh"
      ]
    },
    "credentials": {
      "envVars": [
        {
          "name": "GH_TOKEN",
          "mode": "mask",
          "injectHosts": ["github.com", "api.github.com"]
        }
      ],
      "files": [
        {
          "path": "./.env",
          "mode": "mask",
          "extract": "API_PASSWORD=(\\S+)",
          "onExtractNoMatch": "deny",
          "injectHosts": ["devapi.example.com"]
        }
      ]
    }
  }
}
```

```sh
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt # hooks を ~/.claude/settings.json に追加
```

`GH_TOKEN` と `API_PASSWORD` は sandbox 内ではダミー値として見せ、許可した送信先への通信時に本物へ置換する。

`~/.ssh`、`~/.aws`、`~/.config/gh` は Bash と Claude Code 本体の Read tool の双方から読めないようにする。

`allowedDomains` 以外への通信は自動承認に回さず拒否する。

Claude Code の sandbox は Bash とその子プロセスに適用され、本体の Read / Write / Edit 等には適用されない。また `excludedCommands` は managed settings だけに固定できないため、利用する設定ファイルをエージェントが変更できないことを別途保証する必要がある。

## 要求の充足

* A1a: ◎*
  * sandbox 内プロセスの外向き通信を allowlist で制限する。
  * `WebFetch` と MCP を別経路として閉じる。
  * user / project settings から sandbox 外実行経路を追加できない運用を前提とする。
* A1b: ◎
  * GitHub 側の repository scope により第三者リソースへの書き込み権限を持たせない。
* A2-Y: ○
  * credential masking、Read deny、sumi で secret のモデル到達を減らす。
* A3-Y: ○
  * credential masking、Read deny、sumi、auto mode で誤保存を減らす。
* B1: ◎
  * 本番 credential を持たず、本番変更には独立した保護を置く。
* B2a: ○（未達）
  * Bash は sandbox により作業領域外への write を阻止できる。
  * Claude Code 本体の Write / Edit 等は同じ OS sandbox 内にはなく、auto mode の判断に依存する。
* B2b-Y: ○
  * auto/manual approval で典型的な破壊操作を低減する。
* P1: ○
  * 共通の auto mode ルールで自組織外の取得を抑えるが、classifier の判断に依存する。

## pros / cons

pros:

* Claude Code 単体で構成できる。
* credential masking を利用できる。
* hostname allowlist を利用できる。

cons:

* Claude Code 本体全体を OS sandbox に入れる構成ではない。
* B2a は Claude Code 本体側の制御に依存する。
* sandbox 外実行経路を追加する設定まで managed settings だけで固定できない。
* P1 を ◎ にするには、取得先まで確認する手動承認か外部 gateway が必要。

# 系統2: srt + sumi + auto mode

`srt` で Claude Code 本体ごと隔離する。

Bash に加えて Read / Write / Edit 等にも OS sandbox の filesystem / network policy が適用される。

## 設定例

```jsonc
// ~/.srt-settings.json
{
  "network": {
    "allowedDomains": [
      "api.anthropic.com",
      "github.com",
      "api.github.com",
      "devapi.example.com"
    ],
    "deniedDomains": [],
    "tlsTerminate": {} // ダミー値の置換に必要
  },
  "filesystem": {
    "allowWrite": [".", "/tmp"],
    "denyWrite": [],
    "denyRead": [ // Read ツールにも Bash にも適用される
      "~/.ssh",
      "~/.aws",
      "~/.config/gh"
    ]
  },
  "credentials": {
    "envVars": [
      {
        "name": "GH_TOKEN",
        "mode": "mask",
        "injectHosts": ["github.com", "api.github.com"]
      }
    ],
    "files": [
      {
        "path": "./.env",
        "mode": "mask",
        "extract": "API_PASSWORD=(\\S+)",
        "onExtractNoMatch": "deny",
        "injectHosts": ["devapi.example.com"]
      }
    ]
  }
}
```

```sh
export CLAUDE_CONFIG_DIR="$PWD/.claude-state"
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt
srt --settings ~/.srt-settings.json claude --permission-mode auto
```

Claude Code の設定・認証・履歴は作業領域内の `.claude-state` に分離し、Git 管理から除外する。

## 要求の充足

* A1a: ◎
  * Claude Code 本体を含む sandbox 内 process の外向き通信を allowlist で制限する。
* A1b: ◎
  * GitHub 側の repository scope により第三者リソースへの書き込み権限を持たせない。
* A2-Y: ○
  * credential masking、denyRead、sumi。
* A3-Y: ○
  * credential masking、denyRead、sumi、auto mode。
* B1: ◎
  * 本番 credential を持たず、本番変更には独立した保護を置く。
* B2a: ◎
  * Claude Code 本体を含め write 先を作業領域と `/tmp` に制限する。
* B2b-Y: ○
  * auto mode で典型事故を低減する。
* P1: ○
  * 共通の auto mode ルールで自組織外の取得を抑えるが、classifier の判断に依存する。

## pros / cons

pros:

* Claude Code 本体ごと OS sandbox に入れられる。
* B2a の境界が単純。
* credential masking を利用できる。

cons:

* GitHub 内の情報源を network policy で判定できない。
* P1 を ◎ にするには、取得先まで確認する手動承認か外部 gateway が必要。
* ホスト側の Claude Code 状態をそのまま共有する構成ではない。

# 系統3: Dev Container + firewall + sumi + auto mode

Anthropic の Dev Container 参照実装をベースにする。

container で filesystem を隔離し、iptables で外向き通信を制限する。

## 設定例

```jsonc
// .devcontainer/devcontainer.json（参照実装から関係する部分を抜粋）
{
  "build": { "dockerfile": "Dockerfile" },
  "runArgs": ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"], // firewall の設定に必要
  "remoteUser": "node", // sudo は root 所有の init-firewall.sh の実行だけを許可
  "postStartCommand": "sudo /usr/local/bin/init-firewall.sh",
  "remoteEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }
}
```

firewall は次の通信だけを許可する。

* GitHub の必要な IP range（`api.github.com/meta` から取得）
* `api.anthropic.com` の解決先
* `devapi.example.com` の解決先
* DNS（UDP 53）

外部サービスへの接続は TCP 443 に限定し、全送信先への SSH は許可しない。

参照実装の `init-firewall.sh` は、起動時に `dig` で hostname を IP へ解決して許可する。DNS は送信先を限定せず UDP 53 を許可する。

ホストからは作業領域だけを RW mount し、次は mount しない。

* `~/.ssh`
* `~/.aws`
* `~/.config/gh`
* Docker socket

Claude Code の状態は container 用 volume に保存する。

```sh
# コンテナ内。sumi のインストールと secrets file の配置後に実行
sumi init --agent claude --secrets-file ~/.claude/sumi/secrets.txt

claude --permission-mode auto
```

`GH_TOKEN` と `API_PASSWORD` は container 内では実値を利用する。sumi はそれらがツール出力等からモデルへ渡ることを減らす。

## 要求の充足

* A1a: ○（未達）
  * firewall は TCP の接続先を IP で制限する。
  * DNS は許可しているため、攻撃者ドメインのサブドメインへの問い合わせにデータを載せて送る DNS トンネリングが残る。DNS resolver を限定しても、resolver が再帰解決で攻撃者の権威サーバへ問い合わせを届ける。
  * 許可先が CDN 等の共有基盤上にある場合は、同じ IP 上の攻撃者の hostname にも接続できる。今回の許可先のうち、`api.anthropic.com` は専用の IP 範囲を公開しており、この問題は起きない。
* A1b: ◎
  * GitHub 側の repository scope により第三者リソースへの書き込み権限を持たせない。
* A2-Y: ○
  * sumi でモデルへの secret 混入を減らす。
* A3-Y: ○
  * sumi と auto mode で誤保存を減らす。
  * `.env` 自体は平文で存在する。
* B1: ◎
  * 本番 credential を持ち込まず、本番変更には独立した保護を置く。
* B2a: ◎
  * ホストの RW mount を作業領域に限定し、Docker socket 等も共有しない。
* B2b-Y: ○
  * auto mode で典型事故を低減する。
* P1: ○
  * 共通の auto mode ルールで自組織外の取得を抑えるが、classifier の判断に依存する。

## pros / cons

pros:

* 既存 Dev Container の運用に載せやすい。
* ホスト filesystem との境界が単純。
* application は既存の secret 利用方法を変更せず動かせる。

cons:

* IP allowlist の保守が必要。
  * 許可先の IP が起動後に変わると通信できなくなる（流出はしない）。
* secret は container 内 process から見える。
* DNS 経由の持ち出しを閉じるには、DNS を拒否し、許可先の IP を `/etc/hosts` 等で固定する必要がある。
  * そうしても、許可先が共有 IP 上にある場合は hostname 単位の強制境界にならない。
* P1 を ◎ にするには、取得先まで確認する手動承認か container 外 gateway が必要。

# 系統4: nas + managed settings + auto mode

`nas` で Claude Code を container に隔離する。

外部通信を proxy に集約し、method、path、repository 等に基づいて許可、拒否、承認を行う。

シークレットの墨消しと認証情報の代理注入も proxy 側で行う。

## 設定例

ホストと container の双方に managed settings を適用し、MCP server を制限する。

```json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": []
}
```

`agentState.protectSettings = true` で、`~/.claude/settings.json` を含む設定・plugin・skill・agent・command 等を read-only で共有する。hooks の実体も `~/.claude` 配下に置く。

read-write で共有するのは `~/.claude.json` と、`~/.claude/` 内の `history.jsonl`、`projects/`（auto memory を含む）、`file-history/` に限る。ログ・キャッシュとホストに存在しない項目はセッション専用にする。

Claude のログイン情報（`.credentials.json`）は共有しない。`agentState.auth` の既定値 `"proxy"` では、ホスト側の nas が OAuth token を保持・更新し、container にはダミーの `.credentials.json` を見せる。proxy は Anthropic の許可した request にだけ本物の token を注入する。

GitHub は既定を `review` とし、信頼済み情報源への read だけを自動許可する。

```pkl
// .nas/config.pkl
local trustedOwners: Listing<String> = new {
  "my-org" // 自動取得を許可する、信頼済みの自組織
}

local githubScope: Scope = new {
  targets {}
  fallback = "review"
  secrets {
    ["github-basic"] = "inject"
  }
  inject {
    new Inject {
      name = "authorization"
      value = "secret:github-basic"
    }
  }
}

profiles {
  ["claude"] = (super["claude"]) {
    agentArgs {
      "--permission-mode"
      "auto"
    }
    agentState {
      protectSettings = true // 共有する Claude 設定の上書きを防ぐ
    }
    hostexec = null
    extraMounts {
      // .git/config・.git/hooks は nas が自動で read-only にする。.claude は対象外なので明示する
      new { src = ".claude";     dst = ".claude";     mode = "ro" } // project settings の hooks
      new { src = "/dev/null";   dst = "~/.claude/sumi/secrets.txt"; mode = "ro" } // 秘密一覧の実値を container から隠す
    }
    secrets { // ホスト側で読み取る
      ["github-token"] {
        from = "env:GH_TOKEN"
        required = true
      }
      ["github-basic"] {
        // REST API と Git Smart HTTP に注入する Authorization ヘッダ
        from = #"cmd:printf 'Basic %s' "$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)""#
        required = true
      }
      ["api-password"] {
        from = "dotenv:.env#API_PASSWORD"
        required = true
      }
      ["sumi-secrets"] {
        // 他系統で sumi に渡す秘密一覧と同じファイル。1行を1つの値としてマスクする
        from = "lines:~/.claude/sumi/secrets.txt"
        required = true
      }
    }
    env {
      new {
        key = "GH_TOKEN"
        val = "nas-injected" // gh にはダミー値を渡す
      }
    }
    mask = new MaskConfig {
      maskfs = true // ファイルシステム上の秘密値を墨消し
      proxy  = true // HTTP リクエストの秘密値を墨消し
      filter = true // Bash の stdout/stderr を墨消し
    }
    network {
      fallback = "deny"
      scopes {
        ["anthropic"] = (module.presets.anthropic.v1) {
          fallback = "deny"
        }
        ["github-api"] = (githubScope) {
          targets {
            "api.github.com:443"
          }
          rules {
            ["owned.rest-read"] {
              match {
                methods { "GET"; "HEAD"}
                paths {
                  "/repos/{owner}/**"
                  "/orgs/{owner}/**"
                }
                captures {
                  ["owner"] = trustedOwners
                }
              }
              onMatch = "allow"
            }
          }
        }
        ["github-git"] = (githubScope) {
          targets {
            "github.com:443"
          }
          rules {
            ["owned.git-fetch"] {
              match {
                methods { "GET"; "POST"}
                paths {
                  "/{owner}/{repo}/info/refs"
                  "/{owner}/{repo}/git-upload-pack"
                }
                captures {
                  ["owner"] = trustedOwners
                }
              }
              onMatch = "allow"
            }
          }
        }
        ["example-api"] {
          targets {
            "devapi.example.com:443"
          }
          secrets {
            ["api-password"] = "inject"
          }
          inject {
            new Inject {
              name = "x-api-key"
              value = "secret:api-password"
            }
          }
          rules {
            ["all"] {
              match {
                paths { "/**" }
              }
              onMatch = "allow"
            }
          }
        }
      }
    }
  }
}
```

```sh
nas config trust   # 設定を承認
nas claude
```

REST write、GraphQL mutation、`git-receive-pack` 等は自動許可せず `review` に落とす。

自組織の非公開リポジトリは信頼済み情報源として read を自動許可する。

作業領域はホストと read-write で共有するため、`.git/hooks`、`.git/config`、`.claude/settings.json` 等を書き換えられると、ホストで git や Claude Code を実行した時点でエージェントの書いたコードが動く。

nas は git の状態を設定なしで常に read-only にする。

* 対象は `.git/config`、`.git/hooks`、`core.hooksPath` の指す先、`config.worktree`、linked worktree の `.git` ポインタファイル、`.nas`。
  * `.git/config` も保護しないと、`core.hooksPath` を作業領域内の別ディレクトリへ向けて hook を動かせる。`core.fsmonitor`、`filter.*`、`diff.*.textconv` 等も同様である。
  * `.git/hooks` が無ければ、ホスト側に空で作ってから read-only にする。
* 作業領域の root から保護対象までの途中のディレクトリ（`.git` 等）もマウントポイントにする。マウントポイントは rename できないので、`mv .git .git.bak` の後に新しい `.git` を作って保護を外すことはできない。
* `git config`、`git remote add`、`git push -u` 等、`.git/config` を書く操作はコンテナ内で失敗する。ホストで実行する。
* 次は保護の対象外である。
  * 作業領域のパスが symlink を経由する場合、`core.hooksPath` や worktree のポインタが保護から漏れることがある。
  * サブディレクトリに新しく作った `.git`、submodule の `.git/modules`、起動後に作られた `config.worktree`。

`.claude` は自動保護の対象外なので、`extraMounts` で read-only にする。`.claude` は起動前に作業領域に存在している必要がある。存在しないパスはマウントされず、エージェントが新規作成できる。

マスク対象の一覧は、他系統で sumi に渡すものと同じ `~/.claude/sumi/secrets.txt` から `lines:` で読む。nas はこのファイルをホスト側で読むため、container 内の同じパスは `/dev/null` で置き換えて実値を隠す。`~/.claude` を read-only で共有しても、読み取りは防げないからである。`lines:` の値は複数に展開されるため、マスクには使えるが注入には使えない。

ホストの `/tmp` は共有しない。ホストの `/tmp` には tmux、X11、ssh-agent、VS Code 等の unix socket があり、同じ UID のコンテナから接続するとホストでコマンドを実行できる。一時ファイルにはコンテナ内の `/tmp` を使う。

## 要求の充足

* A1a: ◎
  * container からの直接 egress を閉じ、proxy を強制点にする。
  * agent container は `--internal` の network にだけ接続し、Docker の内蔵 DNS は外部の名前を解決しない。
  * proxy は `connection_strategy=lazy` で動かし、request ごとの許可判定を通った後にだけ upstream の名前解決と接続を行う。拒否した送信先の名前は解決しないため、DNS 経由の持ち出しも起きない。
* A1b: ◎
  * GitHub 側の権限制御に加え、proxy でも書き込み操作を制限できる。
* A2-Y: ○
  * maskfs、proxy mask、output filter、credential injection で secret の混入を減らす。
  * Claude のログイン情報も container に置かず、proxy が注入する。
  * 注入は上流が TLS の request に限り、上流の証明書を検証する。平文 HTTP で送らせても、注入した値は経路上に出ない。
* A3-Y: ○
  * エージェントには実値を見せず、auto mode も併用する。
* B1: ◎
  * 本番への直接経路を持たず、GitHub 経由の本番操作も独立した保護を通す。
* B2a: ◎
  * 共有する設定・plugin・skill・hooks 等は read-only で保護し、`~/.claude.json` の MCP 設定はホスト・container 双方の managed settings で制限する。
  * 作業領域内の git の設定と hook、`.nas` は nas が read-only にし、`.claude` は `extraMounts` で read-only にする。
  * agent container は `no-new-privileges` で起動し、entrypoint に必要な 6 つ以外の capability を落とす。
  * 履歴・プロジェクト状態の read-write 共有は、共通条件で認めた例外に含める。
  * Nix 連携を有効にすると `/nix` を read-write で mount する。agent は一般ユーザーで動き権限昇格もできないが、container 内で root を奪われると store 経由でホストに波及し得る。
* B2b-Y: ○
  * local の破壊操作は auto mode、remote write は proxy review でも低減する。
* P1: ◎
  * owner / repository / REST path / Git target 等を使い、信頼済み情報源だけを自動許可できる。

## pros / cons

pros:

* GitHub 内のリポジトリや操作まで見て通信を制御できる。
* 信頼済み read と未信頼 read を分けられる。
* credential をエージェントに直接渡さず利用できる。Claude のログイン情報も含む。
* network write も同じ proxy で承認対象にできる。

cons:

* API ごとの rule 設計が必要。
* 共有する設定や plugin の更新はホスト側で行う必要がある。
* `git config`、`git push -u` 等、`.git/config` を書く操作はホストで行う必要がある。
* 上流の TLS 証明書を検証するため、TLS を傍受する社内 proxy の下や自己署名証明書の通信先には接続できない。回避する設定はない。
* broad rule を書くとリポジトリ単位の境界が失われる。
* Git packfile の中身までは proxy で墨消しできない。
  * `cp .env foo && git add foo && git commit -m 'malicious'` を防ぎたければ `.env` をROマウントする設定が必要（`srt`と同様）

# 系統5: Docker Sandbox + sumi + auto mode

Docker Sandbox の microVM で Claude Code を隔離する。

ホスト側 proxy が network policy と credential injection を行う。

## 設定例

```sh
sbx policy init deny-all

sbx policy allow network \
  "api.anthropic.com:443,github.com:443,api.github.com:443,devapi.example.com:443"

sbx secret set anthropic
sbx secret set github --command 'gh auth token'

sbx secret set-custom \
  --host devapi.example.com \
  --env API_PASSWORD \
  --value "$API_PASSWORD"

sbx settings set ssh.agentForwardingEnabled false
sbx daemon restart

sbx create \
  --name coding \
  --clone \
  --skills off \
  claude .
```

default kit が追加する不要な network allow rule は削除する。

Claude Code は既定の起動方法を使わず、approval を利用する設定で起動する。

```sh
sbx exec -it coding bash
# ここから VM 内
claude --permission-mode auto
```

clone mode では作業用の private clone が VM 内に作られるが、ホスト側 repository も `/run/sandbox/source` に read-only で mount される。

この read-only mount には untracked file や `.gitignore` 対象も含まれる。本物の secret を含む `.env` をホスト側 repository 内に置くと実値が VM 内から読めるようになり、保護は sumi による墨消しと同じ水準に下がる。

代理注入を活かすため、real secret は Git root 外から Docker Sandbox の secret store へ登録する。

application が `.env` を必要とする場合は、VM 内に dummy value を使った `.env` を作る。

```sh
printf 'API_PASSWORD=%s\n' "$API_PASSWORD" > .env # VM 側のダミー値を使う
```

## 要求の充足

* A1a: ◎
  * microVM 外の network policy / proxy が未許可送信先への通信を阻止する。
* A1b: ◎
  * GitHub 側の repository scope により第三者リソースへの書き込み権限を持たせない。
* A2-Y: ○
  * credential injection と sumi。
  * real secret はホスト repository 内に置かない。
* A3-Y: ○
  * application には dummy credential を見せ、real secret を作業領域に置かない。
* B1: ◎
  * 本番権限を持たず、本番変更には独立した保護を置く。
* B2a: ◎
  * microVM 境界に閉じる。
  * clone mode ではホスト repository への write もできない。
  * shared skills と SSH agent forwarding も無効にする。
* B2b-Y: ○
  * VM 内 clone は破壊可能だが、ホストの作業ツリーから分離される。
* P1: ○
  * 共通の auto mode ルールで自組織外の取得を抑えるが、classifier の判断に依存する。

## pros / cons

pros:

* ホストとエージェントの境界が明快。
* clone mode でホストの作業ツリーを直接変更しない。
* credential を VM 内へ持ち込まず利用できる。
* 作業領域を使い捨てにしやすい。

cons:

* P1 を ◎ にするには、取得先まで確認する手動承認か外部 gateway が必要。
* clone mode でもホスト repository の内容は read-only で参照できるため、repository 内に secret を置くと代理注入の利点が失われる。
* Claude Code の起動方法を既定から変更する必要がある。

# 要求充足の比較

| 要求                                   | 必要水準 | 系統1 settings | 系統2 srt | 系統3 Dev Container | 系統4 nas | 系統5 Docker Sandbox |
| --------------------------             | ---:     | -----------:   | ------:   | ----------------:   | ------:   | -----------------:   |
| A1a: 未許可送信先への流出              | ◎        | ◎*             | ◎         | ○                   | ◎         | ◎                    |
| A1b: 許可済みサービス経由の第三者流出  | ◎        | ◎              | ◎         | ◎                   | ◎         | ◎                    |
| B1: 本番等への高影響な操作             | ◎        | ◎              | ◎         | ◎                   | ◎         | ◎                    |
| B2a: ホストへの破壊・改変波及          | ◎        | ○              | ◎         | ◎                   | ◎         | ◎                    |
| A2-Y: 正規連携先への不要な secret 混入 | ○以上    | ○              | ○         | ○                   | ○         | ○                    |
| A3-Y: secret の意図しない保存          | ○以上    | ○              | ○         | ○                   | ○         | ○                    |
| B2b-Y: 作業領域・開発 repo の破壊      | ○以上    | ○              | ○         | ○                   | ○         | ○                    |
| P1: 未信頼情報源の無人取り込み防止     | ○以上    | ○              | ○         | ○                   | ◎         | ○                    |

`*`:

* 系統1 A1a は、user / project settings から sandbox 外実行経路を追加できないようにする運用を前提とする。

## GitHub の通信制御

GitHub の FQDN を許可しても、それだけでは repository owner や情報の出所は限定されない。

書き込みについては fine-grained token 等の GitHub 側の権限制御によって、書き込み可能な repository や operation を限定できる。

fine-grained token は resource owner と repository を指定して権限を絞れるため、A1b の防御は全系統に共通で置ける。一方、公開リポジトリには read-only access が残るため、この仕組みだけでは P1 の「信頼済み情報源だけを読む」は実現できない。

P1 を ◎ にする場合は、例えば次のようにする。

```text
GitHub
  default                                  -> ask

REST
  信頼済み private repository の GET/HEAD  -> allow
  未信頼 / unknown repository の GET       -> ask
  POST/PUT/PATCH/DELETE                    -> ask
                                             または GitHub 側で deny

GraphQL
  信頼済み repository に限定した query    -> allow
  その他 query                            -> ask
  mutation                                -> ask
  判定不能                                -> ask or deny

Git Smart HTTP
  信頼済み repo の git-upload-pack        -> allow
  その他 clone/fetch                      -> ask
  git-receive-pack                        -> ask
                                             または GitHub 側で制限

SSH Git
  deny
```

自組織の非公開リポジトリ全体を信頼済み情報源とする場合、その Issue / PR / comment も自動取得対象にできる。

## 機構・運用面の比較

| 観点                        | 系統1 settings                    | 系統2 srt           | 系統3 Dev Container   | 系統4 nas          | 系統5 Docker Sandbox |
| -----------------------     | ------------------------------    | --------------      | --------------------  | -----------------  | ------------------   |
| エージェントの基本隔離      | Bash sandbox + 本体側 permissions | エージェント全体    | container             | container          | microVM              |
| 外向き通信の強制点          | Bash sandbox + permissions        | エージェント外側    | container 内 firewall | container 外 proxy | VM 外 proxy          |
| hostname 単位の通信制御     | ○                                 | ◎                   | △                     | ◎                  | ◎                    |
| GitHub 側の repository 制限 | ◎                                 | ◎                   | ◎                     | ◎                  | ◎                    |
| GitHub 内の取得対象を識別   | classifier の審査                  | classifier の審査    | classifier の審査      | proxy で強制       | classifier の審査     |
| 認証情報の代理注入          | ◎                                 | ◎                   | ×                     | ◎                  | ◎                    |
| ホスト filesystem の隔離    | △                                 | ◎                   | ◎                     | ◎                  | ◎                    |
| 作業領域の使い捨て          | △                                 | △                   | △                     | △                  | ◎                    |
| 導入コスト                  | 小                                | 小                  | 小〜中                | 中                 | 中                   |

# 選定基準

## 未許可送信先への流出

未許可送信先への通信を、エージェントの判断に依存せず止められるかを見る。

Bash だけを隔離する場合は、Claude Code 本体の別 tool や sandbox 外実行経路も確認する。

IP allowlist の場合は、DNS 等の名前解決経路を介した送信と、許可先が共有 IP 上にある場合を考慮する。

## GitHub を介した第三者への流出

通信制御だけでなく、GitHub token / App の repository scope と permission も含めて評価する。

エージェントに第三者 repository への write 権限自体を与えなければ、GitHub 全体への通信を許可していても A1b を防げる。

## 本番等への高影響な操作

開発権限と本番権限を分離する。

source repository へ push できても、それだけでは本番 deploy を完遂できない構成にする。

## ホストへの破壊・改変波及

エージェントが直接書き換えられるホスト側の状態を確認する。

認証情報や履歴を共有する場合も、設定、hook、plugin、skill、script 等、後続のホスト実行へ影響する状態は保護する。

## 正規連携先への secret 混入

application が secret を必要とする場合は、認証情報の代理注入を使うと、エージェントから本物の値を隠したまま認証できる。

この機能がない構成では、secret masking と操作審査への依存が大きくなる。

## 作業領域の破壊

作業領域内の破壊は復旧可能にする。

ホストの作業ツリーから分離した使い捨ての作業領域にすると、B2b-X を許容しやすい。

## 未信頼情報源の取り込み

P1 を ◎ にする場合は、hostname より細かい単位で取得対象を判定する必要がある。

信頼済み repository を狭く自動許可できるほど、人間承認の回数を減らせる。

# まとめ

A1a、A1b、B1、B2a は、エージェントの判断に依存しない境界で防ぐ。

A2-Y、A3-Y、B2b-Y は、secret masking、認証情報の代理注入、操作審査等によって事故を減らす。

A2-X、A3-X、B2b-X は隔離境界内で許容し、復旧や credential rotation で対処する。

プロンプトインジェクションについては、それ自体を被害とはせず、P1 として未信頼情報源の無人取り込みを制限する。P1 には ○ 以上を求め、◎ は加点とする。

今回の設定例では、系統2・系統4・系統5がすべての要求を満たす。

* 系統1は B2a が不足する。
* 系統2は必須防御を満たす。P1 は ○ にとどまり、◎ には取得先まで確認する手動承認か外部 gateway が必要になる。
* 系統3は A1a が不足する。
* 系統4は、共有するホスト設定を read-only と managed settings で保護して B2a を満たし、P1 も proxy の判定で ◎ になる。
* 系統5は必須防御を満たす。P1 は ○ にとどまり、◎ には取得先まで確認する手動承認か外部 gateway が必要になる。

P1 を ◎ にする場合は、

* nas で共有するホスト設定を read-only と managed settings で保護する
* 各系統で、取得先まで確認するコマンドごとの手動承認を行う

といった構成が候補になる。

P1 を ○ にとどめてよい場合は、srt や Docker Sandbox のようにエージェント全体を隔離する方式で要求を満たせる。

# TODO

* 代理注入で管理する秘密について、A2-X / A3-X の評価を加点項目として追加する。
  * 実値を隔離環境へ持ち込まない構成では、X を仮定しても値を送信・保存できないため ◎ になり得る。実値を置いて sumi だけで保護する構成は ○ にとどまる。
  * ◎ の範囲は代理注入で管理する秘密の値に限られる。token 発行 API や認証情報を返す API が注入先にあれば、実値が隔離環境に入る。
  * 系統1は本体プロセスの環境変数、系統4は maskfs が実値を読む位置について、実値が隔離環境の外にあるかを確認する。
  * 系統4では、Claude のログイン情報も `agentState.auth = "proxy"`（既定）で代理注入の対象になる。
