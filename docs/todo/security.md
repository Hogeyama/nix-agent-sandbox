# TODO（セキュリティ・監査の残り）

nas の未対応の課題。各項目の `[検証]` は 2026-07-12 の裏取りで現行コードに対して確認した結果。

凡例: **P1**=近いうち / **P2**=中期 / **P3**=低

| 優先 | 項目 | 種別 | 工数 |
|---|---|---|---|
| **P1** | H2 認証情報ディレクトリの RW 共有 → host persistence | Sec | 中〜大 |
| **P1** | `/nix` RW マウント | Sec | 小〜中 |
| **P2** | DinD sidecar `--privileged` | Sec | 中 |
| **P2** | workspace RO 保護の残る穴 | Sec | 小〜中 |
| **P2** | SSRF の拒否範囲の残り | Sec | 小 |
| **P2** | migrate.ts ~1900 行の整理 | Refactor | 中 |
| **P3** | 承認画面で引数の境界と平文 request の inject 省略が見えない | UX/Sec | 小 |
| **P3** | L4〜L7、重複・分割・堅牢化・CLI UX の各種 | 各種 | — |
| — | OTEL / history のフォローアップ | 各種 | — |

---

# Security

## P1

### H2. `~/.claude` 等の RW 共有 → agent が hook を仕込んで host persistence

- **脅威**: in-container agent が `~/.claude/settings.json` の `PreToolUse`/`Stop` hook を書き換え、
  ユーザが次回 **host 上で直接** `claude` を起動した瞬間に host 任意コード実行。
- **現状**: `profile.agentState.protectSettings = true`（既定 false）で、Claude は `~/.claude` の設定・plugins・
  skills・agents・commands・hooks 等を RO で共有し、認証・履歴・projects（auto memory を含む）だけを RW 共有する。
  Codex / Copilot は実在する設定ファイルだけを RO overlay する。
- **残る穴**:
  - **`~/.claude.json` の `mcpServers`** — 実行中の更新用に RW 共有する。
    ホスト・コンテナの両方で managed settings に `allowManagedMcpServersOnly: true` と
    `allowedMcpServers: []` を配置すれば、このファイルからの MCP 起動を拒否できる。nas は自動設定しない。
  - **workspace 内の `.claude/settings.json`・`.github/hooks/`** — RW のまま。user scope と違い当該リポジトリ限定なので
    severity は低い。
- **未検証**: コンテナ内 claude は起動時に一度 `~/.claude/settings.json` を書く（内容は同一）。
  RO 化で EROFS/EBUSY をどう扱うかは実測していない。VS Code 拡張ではエラーになったため既定を false にした。

### `/nix` が RW マウント

- [検証] CONFIRMED `src/stages/mount/stage.ts:209`（`:ro` 無し）。
  コンテナ root 奪取で `/nix/store` 汚染 → ホスト/他セッション RCE。
- 無条件 RO 化は `nix develop` 等のキャッシュ書込みを壊す可能性がある。
  daemon 経由なら RO で動くはずだが edge case 未検証のため、`nix.readOnly` オプションとして扱う。

## P2

### DinD サイドカーが `--privileged`

- [検証] CONFIRMED `src/docker/dind.ts:484`。rootless なら通常不要。

### workspace RO 保護の残る穴

`.git` の config・hooks・`core.hooksPath`・worktree ポインタと `.nas` は RO にしたが、次は対象外。

- workspace のパスが symlink を通ると、git が返す解決済みパスと一致せず `core.hooksPath` や
  worktree ポインタが保護から漏れることがある。
- サブディレクトリに新しく作った `.git`、非 repo の workspace での `git init`、submodule の
  `.git/modules`、起動後に作られた `config.worktree`。
- nas worktree の中の `.nas/config.pkl` は RO にならない（worktree 作成前に探すため）。その worktree
  から後で nas を起動すると、既存の trust ゲートが内容の変化を検知して再確認する。

### SSRF の拒否範囲の残り（H5/H6）

- 拒否範囲は TS と addon で同じで、multicast・`198.18.0.0/15`・NAT64（`64:ff9b::/96`）・
  6to4（`2002::/16`）に埋め込まれた private IPv4 は拒否しない。
- proxy container に IPv6 の経路が無いときに最初の許可 IP が IPv6 だと、IPv4 に fallback せず接続に失敗する。

### コンテナ権限ハードニングの未確認点

- VS Code Dev Containers が `docker exec` で root の処理をする場合に、戻した 6 つ以外の capability が要るか。

## P3

### 承認画面の表示

- hostexec の承認画面は引数を空白で連結して表示するので、承認する人に引数の境界が見えない
  （CLI の `--format json` は配列で出る）。
- network の承認カードには、平文 HTTP の request でも inject のプレビューが出る（実際には付かない）。

### Low

- **L4: xterm ClipboardAddon で OSC 52 クリップボード乗っ取り** — [検証] CONFIRMED
  `src/ui/frontend/src/terminal/attachTerminalSession.ts:600`（`loadAddon(new ClipboardAddon())`）。
- **L5: `src/log.ts` に秘密リダクション無し** — [検証] CONFIRMED（`:20-42` は console 素通し）。
- **L6: hostexec workspaceRoot/sessionTmpDir が `path.resolve` のみ、cwd は realpath** — [検証] CONFIRMED
  `src/hostexec/broker.ts:132-133` vs `:805-808`。symlink 混在で containment ミスマッチ → 主に**誤拒否**。
- **L7: グローバル `closeNotification()` が別グループの pending を消す** — [検証] CONFIRMED
  `src/lib/notify_utils.ts:135-140`（module-global）を hostexec `broker.ts:506` / network `broker.ts:512`
  が無条件呼び出し。並行 pending 時の UX バグ。

---

# 非セキュリティ（全体監査の残り）

## デッドウェイト削減

- [ ] **P2: レガシー移行コード ~1900 行の整理**。[検証] CONFIRMED。`src/config/migrate.ts`（**791 行**）+
  `migrate_test.ts`（**1102 行**）が YAML→Pkl / Nix→Pkl 変換を保持、`nix eval --impure` シェルアウト
  （`migrate.ts:437,447,453`）含む。CHANGELOG で Pkl-only 宣言済み。CLI 配線 `src/cli/config.ts:84-91`。
  別コマンド切り出し or 削除候補。残す場合 `findYamlConfig`/`findNixConfig`（`:279`,`:313`）を 1 本化。

## 重複の集約（P3）

- [ ] **ランタイムディレクトリ解決が 6 重実装**。[検証] CONFIRMED。ヘルパー
  `resolveRuntimeSubdir`（`src/lib/runtime_dir.ts:10`）は maskfs のみ使用。`proxy/stage.ts:449`・
  `hostexec/stage.ts:430`・`dbus_proxy/stage.ts:297`・`display/stage.ts:146` が同ロジックをインライン再実装、
  さらに `defaultRuntimeDir`（`fs_utils.ts:132`）が `XDG_RUNTIME_DIR` 直読み。
- [ ] **エージェントアダプタの fs ヘルパー逐語コピー**。[検証] CONFIRMED。`findBinaryResolved`
  （`claude.ts:108`/`codex.ts:78`/`copilot.ts:83` byte一致）、`dirExistsSync`（`claude.ts:86`,`codex.ts:66`）、
  `fileExistsSync`/`pathExistsSync`。`src/lib/fs_utils.ts` に sync 版を足して集約。
- [ ] **UI/history の重複**。[検証] CONFIRMED（4点）。`createPollingStream`（`history_sse.ts:91`）は history のみ、
  `/api/events`（`sse.ts:21-25`）は手書き。承認検証ラダー 4回コピペ（`api.ts:~178-263`）→ `parseApprovalBody`。
  `POST /launch`（`api.ts:137-162`）だけ `withErrorHandling` を使わず手 try/catch。`App.tsx:331-336`/`358-363`
  の `onRename` closure byte 一致 → hoist。
- [ ] **ステージの identity accessor コピペ**。[検証] CONFIRMED。`resolveWorkspace`（`hostexec:449`/
  `docker_build:85`/`mount:574`）、`resolveContainerBase`（`hostexec:466`/`proxy:503`/`mount:631`）。
  `addMount` は 2 箇所でシグネチャ相違（`mount/stage.ts:638` 4引数 void push vs `hostexec/stage.ts:473`
  3引数 string 返し）→ 統一。

## 巨大ファイル分割 / 構造（P3）

- [ ] **`conversationDetailView.ts`（1078 行）分割**。[検証] CONFIRMED。ターンイベントタイムラインパーサ
  （`toTurnEventView:830`/`buildTurnEvents:893` 他）が自己完結で切り出し容易。
- [ ] **`history/store.ts`（1073 行）reader/writer 分離**。[検証] CONFIRMED（接続 `:82-171` / writer / reader
  混在）。reader を `store_reader.ts` へ（テストは `store_reader_test.ts` で境界あり）。
- [ ] **`mount/stage.ts` の `planMount`（~129-523）を独自モジュールへ**。[検証] CONFIRMED。最リスクの純関数。

## 型・堅牢性（P3）

- [ ] **`cherryPickDetached` が nested-provide アンチパターン**。[検証] CONFIRMED（
  `src/stages/worktree/git_worktree_service/cherry_pick.ts:330-386`）。`proc` 直受け + inline
  `proc.exec`/`gitExec` + `Effect.provide(makeTmpCherryPickOpsLayer(proc))`（`:370`）。
- [ ] **`display_service.ts` の silent catchAll**。[検証] CONFIRMED `:268`,`:418`
  （`catchAll(() => Effect.void)`）。`Effect.either` か `logWarning` を挟む。
- [ ] **agent registry の runtime duck-typing**。[検証] CONFIRMED `registry.ts:59-82`
  （`"claudeDirExists" in probes` 等）。`AgentProbes`（`types.ts:26`）は discriminant 無しの bare union。

## CLI / テスト UX（P3）

- [ ] **サブコマンド `--help` が global usage しか出さない**。[検証] CONFIRMED `src/cli.ts:137-143`。
- [ ] **`hostexec` だけ arg source が非対称**。[検証] CONFIRMED。`cli.ts:187` が `removeFirstOccurrence`
  で `--` 以降含む全 args、他は `argsBeforeDashDash`（`:160,167,174,181,192,197,209`）。潜在バグ源。
- [ ] **`nas config` が引数なしで throw**。[検証] CONFIRMED（`cli/config.ts:101`）→ usage 化。
- [ ] **CLI ハンドラの unit test 欠如**。[検証] CONFIRMED。`cli/{container,session,network,worktree,audit,
  hostexec,usage}.ts` に test 無し（`config.ts` は `config_test.ts` あり）。
- [ ] **純粋な agent テストが integration に誤分類**。[検証] CONFIRMED。`agents_integration_test.ts`
  の `configureClaude/Codex/Copilot`・`resolve*Probes` は Docker 不要 → `agents_test.ts` へ。

---

# OTEL / history のフォローアップ

ADR: `docs/adr/2026042901-observability-otel-history.md`。

- [ ] **会話履歴 / prompt content キャプチャの opt-in 化**。現状は
  `observability.capture-content` フラグ無しで**無条件**キャプチャ（`src/agents/observability.ts:127-128,135`
  が `OTEL_LOG_USER_PROMPTS`/`OTEL_LOG_TOOL_CONTENT`/`..._CAPTURE_MESSAGE_CONTENT` を常時 inject）。
  ADR 提案の profile フラグ gating は未実装。**プライバシー観点で優先度中**。
- [ ] **実走 OTLP fixture**。`src/history/fixtures/*.json`（7 本）は provenance 未記載
  （README/コメント無し、手書き想定）。実 Claude/Copilot fixture で置換し attribute drift 検知を早く。
- [ ] **ADR 本文の `OTEL_METRIC_EXPORT_INTERVAL` 更新**。コードは 5000ms 確定
  （`observability.ts:96`）だが ADR "Open questions"（`docs/adr/…:419-421`）が「実装時に決める」のまま。
- [ ] **signal handler**。SIGINT/SIGTERM/uncaughtException で
  `recordInvocationEnd` が呼ばれず `ended_at` NULL のまま。`src/cli.ts:343-345` に「trade-off」コメントあり。
  finalizer を足すか NULL を「abrupt termination」マーカーに。
- [ ] **`recordInvocationStart` upsert 失敗時の cache eviction**
  （`cli_lifecycle.ts:116-122` は log + return null のみ、`store.ts:107` cache は evict されない）。
  short-lived process では実害小。
- [ ] **`OtlpReceiverServiceLive.start` の bind 失敗が recoverable な契約を docstring 明示**
  （`src/stages/observability/receiver_service.ts:1-8,38-47` に記載無し）。
- [ ] **reader handle の `busy_timeout`**。`PRAGMA busy_timeout=5000` は `openWriter`
  （`store.ts:122`）のみ、`openReader`（`:137-153`）は無設定 → writer 長 transaction 時に即 SQLITE_BUSY。
- [ ] **`queryConversationList` の相関サブ SELECT を GROUP BY に**（`store.ts:421-474` は
  **8 本**の相関サブ SELECT）。index-backed なので perf 問題が出てから。
