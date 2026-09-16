# 承認保留の購読コマンド

## 目的と合意

ACP クライアント（Emacs 等）から hostexec / network の承認保留を検知できるようにする。

ACP モードでは Claude 自身のツール使用許可は adapter が `session/request_permission` としてエディタへ流すが、nas 自身の承認（hostexec のホスト実行、network の未許可ドメイン）はデスクトップ通知と Web UI にしか出ない。通知バックエンドが無く `ui.enable = false` の構成では、エージェントが `timeoutSeconds`（既定 300 秒）まで無言で停止し、利用者からは原因の分からないハングに見える。

承認の操作面は既に `nas <domain> approve|deny` が持っている。欠けているのは「保留が発生したことに気づく手段」だけなので、購読専用の読み取りコマンドを同じ CLI 面に追加する。

成果物は nas 側に限定する。Emacs パッケージや elisp サンプルは今回の範囲外。

## 公開インターフェイス

```
nas network  watch [--session <id>] [--runtime-dir DIR]
nas hostexec watch [--session <id>] [--runtime-dir DIR]
```

ホスト側で、nas セッションを起動したのと同じユーザーとして実行する。コンテナ内からは利用できない（pending ディレクトリも control socket もコンテナへマウントしない）。

停止するまで stdout へ JSON Lines を書き続ける。1 行が 1 イベントを表す。

```json
{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a1","requestId":"req_7","ruleId":"gcloud","cwd":"/home/u/proj","argv0":"gcloud","args":["auth","print-access-token"],"createdAt":"2026-09-16T04:12:03.114Z"}}
{"event":"removed","domain":"hostexec","sessionId":"sess_a1","requestId":"req_7"}
```

- `entry` は `pending --format json` が出力する構造化ペイロードと同一にする。両コマンドで形が違うとクライアントがパーサを 2 つ持つことになる。
- この統一に伴い hostexec 側の構造化ペイロードへ `createdAt` を追加する。現在は network 側だけが持っていて揃っていない。フィールドの追加なので後方互換。
- `removed` に消滅理由は付けない。pending ファイルの消滅からは承認・拒否・タイムアウトを区別できず、区別するには audit DB を引くことになり、読み取り専用の購読が audit store に依存する。
- 購読開始時点で存在する pending は `added` として流す。購読開始時の状態と以後の変化を 1 種類のイベントで扱える。
- `--session <id>` は対象セッションを 1 つに限定する。既定は全セッション。

## 動作の契約

1. ポーリング間隔は 1 秒固定。フラグで変更できるようにはしない。人間が待っている用途では十分速く、通常は空ディレクトリの readdir なので負荷は無視できる。
2. 既存の `listPending`（内部で `gcRuntime` を呼ぶ）をそのまま使う。UI daemon の SSE が既に 2 秒間隔で同じ経路を叩いており、watch が 1 秒で呼ぶことは新しい振る舞いではない。ドメインサービスの API は変更しない。
3. 1 回のポーリングが失敗しても購読を切らない。stderr へ警告を出して次のティックへ進む。ここで終了すると、一時的なファイルシステムエラーでエージェントがタイムアウトまで停止する。
4. runtime dir が存在しない状態での起動を正常系として扱う。既存の `listPendingEntries` は ENOENT を空配列として返すため、nas セッション開始前から購読を張れる。
5. `added` は `createdAt` の昇順で出力する。既存の `listPendingEntries` がこの順で返す。
6. SIGINT / SIGTERM と stdout の切断（EPIPE）で終了する。
7. stdout は JSON Lines 専用。警告と診断は stderr へ出す。

## NAS_SESSION_ID の正規化

ACP クライアントは起動時に `NAS_SESSION_ID` を指定して自らセッション id を決め、同じ値を `--session` に渡す。これにより、複数プロジェクトの nas セッションを同時に開いていても、各クライアントが自分のセッションの承認だけを拾える。

この環境変数は `src/cli.ts:314` が既に入力として尊重しているが、ドキュメントに記載がない。加えて ACP モードには落とし穴がある。`spawnAcpSessionReaper` が受け取る id を reaper 側が `/^sess_[0-9a-f]+$/` でしか受け付けないため（`src/cli/acp_reaper.ts:22-24`）、この形式から外れた値を渡すと Docker リソースの回収が黙って止まる。

`validateAcpInvocation` に形式検証を追加し、ACP モードで不正な値が指定された場合は起動時に明示的に失敗させる。terminal モードは reaper を使わないため検証対象としない。

## アーキテクチャと変更範囲

差分計算は純粋関数として切り出す。純粋なデータ整形にサービスは作らない（effect-separation）。既存の `src/ui/routes/sse_diff.ts` が純粋関数のまま置かれているのと同じ形にする。

```
src/cli/approval_watch.ts        新規: diffPending（純粋）+ runApprovalWatch（依存注入）
src/cli/approval_watch_test.ts   新規: unit
src/cli/approval_command.ts      watch ケースを追加
src/cli/hostexec.ts              構造化ペイロードへ createdAt を追加
src/cli/acp.ts                   NAS_SESSION_ID の形式検証
src/cli/usage.ts                 watch を記載
docs-site/src/content/docs/configuration/acp.md   承認購読の節を追加
```

`runApprovalWatch` は `listPending` と sleep と書き出し先を引数で受け取り、実時間とファイルシステムなしで検証できるようにする。

`handleApprovalSubcommand`（`src/cli/approval_command.ts`）へ `watch` ケースを追加し、既存の `ApprovalAdapter` 経由で両ドメインへ同時に効かせる。ドメイン固有の実装は増やさない。

## セキュリティ

- 制約 C2 の境界は変わらない。watch はホスト側の pending ファイルを読むだけで、control socket にも exec socket にも触れない。コンテナからは到達できない。
- 出力に含まれる argv・cwd・host・port は `nas <domain> pending` が既に表示している内容と同一で、新たな露出は増えない。

## 検証

unit レーンに収める。Docker に触れないためファイル名は `approval_watch_test.ts` とする。

- 純粋関数: 追加のみ、削除のみ、同時発生、変化なし、`createdAt` 順の出力、セッションフィルタ。
- ループ: fake の `listPending` を注入し、初回の全件 `added` 出力、ティック失敗時の継続、停止シグナルでの終了を検証する。
- 実ファイル経由の経路は `--runtime-dir` に一時ディレクトリを渡して 1 本だけ確認する。テストポリシーが unit での temp dir を許可しているためレーンは移らない。
- `validateAcpInvocation` の `NAS_SESSION_ID` 検証を既存の `src/cli/acp_test.ts` に追加する。

最後に fmt → lint → typecheck → unit を実行する。

## なぜこのアプローチを選んだか

承認は同一ホスト・同一ユーザーに限定された操作である。pending ファイルは 0600、control socket はコンテナへマウントしない。HTTP が subprocess より優れている点は基本的に遠隔性だが、その遠隔性はこの機能の脅威モデルが明示的に禁じている。したがって HTTP の対価（ポート探索、デーモンの生存管理、Origin の作法、認証方針の決定）を払う理由がない。

購読と操作が同じ CLI 面に揃うことも決め手になった。クライアントは `nas <domain> watch` で待ち、`nas <domain> approve` で応じる。語彙が 1 つで済み、契約を説明しやすい。

`handleApprovalSubcommand` という既存の共通化点があるため、1 ケースの追加で両ドメインを賄える。実装量が最小で、network と hostexec の挙動が構造的に揃う。

`ui.enable = false` でも動くことも重要である。ACP を使う利用者は Web UI を開かない前提であり、その利用者が真っ先に切りそうな設定に購読経路をぶら下げる設計は筋が悪い。

## なぜ他の案を選ばなかったか

- **案 B: 既存の `/api/events` SSE をそのまま公開契約にする** — 追加実装ゼロで済むが、承認専用のストリームではない。1 接続ごとに 2 秒周期で 7 種類のスナップショットを取り直し、audit ログ 200 行の SQLite クエリまで走る（`src/ui/routes/sse.ts:70-100`）。差分状態は接続ごとに独立しているため、購読者が増えた分だけこの処理が増える。UI を開かない利用者に UI のための負荷を払わせることになる。ペイロードもフロントエンド都合の形のままで、`sessions` だけ `{items}` でラップしない非対称が `sse_diff.ts:82-94` に「deliberate」として残っており、公開契約にするとこの歪みが固定される。さらに `ui.enable = false` で丸ごと消える。

- **案 C: 承認専用の SSE エンドポイントを UI daemon に新設する** — 案 B のペイロードと負荷の問題は解けるが、UI daemon への依存が残るため `ui.enable = false` の問題が解けない。加えて認証方針を決める必要が生じる。現在 GET はループバックの Host だけで通り、POST の approve/deny も Origin を見るだけである（`src/ui/security.ts:84-94`）。ターミナル中継の WebSocket はトークンを要求しているのに、hostexec 承認（ホストでのコマンド実行の許可）の方が緩いという非対称があり、内部エンドポイントである限りは通るが外部連携の公開契約にするなら正面から決める必要が出る。今回の目的に対して判断すべきことが多すぎる。

- **案 D: クライアントが pending ディレクトリを直接 inotify で監視する** — nas 側の変更が不要で遅延も最小になるが、公開契約が存在しない。`$XDG_RUNTIME_DIR/nas/<domain>/pending/<sessionId>/<requestId>.json` というレイアウトを外部クライアントが前提にすることになり、内部実装を変えられなくなる。

- **案 E: nas 承認を ACP ストリームへブリッジする** — エディタに承認がそのまま出るため体験は最良だが、転送層を byte-preserving に保つ既存の設計判断と正面から衝突する。`src/docker/protocol_command.ts:14` は「No parsing, logging, masking or transcript capture」と明記し、設計仕様 `docs/superpowers/specs/2026-09-15-claude-acp-design.md:25` も「nas は ACP を独自 UI として実装せず、adapter のメッセージを渡す」と決めている。JSON-RPC フレームの解釈を持ち込むには設計仕様の見直しが要る。今回は採らない。

- **案 F: イベントではなくスナップショットを流す** — 1 行に pending 集合の全体を載せる形は冪等で取りこぼしに強いが、「どれが新着か」の差分をクライアント側が持つことになる。プロンプトの表示と消去が用途の中心なので、差分の方が使う側の記述量が少ない。ポーリング差分では added と removed を同じ計算で得るため、実装コストの差も生じない。

- **案 G: `nas watch` として両ドメインを 1 本にまとめる** — Emacs は 1 プロセスで済むが、承認側は `nas network approve` / `nas hostexec approve` のままなので、購読と操作でコマンド体系がずれる。また既存の `handleApprovalSubcommand` に乗らないため実装量が増える。

- **案 H: ポーリング間隔を `--interval-ms` で調整可能にする** — 契約面が 1 つ増え、検証と usage の記述も増える。人間が承認を待つ用途で 1 秒より短くする動機がない。
