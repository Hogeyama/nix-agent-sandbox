# Bash の隔離内から DinD を使う

## 利用者ができること

nas の DinD を有効にした状態で、Claude Code の Bash sandbox の中から従来どおり `bun test` などを実行する。Testcontainers の Docker API 操作と、起動したコンテナの公開 TCP ポートへの接続が動く。`excludedCommands` や追加のコマンド接頭辞は不要にする。nas が生成する `/nas-sandbox` スキルに、動作条件と失敗時の確認方法を載せる。

## 構成

nas と DinD が共有するネットワーク空間に、Unix ソケットでだけ要求を受ける gateway を置く。gateway が提供するのは、セッションの Docker API をバイト列のまま中継する入口と、TCP 接続の中継の二つだけである。TCP の接続先は、dockerd が公開ポートの既定アドレス（`--ip`）として使う専用の loopback アドレス `127.0.0.77` に固定する。要求が指定できるのはポート番号だけで、任意のホスト名、IP アドレス、nas の他の loopback サービスへは接続できない。

隔離された network namespace ごとに、常駐の relay を一つ置く。relay は Docker API を namespace 内の Unix ソケットで提供し、`127.0.0.77` に公開されたポートを namespace 内の `127.0.0.1` に再現する。公開ポートの一覧は `/containers/json` から取り、定期的に同期する。start/restart の応答は、作られたポートを再現し終えるまで保留し、Testcontainers が公開ポートを知ってから最初に接続するまでの競合を避ける。既存のポートと衝突した場合は別サービスへ接続させず、そのポートを再現しない。

nas の Bash ラッパーは、コンテナ起動時に記録した namespace と現在の namespace を比較する。異なる場合は、その namespace の relay を abstract Unix ソケットの名前で探す。名前は namespace に属し relay と共に消えるので、`/proc/self/net/unix` を Bash の組み込み機能だけで読めば、プロセスを起動せずに生存を確認できる。relay がいなければ起動してから、`DOCKER_HOST` を relay へ向けて Bash を `exec` する。Bash の親にはならないので、引数、終了コード、シグナル、ファイル記述子、ジョブ制御は通常の Bash と同じである。`SANDBOX_RUNTIME` などの環境変数を権限判定には使わない。

マスク機能と中継の有効条件を分離し、マスクを無効にしても DinD の中継は使えるようにする。通常の起動、対話シェル、Dev Container の共通 entrypoint に組み込む。

## 境界と寿命

- 中継が使う Docker API は、ホスト Docker ではなく、その nas セッションの DinD に固定する。
- DinD の通信には引き続き `docker.networkScopes` を適用する。agent のトークン、承認、OAuth を渡さない。
- gateway は TCP 接続を `127.0.0.77` にしか張らない。このアドレスで待ち受けるのは dockerd が公開したポートだけなので、どのコンテナのポートかを Docker の状態から証明する必要はない。外側の namespace で任意のプロセスを実行できる攻撃者がこのアドレスで待ち受けるケースは対象外とする。
- `0.0.0.0` や `127.0.0.1` を明示して公開したポートは中継しない。
- relay は、PID namespace を分ける sandbox ではコマンドの終了と共に消える。それ以外の環境では、接続も要求もない状態が続くと終了する。強制終了された relay が残すファイルは、次の relay が名前を確保してから置き換える。
- 中継の失敗で奪うのはそのコマンドの Docker 利用だけで、コマンド自体は警告を出して実行を続ける。隔離を外すフォールバックはしない。
- 初回は Linux、IPv4 loopback、公開 TCP ポートを対象にする。UDP と、コンテナからテストプロセスへの逆向き接続は対象外。

## 検証

Unix API（本文、ストリーム、hijack、long-poll）、動的な公開 TCP ポート、同一 namespace の入れ子と別 namespace の入れ子、relay の同時起動と強制終了後の再起動、ポート競合、停止、`127.0.0.77` 以外への接続の拒否を検証する。

実際の bwrap と Docker を使い、通常の namespace では接続できるが内側では直接接続できない対照を置く。ラッパー経由で Testcontainers がコンテナを起動し、公開ポートを使い、後片付けできることを確認する。通常の Bash と出力マスクの既存テストも維持する。最終確認は AGENTS.md と post-change-checks に従い、制限付き実行とホスト実行を順に行って結果を分けて報告する。

## なぜこのアプローチを選んだか

最初の実装は、公開ポートを外側の `127.0.0.1` から中継し、そこにある nas の他のサービスと区別するために、start ごとに listener の inode を記録して照合していた。Bash ラッパーは namespace ごとに Bun の supervisor を Bash の親として挟んでいた。どちらも、競合検出、ファイル記述子の引き継ぎ、親の死の伝搬、シグナルとジョブ制御の再現といった付随的な複雑さを生み、そこから実際の不具合が出た。公開先を専用アドレスに固定すれば認可は転送先の固定だけで済み、relay を常駐にすれば Bash の振る舞いを再現する必要がなくなる。

既存の host–nas の port-forward と同様に、Unix ソケットを使って隔離境界をまたぐ。公開ポートの中継だけを足すため、Bash の外向きネットワーク制限を維持できる。

`node` や `bun` の除外は任意のテストコードを隔離の外で実行するため採用しない。専用コマンドの手動指定と `CLAUDE_CODE_SHELL_PREFIX` の追加設定は、既存の Bash ラッパーへ組み込むことで不要にする。srt 固有の環境変数だけに依存せず、必要な性質である namespace の違いを判定する。
