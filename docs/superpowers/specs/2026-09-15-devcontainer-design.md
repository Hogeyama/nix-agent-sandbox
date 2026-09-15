# Dev Container 起動・接続経路の設計

状態: 2026-09-15 設計承認済み。実装・実機検証はまだ行っていない。

## この設計で決めること

読者は [Dev Container 構想](../../todo/devcontainers.md) の実装を判断する保守者。
この文書では最初に提供する操作、そのための起動・終了契約、採用条件を決める。
Feature の公開先や他 OS への展開は元の構想に残す。

Linux ホストの Docker とデスクトップ版 VS Code を対象に、Claude Code の公式拡張を
nas のセッション内で利用する経路を作る。最初の成果物は
`nas devcontainer init/up/status/down`、Compose 生成、常駐管理、環境ランチャー、
自動試験と VS Code での検証手順である。

Feature / Template の配布、任意の既存 devcontainer への追加、macOS / Windows、
Codespaces、Copilot / Codex 拡張は今回の実装範囲に含めない。
VS Code 拡張を使う実機試験が未実施なら「接続確認済み」とは記載しない。

## 利用者の操作

1. 対象プロジェクトの nas 設定を作成し、内容を確認して trust する。
2. `nas devcontainer init --profile claude` を実行する。
   生成する設定と共有範囲を表示する。既存の `.devcontainer` は上書きしない。
3. `nas devcontainer up` を実行して初回の起動を確認する。
4. VS Code の Reopen in Container で接続し、公式 Claude Code 拡張で認証する。
5. 再接続・別ウィンドウでは生存中のセッションを使う。
6. 全ウィンドウでの作業を終えたら `nas devcontainer down` で終了する。

生成設定の `initializeCommand` も `nas devcontainer up` を呼ぶ。
`up` は同じ設定に対して冪等とし、既に接続可能なら同じセッションを返す。
`status --json` はセッション ID、状態、コンテナ ID、profile、診断を返す。
生の環境変数値、秘密、管理資格情報は出力しない。

`shutdownAction` は `none` とする。一つのウィンドウを閉じても停止しない。
再構築は全ウィンドウでの作業を終えて `down`、続いて `up` と Reopen を行う。
VS Code による利用中のコンテナ置換は初版の対応操作にしない。
検出したら当該セッションを失敗状態にし、回収後の再起動を案内する。

## 起動の責任と準備完了

原案からの変更として、nas の supervisor が Compose を生成して
`docker compose up -d` まで行う。Dev Containers はその既存サービスへ接続する。
これにより `initializeCommand` が戻る前にユーザー作成、環境準備、実構成検査まで
完了できる。Compose の project 名・service 名は生成設定と一致させる。

`up` の成功条件は次の全てである。

- 構成・profile の検証と既存の nas trust 検証に成功した。
- 必要なプロキシ、HostExec、mask-filter、port relay がスコープ内で生存している。
- Compose コンテナが running で、初期化プロセスが正常に完了した。
- ホストから Docker inspect で実構成を検査し、計画との一致を確認した。
- 非 root の対象 UID で、HOME、実行環境、必要な socket の利用を確認した。

初期化を終えたコンテナは非 root で待機する。`up` の失敗は非ゼロで返し、
Dev Containers 側にも接続を続行させない。コンテナの表示名や marker ファイルだけを
準備完了の根拠にはしない。

既存コンテナに接続する Dev Containers の挙動、`initializeCommand` の実行順、
extension 設定の適用を実装の最初に対象版で試験する。契約が成立しなければ、
この自動接続方式を提供可能とせず、設計を修正する。

## 起動計画の共通化

現在の `src/stages/launch/stage.ts` は、管理 label と agent 引数を追加した後、
`ContainerPlan` を Docker CLI 引数に変換している。
最終計画の確定を純粋関数へ分け、CLI と Compose の二つの変換器が使う。
通常 CLI の起動順・引数・ログ driver の挙動を回帰試験で維持する。

Compose は JSON 形式で生成し、YAML ライブラリを新規導入しない。
変換対象は image、workdir、bind mount と RO 属性、静的 env、動的 env 操作、
network、alias、extraHosts、command、管理 label、logging とする。
全ての文字列値の `$` を Compose のリテラル表現へ変換し、改行・引用符・空白を保持する。
Docker Compose に実際に解釈させた値でも一致を検証する。

`extraRunArgs` は黙って捨てない。既存の共有メモリサイズなど必要な指定を構造化し、
変換不能な指定はコンテナや常駐プロセスを作る前にエラーにする。
`compileLaunchOpts` の結果を逆解析する方式は採らない。

初版は DinD 無効の profile を対象にし、`docker.enable: true` は明示的に拒否する。
container network mode と共有 volume を部分的に変換して動作した扱いにしない。
workspace は呼び出したディレクトリに固定する。worktree 作成を設定した profile は
拒否し、先に目的の worktree を作ってそこで `init` するよう案内する。

## 設定と生成物の保管

初版の `init` は nas が管理する `.devcontainer` ディレクトリを新規作成する。
既存ディレクトリ、symlink、複数の devcontainer 定義は自動移行しない。
失敗した作成で利用者の既存ファイルを削除しない。

Compose、起動計画、所有記録、ロック、ログはホスト専用ディレクトリに置く。
恒久的な登録情報は nas の state 配下、実行状態は runtime 配下で workspace ID ごとに
分ける。workspace ID は canonical path の SHA-256、世代はランダムな session ID とする。
ホスト専用ディレクトリは 0700、記録・Compose は 0600 とする。
`.devcontainer/devcontainer.json` はホスト側 Compose の絶対パスを参照する。

コンテナには `.devcontainer` ディレクトリを別の RO bind mount として重ねる。
nas の設定ファイルなど、再起動時のホスト実行に関係する生成済みの入口も保護する。
親ディレクトリの共有や追加 mount による、この保護・ホスト専用領域の別名経由の露出を拒否する。
Compose 自体や管理 socket を参照先へ mount しない。

登録時の設定内容・profile・nas の実装版を指紋として保存する。
`up` は現在の設定と照合し、違えば再利用も新規起動も拒否する。
ホストで変更した設定は停止後に `init` を再実行する手順とし、nas が以前作成したと
所有記録で確認できるものだけを更新する。独自編集の黙示的な承認はしない。

RO mount は稼働中エージェントからの変更を防ぐためのもので、ホスト上の利用者や
別のホストプロセスまで制限しない。VS Code が nas より先に読む任意のホスト設定を
`nas config trust` が保護するとは説明しない。

## セッションの状態と回収

状態遷移は `preparing → starting → ready → stopping → stopped` とし、
途中の失敗は `failed` に記録する。失敗理由は秘密を除いた診断として保存する。
workspace ごとの排他を取得してから生存状態を確認する。

| 状態・操作 | 動作 |
| --- | --- |
| 同時に二つの up | 一つだけが資源を獲得し、もう一つは同じ結果を期限付きで待つ |
| ready への up | 指紋、supervisor、コンテナ ID、実構成を再確認して再利用 |
| 準備・生成失敗 | コンテナを停止・削除してからスコープを解放 |
| down | 自分が所有する世代のコンテナを停止・削除してから資源を解放 |
| down の再実行 | 終了済みとして成功。別世代や別 workspace を操作しない |
| supervisor 不在 | 古い世代を再利用せず、所有ラベルで確認して回収 |
| コンテナ停止・置換 | 該当 ID に限って終了処理。新しいコンテナを追跡対象へすり替えない |
| SIGINT / SIGTERM | 起動中も含めて停止処理を起動し、Effect の finalizer を待つ |
| Docker 利用不能 | failed を残し、回収未完了を表示。状態を削除して成功扱いにしない |

起動全体の既定期限は 120 秒。準備・コンテナ初期化・競合待ちのどこで失敗したかを示す。
既存の長時間イメージビルドは事前に `nas rebuild` で済ませる手順を案内する。
supervisor はコンテナの終了確認と broker の故障を監視する。
強制終了時にも既存の外部ネットワーク隔離を維持し、許可外の直通経路へ切り替えない。

`session.multiplex` による対話端末の attach はこの起動経路では行わない。
セッション ID は既存 UI・監査・承認に使い、Claude のチャット ID とは区別する。
`nas container clean` が active な Dev Container を孤児扱いしないよう所有関係を接続する。

## 環境と Claude Code 拡張

静的 env は Compose の environment に設定する。
初回の root 処理で proxy、CA、ユーザー、mask wrapper を準備し、
秘密を含まない起動環境だけをコンテナ内の root 所有ファイルへ原子的に保存する。
CLI と IDE のプロセスで「direnv の信頼確認 → 評価 → env 操作 → wrapper 優先 PATH」
の順序を共有する。環境全体を無条件に export / ログ出力しない。

非 root から利用できる `nas-devcontainer-exec COMMAND [ARG...]` を用意する。
このコマンドは環境を再適用して対象プロセスを exec し、root 初期化を再実行しない。
`userEnvProbe` と login shell には同じ環境適用処理を使う。
prefix/suffix の二重適用、環境取得時の stdout 汚染、再接続時の古い socket を試験する。

Claude 拡張は `anthropic.claude-code` を remote 側に設定する。
`claudeCode.claudeProcessWrapper` には専用ラッパーを設定し、渡された同梱 CLI の
パス・引数を配列のまま共通ランチャーへ渡す。空引数や空白を shell で再解釈しない。
guide の追加ディレクトリと profile の agentArgs は一度だけ付加する。
標準入出力、終了コード、キャンセル、再開、複数チャットを実機で確認する。
ラッパー設定による拡張の初期権限モードへの影響を利用手順に記す。

## 共有範囲と強制境界

IDE 用 profile は通常 CLI と同じホストの `~/.claude` / `~/.claude.json` を RW で共有し、
ホストの認証状態・履歴を利用する。認証状態・履歴は `down` 後もホストに残す。
VS Code Server と拡張キャッシュは workspace ごとに
分離し、他プロジェクトへ実行コードを持ち越さない。キャッシュを消すと再取得が必要になる。

Nix は初版の IDE 用 profile では無効にする。自動検出によるホスト store / daemon の
共有は行わず、有効な profile は修正を案内して拒否する。
ホスト HOME 全体、SSH / GPG 転送、クラウド認証設定の共有も初版では拒否する。
profile を黙って弱い構成へ書き換えず、拒否理由と該当設定を表示する。

既存の proxy による通信制御、HostExec の exec / control socket 分離、出力マスクを
維持する。秘密フレームはホスト専用とし、終了時に削除する。
ホスト Docker socket、privileged、危険な capability、管理領域を覆う追加 mount は拒否する。
Docker inspect で mount の source/target/RO、image、UID 方針、network、capability、
security options、env と管理ラベルを照合する。差分には env の値を表示しない。

VS Code Server・拡張の導入・認証で必要な通信先は実測してから設定例へ反映する。
不明な通信先を広いワイルドカードで許可しない。
IDE MCP、Git 認証の自動転送、自動ポート転送、ブラウザ連携は別のホスト到達経路なので、
対応構成の検証対象に含める。利用しない転送は生成設定で無効化し、対象版で結果を確認する。

## 実装境界

| 場所 | 責務 |
| --- | --- |
| `src/cli/devcontainer.ts` | 引数、利用手順、結果表示。domain client を呼ぶ |
| `src/domain/devcontainer/` | init/up/status/down、所有記録、排他、常駐プロセス管理 |
| `src/stages/launch/` | 最終計画、Docker / Compose 変換、Compose セッションの生存期間 |
| `src/cli.ts` の pipeline builder | 共通の準備と起動先の選択。通常 CLI の順序を維持 |
| `src/docker/embed/` | 初期化完了通知、環境適用、非 root ランチャー |
| `tests/` と colocated tests | 変換・状態遷移・実 Docker・接続契約の検証 |

stage は純粋な計算、stage-facing service 呼び出し、結果返却だけを行う。
domain / stage service は Effect の Tag・Live・Fake を持ち、I/O の薄い関数と
それらを組み合わせる処理を分ける。CLI 内に監視やファイル操作を追加しない。

## 検証と完了条件

1. Unit: CLI 分岐、Compose の値保持、拒否設定、既存起動との同値性、状態遷移、
   同時 up、失敗時回収、別世代を消さないこと、環境の一度だけの適用。
2. Integration: 実ファイルの排他・原子的更新・symlink 拒否、実子プロセスの終了、
   `docker compose config` と inspect の一致、実コンテナの初期化と再接続。
3. 拒否試験: 入口ファイルの改変、余分な mount / network / capability、
   proxy env を外した通信、古い socket、broker 停止、コンテナ置換。
4. 実機: バージョンを記録した VS Code / Dev Containers / Claude 拡張で、初回接続、
   チャット・差分・ターミナル、別ウィンドウ、再接続、down 後の再起動、認証状態を確認。
5. 変更後チェック: formatting、lint、型検査、unit を行い、最後に full suite を一度実行。
   Docker や実機条件による skip は成功とは分けて記録する。

実機の接続契約が未確認なら、自動試験が通っても実験的機能として扱う。
利用者向けドキュメントは確認済みの導入・終了手順と実際の制約だけを記載する。

## なぜこのアプローチを選んだか

Compose と既存の起動計画を使うと、CLI の保護設定を IDE 用にも再利用できる。
nas が起動と準備完了を管理することで、root 初期化中に VS Code が remoteUser を
探す競合を避け、設定と実コンテナを接続前に照合できる。
明示的な down は終了操作を一つ増やすが、ウィンドウの所有・参照数を推測せずに済む。

単純な Attach to Running Container は接続実証には使えるが、今回の起動・再接続契約と
専用 state を管理する入口が別途必要になる。初期試験の手段として残す。
任意の devcontainer に Feature を追加する方式では、既存の共有・権限を取り消せず、
ホスト側の broker の寿命も管理できないため、最初の提供方式には選ばない。
DinD とホスト Nix の共有は独立した検証が必要なので、初版は明示的に範囲を限定する。

## 確認した資料

- [既存構想](../../todo/devcontainers.md): 目的と先行調査。
- [Dev Container 仕様](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-reference.md): 初期化とコンテナ生成の順序。
- [Dev Containers CLI の Compose 接続処理](https://github.com/devcontainers/cli/blob/main/src/spec-node/dockerCompose.ts): 既存サービスの発見と接続。対象版での検証は別途必要。
- [VS Code の既存コンテナ接続](https://code.visualstudio.com/docs/devcontainers/attach-container): 接続実証の操作。
- [Claude Code の拡張設定](https://code.claude.com/docs/en/vs-code#extension-settings): 同梱 CLI と process wrapper の契約。
- [Compose の補間](https://docs.docker.com/reference/compose-file/interpolation/): リテラルのドル記号。

外部資料の確認日: 2026-09-15。対象版による接続試験は未実施。
