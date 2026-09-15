# Claude ACP 起動モード

## 目的と合意

ACP クライアントが `nas claude-acp` を子プロセスとして起動し、既存の Docker sandbox 内の Claude と通信できるようにする。ユーザーは `agent = "claude"` と独立した `mode = "acp"`、stderr への診断出力、任意の `--log-file` を承認済み。人間の途中レビューは省略し、設計・実装・エージェントレビュー・検証を続ける。

## 公開インターフェイス

- Profile に `mode: "terminal" | "acp"` を追加する。Pkl の既定値は `"terminal"`。既存の TypeScript の Profile 入力で未指定なら terminal として扱う。
- `agent` は従来の値を維持する。今回 ACP をサポートするのは Claude のみ。他エージェントとの組み合わせは明確な設定エラーにする。
- プロファイル例: `["claude-acp"] = (super["claude"]) { mode = "acp" }`。既存プロファイルから認証・通信・マウント設定を継承する。
- `nas --log-file <path> claude-acp` は nas 自身の診断ログを追記する。ファイルはホストに作成し、新規作成時の mode は 0600。ファイルを開けなければ起動を失敗させる。ACP 本文、会話の transcript、子プロセスの stderr 全体はこのログ機能で記録しない。
- `--log-file` はプロファイル名より前の nas オプション。プロファイル名または `--` 以降はエージェント引数の領域として保持する。

## ACP の契約

1. stdout は ACP のみに使用する。nas の診断、設定読み込み、Docker build/pull、entrypoint と direnv の初期化出力は stderr。stdout を quiet 設定やファイルログ設定に依存させない。
2. stdin は ACP 専用で、ACP クライアントが pipe で接続する。terminal stdin は拒否する。nas の設定移行・プロファイル選択・worktree 確認には使わず、非対話起動で前準備が必要な場合は具体的な案内で失敗する。
3. ACP では TTY を強制的に無効化し Docker `-i` で起動する。継承した session.multiplex は利用せず、NAS_INSIDE_DTACH からの起動は拒否する。
4. 初期版は起動 cwd のワークスペースのみ。自動 worktree は拒否し、既存の worktree で nas 自体を起動することは可能。マウント先は現在と同じ絶対パスを維持する。
5. profile.agentArgs と CLI のエージェント追加引数は ACP では拒否する。guide.enable も、現在の --add-dir に依存するため案内付きで拒否する。設定は ACP クライアントと Claude settings で指定する。
6. ホストに導入済みの Claude native バイナリが必要。既存の認証・履歴マウントを利用し、初回ログインはホスト側で行う。ACP 起動中のインストーラ fallback は使わない。
7. adapter と実行環境はユーザーが用意する。nas はコンテナ内の PATH にある `claude-agent-acp` を起動し、既存マウントに対する `CLAUDE_CODE_EXECUTABLE` を指定し、nas proxy CA を Node に信頼させる。既存のプロキシ境界は変更しない。
8. stdin EOF と SIGINT/SIGTERM、および出力先の切断で Docker と子プロセスを終了し、既存 pipeline Scope の cleanup を走らせる。通常の非ゼロ終了を成功として隠さない。
9. nas は ACP を独自 UI として実装せず、adapter のメッセージを渡す。クライアントのファイル API や MCP、認証 command がホストで実行される可能性は調査し、sandbox の保証範囲を明記する。コンテナ内実行が保証されない経路を無条件に安全とは説明しない。

## アーキテクチャと変更範囲

設定 schema/validation → CLI のモード選択 → 既存 mount/proxy stages → LaunchOpts の明示的な stdio モード → Docker と adapter。

エージェントモジュールは既存の probe/pure configure 分離を維持する。追加の I/O を stage に置かない。stdout 分離と終了処理は CLI/プロセス境界に集約する。terminal 起動や JSON サブコマンドの stdout を壊さない。

## 検証

- unit: 既定値、未対応組み合わせ、引数、guide/worktree 制約、Claude mount/command、TTY 強制無効、ログファイルの境界とエラー。
- fake command によるプロセステスト: stdin/stdout の JSON メッセージ、初期化ログの分離、EOF・signal・非ゼロ終了。ネットワーク/LLM 認証なしで実行する。
- image/adapter 検証と実 Docker の有無を区別して報告する。Docker が無ければ実コンテナ・認証を伴う prompt 成功は未検証とする。
- fmt → lint → typecheck → unit を実行し、変更全体を別エージェントでレビューする。

## なぜこのアプローチを選んだか

Claude の認証、履歴、観測、通信ポリシーを共有するため、agent 種別ではなく起動モードを追加する。プロファイル名を claude-acp にできるので短い起動コマンドも保てる。

ログファイルは診断の利便性でありプロトコルの成立条件ではない。quiet だけでは子プロセスの stdout やエラー経路の汚染を防げないため、stdio 分離を実行モードの契約にする。

最初から任意エージェントの任意コマンドを起動する汎用インターフェイスにはしない。Claude CLI の引数を adapter に渡して無視させることや、worktree のパスを暗黙に変えることも避け、未対応機能は明示的に拒否する。
