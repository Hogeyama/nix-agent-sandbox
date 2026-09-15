# 検討メモ: Dev Container Feature としての nas / Claude Code 拡張連携

作成日: 2026-09-15  
状態: 検討段階。実装・接続試験・安全性検証は未実施。  
確認したコード: main / 10046089145c4d427ff1398ea36757ffac521d9d

## 目標

「VS Code でプロジェクトを開いたら、安心できる隔離環境で、そのまま
Claude Code の公式 VS Code 拡張を使える」ことを目指す。
毎回 nas の CLI でエージェントを起動して、別途コンテナを選んで接続する操作は
日常の利用手順から減らしたい。

初回には設定の信頼確認と認証を行い、以後はコンテナを開く・再接続するだけで
チャット、差分表示、選択範囲の参照、ターミナル、テストを利用できる形が理想。
新しい外部通信先やホスト操作など、権限が広がる場面は引き続き確認する。
単に任意のローカルフォルダーを開いただけで自動的に安全になるとは扱わない。

## 暫定結論

nas の導入・連携部分を Dev Container Feature として配布することは可能と考える。
一方で、既存の dev container に nas CLI をインストールするだけでは、
そのコンテナに nas の隔離・通信制御が適用されるわけではない。

有力な案は、次の役割分担である。

| 部品 | 責務 |
| --- | --- |
| nas Feature | コンテナ内ツール、Claude Code 拡張の導入設定、環境設定、外側の管理サービスへの接続、診断 |
| devcontainer 設定 / Template | ベースイメージ、ユーザー、共有範囲、ネットワーク、必要な補助サービスを含む既定構成 |
| コンテナ外の nas 管理部分 | ポリシー認可、秘密情報、承認、必要なホスト操作、セッションと関連リソースの管理 |

これは設計候補であり、Feature 名、公開レジストリ、設定スキーマ、CLI コマンドは未定。
既存の任意構成に Feature を追加するだけで安全性を保証する方針にはしない。

## 確認できた前提

### 現在の nas

- [README](../../README.md) は Linux と Docker を前提にした CLI として説明している。
- [コンテナの Dockerfile](../../src/docker/embed/Dockerfile) は Ubuntu ベースで、
  [entrypoint](../../src/docker/embed/entrypoint.sh) がユーザー、Nix、
  プロキシ、direnv、コマンド実行環境を初期化する。
- [ContainerPlan](../../src/pipeline/container_plan.ts) にマウント、環境変数、
  ネットワーク、実行コマンド等を集約し、
  [起動サービス](../../src/stages/launch/container_launch_service.ts) が Docker 実行へ渡す。
  現行の CLI 起動フローと Dev Containers による生成・再接続の責務整理が必要。
- [隔離の説明](../../docs-site/src/content/docs/security/isolation.md) にあるとおり、
  ワークスペースや選択したエージェントの state / 認証ディレクトリを共有し、
  Nix の自動検出ではホストの store / daemon 等も共有する。
  IDE 向けの新しい既定構成では、この共有範囲を改めて判断する必要がある。
- [flake.nix](../../flake.nix) には nas 自体の開発用 devShell がある。
  「nas を開発するための dev container」と、本メモの「他プロジェクトで
  Claude Code を保護する Feature」は異なる成果物である。

### Dev Containers と Claude Code

- Feature はインストールに加え、環境変数、マウント、entrypoint、
  コンテナ内の lifecycle command、ツール固有の customizations を宣言できる。[1]
- Feature の標準メタデータにはホスト側の initializeCommand や、
  Compose のサービス群をそのまま宣言する項目はない。
  ホスト管理やネットワーク構成の全体を Feature 単体で提供できるとは扱わない。[1]
- VS Code は起動済みコンテナへの接続をサポートし、
  workspaceFolder、remoteUser、remoteEnv 等を設定できる。[2]
- Claude Code 拡張はチャット用の CLI を同梱する。
  ターミナルの claude コマンドだけを nas 経由に置き換えても、
  拡張の実行経路を制御したことにはならない。[3]
- VS Code の workspace extension はリモート側で実行できる。
  Claude Code 拡張、本体、子プロセスが実際にどこで動くかは、
  対象バージョンで確認する必要がある。[3][4]

## 選択肢

| 案 | 利点 | 課題 / 判断 |
| --- | --- | --- |
| nas が生成したコンテナに VS Code を接続 | 現行の起動・ポリシー処理を活かして検証を始めやすい | 起動、接続先選択、コンテナ寿命の連携が必要。最初の実証候補 |
| Feature + Template + 外側の nas 管理部分 | 通常の Dev Containers 操作に近い利用体験を目指せる | コンテナ生成とポリシー適用の連携が必要。製品化の有力候補 |
| dev container 内に nas CLI だけを導入 | Feature としてのパッケージ化は小さい | その dev container 自体は保護されない。目標を満たす完成形ではない |
| dev container 内の nas がさらに内側のコンテナを起動 | 現行 CLI の利用に寄せられる | 拡張は外側に残り得る。Docker 権限、パス、IDE 接続も複雑になるため既定案にはしない |

外側の管理部分をホストプロセスに置くか、専用の補助コンテナに置くかは未決定。
HostExec はホスト側の実行主体が必要だが、通信処理のすべてをホストプロセスに
置く必然性はない。承認や秘密情報をエージェントから隔てる境界を先に決める。

## 安全性の条件

「安心」は無制限の操作が安全になるという意味ではなく、エージェントや
プロジェクト内コードが誤動作・悪用された場合の到達範囲を限定することとする。
作業フォルダーへの変更や削除は可能なので、Git / worktree 等の復旧手段も別途必要。

| 対象 | 設計上の条件 |
| --- | --- |
| ファイル | 必要な作業フォルダーを共有し、ホストのホーム全体や SSH 鍵を既定で共有しない |
| 認証・履歴 | 専用 state の永続化を検討する。ホストの認証・hook 設定を無条件に RW 共有しない。コンテナ内に置く資格情報はエージェントが読める前提で扱う |
| Nix | 専用 store / volume 等を検討し、ホストの store や daemon の自動共有を既定にするか再評価する |
| Docker・権限 | エージェント側にホスト Docker socket、privileged、制御を書き換える不要な capability や sudo を与えない |
| 通信 | HTTP_PROXY 等の環境変数だけに依存せず、直接接続を含む外向き経路をコンテナ外から制御する |
| 承認・秘密情報 | 承認用 API / socket、管理用資格情報、生の秘密値の保管場所をエージェントから隔てる |
| 起動・故障 | 制御が成立する前にエージェントを利用可能にしない。管理部分の停止時も通信が開放されない。ホスト実行への自動フォールバックを設けない |
| 再構築 | エージェントが変更できる devcontainer / Compose / Feature 指定や lifecycle script を、再構築時に未確認でホスト実行・権限拡大へつなげない |

Feature は他の Feature や利用者の設定による過剰な権限を必ず取り消せる仕組みではない。
危険な共有やネットワーク構成は、外側から実際の構成を確認して起動を拒否するなどの
扱いが必要。コンテナ内の診断表示だけを安全性の根拠にはしない。

VS Code のローカル UI、Dev Containers 拡張、コンテナ管理部分は信頼対象になる。
ホスト側の拡張、IDE API、ポート転送、認証転送を通る経路は別に検証する。
ユーザー自身がローカル側で Claude を有効にして起動することまで、
Feature 単体で禁止できるとは主張しない。

## VS Code / Claude Code 固有の論点

1. **拡張の実行場所**  
   Claude Code 拡張と同梱 CLI をリモート側で動かす構成を基本候補とする。
   CLI には起動済み entrypoint の環境が自動継承されるとは限らない。
   ターミナル、拡張、タスク、MCP 子プロセスそれぞれの
   UID、HOME、PATH、Nix / direnv、プロキシ CA、出力マスクを確認する。

2. **拡張のプロセス起動**  
   公式設定には claudeCode.claudeProcessWrapper がある。[3]
   nas の環境適用や起動確認の接続点として調査する価値はあるが、
   設定の変更・ラッパーの迂回が可能な場合は強制的な保護境界にならない。
   実行引数、標準入出力、終了、再開、複数チャットの互換性も未検証。

3. **IDE とホストへの経路**  
   Claude Code には差分表示や選択範囲の取得、Notebook 実行を扱う
   組み込み IDE MCP がある。設定や tasks.json の変更が VS Code の実行へ
   つながる点も公式文書で注意されている。[3]
   ホスト側の実行、ローカルファイル参照、Git / SSH 認証転送、
   ブラウザ連携を含めて、対象構成で到達範囲を確かめる。

4. **通信と導入**  
   VS Code Server、拡張、同梱 CLI の導入・更新、ログイン、
   Claude API、依存パッケージ取得に必要な通信を調べる。
   導入のための許可を、エージェント実行時の無制限な通信へ持ち越さない。
   VS Code の自動ポート転送が nas の公開ポートの承認を迂回しない扱いも必要。

5. **セッションと寿命**  
   VS Code の作業環境を一つのエージェントプロセスより長く維持できるようにする。
   切断、ウィンドウ再読込、複数ウィンドウ、複数チャット、
   コンテナ再起動・再作成時に、ポリシー、承認、監査ログの対応を維持する。
   認可の単位を workspace / container / Claude session のどれにするかは未決定。

## 小さく検証する順序

1. Linux + Docker + デスクトップ版 VS Code + 公式 Claude Code 拡張で対象を絞る。
   macOS / Windows / Codespaces への対応は、最初の実証結果と分けて扱う。
2. 現行 nas が起動したコンテナへの接続で、チャット・差分・ターミナル・
   子プロセスが動くことと、その実行場所を確認する。
3. 外側の通信制御と承認を維持したまま、再接続や複数チャットを検証する。
   この段階で必要な起動処理・セッション管理の分離を特定する。
4. 検証できたコンテナ内の導入・連携処理を Feature に切り出す。
   Template と外側の管理部分が要求する契約を明文化する。
5. 通常の Reopen in Container 操作へ統合する。
   未対応構成や管理サービス停止時に、理由を表示して止まることを確認する。

### 実証の完了条件

- 初回セットアップ後、コンテナを開いて Claude Code パネルから作業を開始できる。
- 拡張、本体、Bash、タスク、MCP の実行場所と権限を記録できる。
- 許可済みのファイル編集・テスト・API 通信が動き、許可外のホストファイルや
  未承認の接続先へは到達できない。
- プロキシ変数を外す、直接 IP / IPv6 等を使う、管理部分を停止する場合にも、
  想定外の外向き経路が開かない。
- 承認用経路やホスト Docker socket にエージェントから到達できない。
- IDE 連携、ポート転送、設定変更、再構築経由の権限拡大を検証する。
- 再接続、再起動、再作成、複数チャットで認証・履歴・承認の範囲が混同されない。

## 未決定事項と範囲外

- Feature / Template の公開先、対応ベースイメージ、バージョン固定・更新方法。
- 管理部分の配置と初回導入方法。Feature の追加だけでホストへ自動導入するとはしない。
- 専用 Nix store、資格情報、拡張キャッシュ、会話履歴の永続化単位。
- VS Code 起動から再接続までの具体的な入口。
  nas code のような CLI や専用 VS Code 拡張は候補であり、既存機能ではない。
- 特定設定での fail-closed をどう検証・強制するか。起動ラッパーだけでは不十分。
- 任意の devcontainer の安全化、コンテナ / IDE の未知の脆弱性への保証、
  同一ホストの信頼できない利用者への対応は、このメモで解決済みとしない。

このメモは検討内容の記録のみ。Feature、Template、nas 本体への変更や
安全性を検証済みとする表明は含まない。

## 参考資料

外部仕様の確認日: 2026-09-15。実装時には対象バージョンで再確認する。

- [1] [Dev Container Feature の公式スキーマ](https://github.com/devcontainers/spec/blob/main/schemas/devContainerFeature.schema.json)
- [2] [VS Code: Attach to a running container](https://code.visualstudio.com/docs/devcontainers/attach-container)
- [3] [Claude Code: VS Code extension](https://code.claude.com/docs/en/vs-code)
- [4] [VS Code: Supporting Remote Development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [Claude Code: Development containers](https://code.claude.com/docs/en/devcontainer)
- [既存の安全性メモ](security.md) — 各項目の現行の対応状況は別途確認する。
