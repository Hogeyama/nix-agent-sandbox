# サイトの編集設計

## 読者と主線

読者は AI エージェントで開発する人。nas の機能名や内部構成を知っていることは前提にしない。初回は設定を作って `nas claude` を起動し、自動起動した UI をホストのブラウザで開く。以後は作業中のセッション、承認要求、成果物、記録を UI で確認する。UI を起動するための別ターミナルは通常手順に含めない。

サイトは「使うか決める → 最初の作業 → 日々の操作 → 必要になった設定変更 → 終了とデータ管理」の順で読めるようにする。設定を全種類読んでから作業を始める構成にはしない。

前回は旧29ページを残したまま UI の説明を追加し、ページ内の手順の有無を確認しただけだった。この設計ではページ自体の存廃から見直す。ページ数の削減は合格条件ではない。

## ページの存在条件

- 読者の一つの作業・判断に答える。機能名が存在することは独立ページの理由にならない。
- 同じ作業の前提・設定・実行・結果確認は、機能紹介と設定例に分散させない。
- 日常の閲覧操作と、何を許可・保存するかの設定は分ける。
- 操作を危険にする条件は、その操作の前に置く。重複する注意一覧は作らない。
- 文中リンクは、次に読者が実行・判断するためのものだけにする。

## 新しいサイトマップ

ページタイトル、見出し、ナビゲーションは名詞句。パスは下表を正とする。

| パス | ページ | 読者の現在地 → 読了後 | 必要な答えの順序 |
| --- | --- | --- | --- |
| `/` | nas ユーザーガイド | 導入前 → 作業に使う価値と導入負担を判断 | 任せたい作業と懸念 → 人が決める範囲と UI での確認 → 対応環境と初回作業 |
| `getting-started/installation` | インストール | 導入を決定 → 実行環境の準備 | 前提 → 配布方法の選択 → 導入 → バージョン確認 |
| `getting-started/quick-start` | 最初の作業 | 導入済み → 応答と UI のセッションを確認して作業を終える | 設定作成 → API 許可 → 信頼と起動 → 質問と応答 → 自動起動した UI と画面例 → 終了 |
| `work/sessions` | 作業の開始・再開 | 一度起動済み → 対象セッションへの入力、再接続、別作業の起動 | Sessions の対象選択 → ターミナルの条件 → 再接続 → 新規作業のフォルダー・プロファイル・ブランチ選択 |
| `work/approvals` | 通信・ホスト実行の承認 | 要求が保留 → 適切な範囲で許可・拒否 | 要求の所在 → 通信の対象・範囲・操作 → ホスト実行の対象・範囲・操作 → 結果と次の判断 |
| `work/preview` | 開発サーバーの確認 | サーバーが起動済み → ページを確認して公開を解除 | 待ち受けと対象 → Bind → 表示された URL → Unbind → 接続できない条件 |
| `work/troubleshooting` | 作業中の問題と調査 | 応答や処理が止まった → 直す対象を決定 | Pending / 拒否 / 実行失敗の分岐 → Audit の対象特定 → 詳細理由 → UI 接続・入力の問題 |
| `work/history` | 過去の作業と利用量 | 過去の処理を確認したい → 会話・実行・利用量を確認 | History の会話選択 → 処理・関連実行 → 利用量 → 記録の不足 |
| `work/finish` | 作業の終了と片付け | 作業済み → 必要な変更を残して終了・不要環境の削除 | 残す変更 → 終了と切り離しの違い → worktree の保存・削除 → 補助コンテナ → 異常終了の残存データ |
| `configuration/profiles` | 設定の変更と反映 | 設定変更が必要 → 正しい編集先へ追加して確認 | 一時承認との違い → ファイルとプロファイル → 初期生成・編集済みへの追加 → 別名 → トップレベル → 再信頼と反映 |
| `configuration/network` | 外部への通信許可 | 必要な API / 配布元が使えない → 必要な要求だけ許可・承認待ち | 接続先と要求 → scope / rule の追加 → review と deny → 認証 → ツール側のプロキシ設定 |
| `configuration/files` | ファイルの共有と非公開 | 読ませる範囲を変えたい → 共有・ファイル非公開・値のマスクを設定 | 既定共有 → 追加共有の権限 → 全体非公開と部分マスクの選択 → 各設定と確認 → 編集への影響 |
| `configuration/host-commands` | ホストコマンドの実行許可 | ホストのツールや認証が必要 → 範囲を絞って実行・承認を確認 | ホスト権限と入力の保護 → 固定コマンドの許可 → 明示委譲 → 秘密値付きのビルド → 相対パスの条件と一回承認 |
| `configuration/host-services` | ホストの DB・API への接続 | ホストのサービスが必要 → コンテナから指定サービスへ接続 | 方向とサービス側認証 → ポート設定 → 接続先 → 解除と適用範囲 |
| `configuration/authentication` | ホストの認証情報の利用 | 保存済み認証が必要 → 値の注入か認証設定共有を選んで設定 | 値を読ませるか → HTTP / ホスト実行への注入 → クラウド設定・GPG → Codex キーリングと取得可能範囲 |
| `configuration/development` | 開発ツールと Docker | テストに必要なツールがない → Nix 環境・パッケージ・Docker を利用 | 利用する環境の選択 → Nix と確認 → Docker と取得許可 → 寿命とキャッシュ → イメージ再構築 |
| `configuration/gui` | GUI アプリの表示 | エージェント側アプリの画面が必要 → xpra で表示・操作 | ホスト/コンテナの前提 → 設定 → 起動と自動接続 → 入力共有 → 表示失敗と終了 |
| `configuration/notifications` | 入力待ちの通知 | 複数作業中に待ちを見逃す → エージェントの入力待ち通知を設定 | nas の承認との違い → notify → 使用エージェントの hook → 状態と通知の確認 |
| `configuration/recording` | 記録と保存期間 | 記録の内容と寿命を決めたい → 会話・利用量・通信本文を設定し削除を管理 | 既定で残るもの → 追加記録の内容と設定 → 二つの保存先 → 保持と削除の違い |
| `security/isolation` | 隔離の範囲 | 環境や設定を評価 → コンテナ外へ影響する範囲を判断 | 既定共有 → 設定の信頼 → 追加権限の比較 → 秘密と承認の分離 → 共有サービスと限界 |

GUI は Nix / Docker と分ける。必要なホストの画面環境、xpra への入力、表示失敗の調査まで一つの作業であり、通常のツール導入とは確認方法が異なるため。入力待ち通知も、セッションの選択とは異なるエージェント設定を編集する作業なので独立させる。

一方、相対パス実行と秘密値付きのビルドはホスト実行の選択肢として同じページに置く。独立した例のファイルを残すこと自体を目的にしない。ファイル非公開・マスクの一般手順は files にあり、ホスト実行ページではそのビルドを成立させる最小の完成例だけを示す。

## 旧ページの処遇と情報の移動先

| 旧ページ | 処遇と移動先 | 失ってはいけない情報 |
| --- | --- | --- |
| index | 紹介の目的から再執筆 | 誇張のない作業の変化、対応環境、設定負担 |
| getting-started/installation | 維持 | 対応バイナリ、Docker 実行権限、導入確認、自己展開 |
| getting-started/quick-start | 初回作業として再執筆 | 具体的な編集位置、API 許可、trust、応答、自動 UI、画面例、終了 |
| getting-started/configuration | configuration/profiles へ移動・再執筆 | extendProfile、設定継承と一覧置換、トップレベル、再信頼 |
| features/ui | 独立ページ廃止。work/sessions、troubleshooting、profiles、isolation に分解 | 自動起動、操作可能条件、手動起動・停止、ui 設定、同一ホストのアクセス |
| features/sessions | work/sessions と configuration/notifications に分割 | dtach 前提、detach/attach、hook の全エージェント例 |
| features/worktree | work/sessions と work/finish に分解 | 基準ブランチ、onCreate、未コミット変更、終了時の統合と削除 |
| operations/approvals | work/approvals に再執筆 | Network Deny の範囲、HostExec 一回拒否、同条件保留要求、パスを含まない再利用 |
| features/port-bind | work/preview に再執筆 | Bind / URL / Unbind、127.0.0.1、ホストポート自動選択、接続失敗、終了時解除 |
| features/observability | work/history と configuration/recording に分割 | 記録される条件、収集失敗、本文の機密性、31日と null、DB削除 |
| operations/audit | work/troubleshooting と configuration/recording に分割 | Audit の列と絞り込み、UIにない reason、保存前本文、本文削除と判定ログの違い |
| operations/maintenance | work/finish と configuration/development に分割 | 使用中worktreeも削除対象、-B の範囲、補助コンテナの使用中判定、rebuild |
| features/filesystem | configuration/files に統合 | ro/rw、既定共有、マウント基準パス、不在src、空ファイルによる非公開 |
| features/secrets | files / authentication / network / host-commands / recording に役割分解 | 登録とマスクの違い、取得元、mask.apply、編集影響、認証共有 |
| features/network | configuration/network に再執筆 | scope選択、match/expect、fallback、WebSocket、secret処理、ヘッダー注入 |
| recipes/proxy-tools | network の JVM 向け手順に統合 | プロキシ指定と許可は別、18080予約、追加配布元、秘密をOPTSへ書かない |
| features/hostexec | configuration/host-commands に統合 | ホスト権限、installScript、rule、環境、変更可能入力、fallbackの実効性 |
| recipes/relative-hostexec | host-commands の相対パス手順に統合 | workspace-only が子ディレクトリを許す、変更警告、一回承認 |
| recipes/mask-env | host-commands の秘密値付きのビルド手順に統合 | 読む入力を変更させない、マスク用と注入用の二重登録、完成例と確認 |
| features/port-forwarding | configuration/host-services に再執筆 | 逆方向との区別、転送先認証、HTTP認可なし、同番号と予約ポート |
| recipes/codex-keyring | authentication のキーリング手順に統合 | 保存済み認証、DBus条件、3メソッド、Codex以外の秘密も取得可能 |
| features/nix | configuration/development に統合 | /nix自動有効、daemon共有、devShellと追加パッケージ、無効化 |
| features/docker | configuration/development に統合 | 専用daemon、privileged補助、取得許可、データとキャッシュの寿命 |
| features/display / recipes/x11-apps | configuration/gui に統合 | ツール前提、専用画面、自動attach、WSL条件、入力共有、終了 |
| security/model / security/risks | security/isolation に統合 | 共有範囲、設定信頼、全追加権限、承認ソケットの分離、残る限界 |
| security/recommendations | 独立ページ廃止。各設定・操作の前提へ | 読取専用、ホスト入力保護、秘密値、データ保持、終了前確認 |
| security/limitations | 独立ページ廃止。profiles / authentication / development / gui / recording / finish へ | TTY・非対話trust、ツール不足時動作、未回収のmask-secrets、既知fallback |

日常操作に CLI コマンド一覧は付けない。UI では完了できない調査・設定・回収だけに CLI を残す。特に Docker でセッション ID を探す手順は復活させない。

## 撮影と検証

- 最初の作業の UI セクションには、画面全体のスクリーンショットを本文と隣接して掲載する。操作名を説明せず画像だけ置くのも不可。
- 承認、ポート公開、履歴・調査の画像は、その判断に必要な箇所を写す。例示データなら本文で明示する。
- 独立レビュアーはまずページ構成を評価し、原稿完成後は導入・承認・成果確認・設定変更・終了の読者経路を通して評価する。リンクがあるだけで到達できたと判定しない。
- Pkl の全例を掲載位置に応じて評価する。既存設定を残す例は、継承先の通信・マウントが残ることも確認する。
- ビルドとリンク検査、旧 URL の到達先、画面幅ごとの表示は文章レビューと別に検証する。

## 情報の正本と例外

- 名前付き秘密の `from`、`required`、`lines:` / `cmd:` の制約は authentication が正本。files はマスクを成立させる具体例、network は HTTP 注入、host-commands はコマンド注入の完成手順を担当する。authentication に注入のコードを複製しない。
- `multiplex` / `detachKey` / `worktree.base` / `onCreate` は work/sessions の該当作業の節に収容する。再接続を可能にする設定と作業フォルダー作成の準備は、その操作の前提なので、設定ページをさらに増やさず完結させる。`onCreate` がホストで実行される注意を設定例の前に置く。
- `ui.enable` / `ui.port` / `ui.idleTimeout` は profiles の「UI の設定」で扱う。手動起動、ブラウザで開けない場合、UI だけの停止は troubleshooting に置く。
- Codex キーリングの前提は Claude 用の通信設定へ誘導しない。codex プロファイルに設定すること、`nas codex` で試すこと、未許可の API 接続先を Audit で確認して network の「接続先の追加」に進むことを明示する。第三者サービスの接続先を推測した固定リストは載せない。
- troubleshooting は冒頭で症状ごとに該当節へ進める。UI を開けない読者に Audit の操作を先に要求しない。
