# UI Refactor — 進捗と TODO

`src/ui/` 配下を整理し、CLI と UI で重複していた primitive 直叩きを
共通の application service 層 (`src/domain/`) に寄せる作業の状況メモ。

このファイルは作業が完了するまで更新し続ける生きたドキュメント。
設計思想の本体は各コミットメッセージ本文に書かれているので、詳細が
必要な場合は `git log --format=%B <hash>` を参照。

## 全体方針

CLI (`src/cli/<sub>.ts`) と UI (`src/ui/data.ts`, `src/ui/routes/`) は
`network` / `hostexec` / `sessions` / `audit` / containers / dtach terminal
など、同じ nas ランタイム状態に対して同じシーケンスで CRUD していた。
重複を解消するために、両者が共有する application service 層を
`src/domain/<name>/service.ts` に置く方針を取る。

- `src/stages/<name>/*_service.ts` はパイプライン実行時の lifecycle 用
- `src/domain/<name>/service.ts` は長寿命プロセス中に繰り返し呼ばれる
  CRUD 相当の操作用

Service 構造は effect-separation スキルに従い Tag + Live + Fake の
3 点セット。`Effect.Effect<T, Error>` を明示し `.orDie` しない。
CLI / UI の plain-async 呼び出しサイトのために `makeXxxClient(layer?)`
という plain-async ブリッジも同梱する (Effect ランタイムで包まずに
使える、Fake を差し込むテストでは Effect API 直接利用)。

## Phase 2 — Domain service 層の横展開 (完了)

### 完了

| Service | Commit | 備考 |
|---|---|---|
| `NetworkApprovalService` | `7ae3fcd` | PoC。設計思想の本体はこのコミットメッセージに |
| `HostExecApprovalService` | `43cbac1` | network のミラー。deny が scope を取らない点が network との構造差 |
| `AuditQueryService` | `834674c` | read-only 1 method。`(auditDir, filter)` の引数順 regression を test で押さえ。`DEFAULT_EXCLUDE_COMMAND_PREFIXES` / `slice(-limit)` は UI 表示方針として data.ts 側残置 |
| `SessionUiService` | `571ff33` | list / acknowledgeTurn / rename の 3 method。`stages/session_store/SessionStoreService` (create/delete/ensurePaths) とは別 Tag (`nas/SessionUiService`) で分離。`readSession` / `updateSessionTurn` は hook 専用なので scope 外。error prefix-match 契約 (`"Session not found:"` / `"Cannot acknowledge turn in state:"`) を保存 |
| `TerminalSessionService` | `f51a2b1` | listSessions / killClients の 2 method。`dtach/client.ts` の `dtachListSessions` / `killDtachClients` を薄く wrap。`DtachSessionInfo` は primitive の type-only re-export で重複定義しない。引数順は `(runtimeDir, sessionId)` 固定。`UiDataContext` に `terminalRuntimeDir: string` を追加。`startShellSession` / `nextShellSessionId` / `removeShellSocketsForParent` / `removeOrphanShellSockets` は SessionLaunchService 回に送る |
| `SessionLaunchService` | `8640290` | UI-only service。launchAgentSession / startShellSession / removeShellSocketsForParent / removeOrphanShellSockets の 4 method。`dtach/client.ts` の `dtachNewSession` + `shellEscape` + `socketPathFor` + 失敗時 `safeRemove` cleanup を吸収。引数順は `(runtimeDir, ...)` 固定。`LaunchValidationError` / `ContainerNotRunningError` / `NotNasManagedContainerError` は UI wrapper 残置 (Phase 3 `ContainerLifecycleService` 前提)。`removeOrphanShellSockets` は docker 依存を切り離し `runningParentIds: ReadonlySet<string>` を引数で受け取る契約 (Phase 3 `ContainerQueryService` で wrapper の docker 直叩きが解消予定)。CLI の `runInsideDtach` は self-exec 一発呼びで CRUD 定義外なので scope 外。`NAS_INSIDE_DTACH=1 NAS_SESSION_ID=...` env prefix 組み立てと `resolveStableNasBin` UI 残置を保存 |

### 残り

Phase 2 は完了。

### Phase 2 で遵守するパターン

- `src/domain/<name>.ts` を barrel、外部 (`cli/`, `ui/`) は barrel 経由で import、service_test.ts のみ直参照
- Tag 文字列は `"nas/<Name>Service"`
- `toError: (e) => e instanceof Error ? e : new Error(String(e))` ヘルパで `Effect.tryPromise` の catch を正規化。typed error class はそのまま保持される
- `makeXxxClient(layer = Live)` の plain-async adapter を同梱
- テストは Live 2〜3 + Fake 2〜3 + client 1 の 6〜7 本が目安
- broker / integration test が既にカバーする happy path は重複させない
- CLI 側は `const client = make*Client();` を `run*Command` 関数内に、UI 側は module-level に置く (CLI/UI それぞれの既存 sibling と揃える)
- 既存挙動（gc 呼び出し位置、filter default、error class 等）を極力保存。逸脱する場合は commit message で明記

## Phase 3 — Docker 関連集約 + route boilerplate

Phase 2 で積み残した Docker primitive 直叩きを domain service に寄せる。
Phase 2 の `Effect.Effect<T, Error>` を継続 (`Data.TaggedError` は
採用しない方針 — CLI 側 stages service も使っていないため)。

### 全体 commit 分割マップ (8 commits、#8 optional)

| # | Commit | 依存 | 状況 |
|---|---|---|---|
| 1 | DockerService 拡張 (inspect/listContainerNames, `.orDie` 撤回) | — | `57a1bec` |
| 2 | ContainerQueryService (read-only) | #1 | `96804a2` |
| 3 | NasContainerInfo 移設 + `networks` wire 追加 | #2 | `c887ee1` |
| 4 | ContainerLifecycleService + typed error | #2 | `b21e39a` |
| 5 | CLI Promise.allSettled 化 | #2 | `81e343b` |
| 6 | `withErrorHandling` boilerplate 削減 (TaggedError 移行なし) | #4 | `f325129` + `c3c52c6` |
| 7 | `diffSnapshots` 純関数化 | 独立 | `8d5e03a` |
| 8 | DaemonProcService (optional、優先度低) | — | defer (priority low) |
| 9 | `cleanNasContainers` の domain 化 + `defaultBackend` 廃止 + CLI 経路の service 化 | #4 | `6330ccc` |

### 完了

| Commit | hash | 備考 |
|---|---|---|
| DockerService 拡張 | `57a1bec` | 既存 16 method の `.pipe(Effect.orDie)` 撤回 + inspect/listContainerNames 追加。stage 側 8 箇所 (envoy 7 + launch 1) で `.pipe(Effect.orDie)` 補填 atomic。`docker_build` は E=unknown のまま (orDie 不要)。Docker primitive は mock 不能のため Fake 配線確認の test 5 本のみ。`Data.TaggedError` 不採用方針を確立 |
| ContainerQueryService | `96804a2` | 3 method (`listManaged` / `listManagedWithSessions` / `collectRunningParentIds`)。`Live` の R = `DockerService \| SessionUiService` を正直に宣言、default layer 閉包は plain-async client 内 `Layer.mergeAll(...)` で行う方針を確立 (Phase 3 後続も踏襲)。`cleanContainers` wrapper の docker 直叩き中間状態 (Phase 2 で「Phase 3 で解消予定」と明記) を本 commit で解消。`NasContainerInfo` は当面 `ui/data.ts` から逆 import (Commit 3 で反転)。compile-time `satisfies` で R-leakage regression を pin。fake-only test 8 本 |
| NasContainerInfo 移設 + `networks` wire | `c887ee1` | `domain/container/types.ts` 新設 (IO-free pure: `NasContainerInfo` interface + `joinSessionsToContainers` 純関数)。`service.ts` の逆向き import (`ui/data.ts` → `domain/container/`) と inline `joinSessionsToContainersPure` を解消。`NasContainerInfo.networks: string[]` を必須追加し `listManaged` で `details.networks` を投影。frontend `api.ts#ContainerInfo` には `networks?: string[]` optional を additive 追加 (backend 必須 / frontend optional の非対称設計、frontend は読み手不在で forward-compat)。`ui/data.ts` は `NasContainerInfo` / `joinSessionsToContainers` を `domain/container.ts` バレルから re-export する shim 化 (#4 `ContainerLifecycleService` 完了で `data.ts` 全体が薄くなったタイミングで剥がす予定)。`service_test.ts` 8 本維持し 2 ケースに `networks` 透過 assertion 追加 |
| ContainerLifecycleService + typed error | `b21e39a` | `domain/container/lifecycle_service.ts` 新設。`stopContainer` / `cleanContainers` / `startShellSession` の 3 method を Live + Fake + plain-async client。Live R = `DockerService \| SessionLaunchService \| ContainerQueryService` を Layer 依存で正直に宣言、`liveDeps` + `Layer.mergeAll` 1 階層閉包パターンを Phase 3 Commit 2 から踏襲。`ContainerNotRunningError` / `NotNasManagedContainerError` を `ui/data.ts` から `domain/container/types.ts` に移設、`api.ts` 側の `instanceof` 分岐 (403/409) は無編集で domain 経由に切替。plain-async adapter は `Effect.runPromiseExit` + `Cause.failureOption` で typed error を unwrap して直接 throw する (α) 戦略で `instanceof` identity を保持。`cleanNasContainers` には file-private な `makeBackendFromDockerService(docker)` adapter で fake DockerService 経由全貫通 (DI 第三案、Live test 不能を回避)。`DockerService` Tag に `listNetworkNames` / `inspectNetwork` / `listVolumeNames` / `inspectVolume` を追加 (Live + Fake config + Fake デフォルト)。`ui/data.ts` から `NasContainerInfo` / `joinSessionsToContainers` shim と typed error class / docker primitive direct import を完全撤去、`data_test.ts` の import path も `../domain/container.ts` に切替。`compile-time satisfies` で `R = never, never` 厳格 pin。`defaultBackend` 廃止と CLI 経路の service 化は将来 commit (#9) として明示的に defer |
| CLI Promise.allSettled 化 | `81e343b` | `src/cli/container.ts` の `Promise.all` → `Promise.allSettled` 置換 + `pickFulfilledContainerDetails` 純関数抽出 + `container_test.ts` 新規 4 test。silent skip で UI `for`+skip と semantics 一致、`--format json` パイプ非破壊性を契約として console spy で 1 行 assert (rejected reason はログ出力されない)。stderr warning による observability 強化は将来課題として `pickFulfilledContainerDetails` JSDoc にメモ。`cleanNasContainers()` 引数なし呼出と `defaultBackend` 経路は本 commit で触らず #9 で `cleanNasContainers` の domain 化と一緒に廃止予定。CLI が `ContainerQueryService.listManaged()` 経由になれば `pickFulfilledContainerDetails` は不要になる見通し |
| `withErrorHandling` boilerplate 削減 | `f325129` + `c3c52c6` | 2 commit 分割。Commit 6.1 (`f325129`) で `src/ui/routes/with_error_handling.ts` 新設 (`withErrorHandling(handler)` + `mapErrorToResponse(e)` export、test 10 本)。Commit 6.2 (`c3c52c6`) で `api.ts` 21 個 try/catch のうち 18 endpoint を一括置換、line 数 483 → 442 (-41)。`/launch` のみ `logWarn` / `logInfo` 副作用保持のため手動 catch 残置、ack endpoint は `Cannot acknowledge turn:` 409 を mapper に入れず 2 段 catch (内側 prefix-match + rethrow → 外側 mapper)。`Cannot acknowledge turn:` mapper 非含有理由は「他 endpoint で偶発的に同 prefix が出ると 409 化する semantic regression を避ける」defensive 戦略。bit-identical 保証として既存 24 integration test + `/launch/branches` 400 + rename 404 の 2 本追加 = 26 pass。`Data.TaggedError` 移行は不採用 (CLI/stages 全体方針) |
| `cleanNasContainers` domain 化 + `defaultBackend` 廃止 + CLI service 化 | `6330ccc` | Phase 3 完了 commit。`src/container_clean.ts` から `defaultBackend` と docker primitive 8 種の直接 import を撤去し、`ContainerCleanBackend` interface + pure logic + Docker 非依存の素 module 化。`cleanNasContainers(backend)` の引数は必須化。CLI `src/cli/container.ts` は `dockerListContainerNames` / `dockerInspectContainer` / `cleanNasContainers` / `pickFulfilledContainerDetails` / `isNasManagedContainer` 直叩きを撤去し、module-level `containerQueryClient = makeContainerQueryClient()` / `lifecycleClient = makeContainerLifecycleClient()` 経由 (`ui/data.ts` L156-159 と整合)。`list` 経路は `containerQueryClient.listManaged()`、`clean` 経路は `lifecycleClient.cleanContainers(getSocketDir())`。`--format json` shape (`{ name, running, kind, networks, startedAt }` で `kind = c.labels[NAS_KIND_LABEL] ?? null`) と human shape / 空時メッセージは保存。**orphan dtach socket 掃除 semantic 統合**: CLI `clean` 経由でも `removeOrphanShellSockets(getSocketDir(), runningParents)` が呼ばれるようになり、UI と CLI の clean semantics が統一される (副作用範囲は `getSocketDir()` 配下の dtach socket dir に閉じる)。`pickFulfilledContainerDetails` 関数本体と `cli/container_test.ts` (4 test) を削除 (dead code、silent-skip contract は domain 側 `Effect.either` で indirect カバー)。CLI 並列性は `Promise.allSettled` から `listManaged()` 直列ループに移行し UI と semantic 一致 (`concurrency` option は将来 commit 余地)。`makeBackendFromDockerService` adapter は file-private のまま据え置き (CLI も lifecycleClient 経由のため外部公開不要)。`bun run check` クリーン、`bunx biome lint src/` warning 0 / error 0、container_clean_test 13 本素通り、domain/container 系 regression なし |
| `diffSnapshots` 純関数化 | `8d5e03a` | `src/ui/routes/sse_diff.ts` 新設 (`SnapshotState` Readonly 6-field 正規化 JSON 文字列 + `SnapshotInputs` + `SseEvent` discriminated union + `SSE_EVENT_NAMES` const tuple + `initialSnapshotState()` + `diffSnapshots(prev, next): { events, nextState }` 純関数)。`sse.ts` controller の `prevXxxJson` 6 closure 変数 + 6 個の inline `if (json !== prev) { send(...) }` ブロックを `let state = initialSnapshotState()` + 1 個の `diffSnapshots()` 呼び出し + `for (const ev of events) send(ev.event, ev.data)` ループに置換。`let state` は `start(controller)` scope 内に置き module scope に漏らさない (per-connection 隔離、最重要設計点)。同値判定は `JSON.stringify` 維持 (deep equal 移行は別 commit に defer)。wire bit-identical: event 名 6 種 / payload 形状 (`sessions` のみ素 object、他 5 種は `{ items: [...] }` 包装) / 送出順序 (`network:pending → hostexec:pending → sessions → terminal:sessions → containers → audit:logs`) すべて完全保存。audit non-symmetric 設計: `audit?: AuditLogEntry[]` で `undefined` (fetch 失敗) を表現、event suppress + `nextState.audit = prev.audit` 据え置き。audit fetch の個別 try/catch / 5 fetch の `.catch(() => [])` fallback / `setTimeout(poll, 2000)` / `closed` ガード / `send()` の try/catch は controller 残置 (純関数に副作用漏らさず)。15 unit test (6 種単独変化 + 全変化順序 + audit undefined 2 ケース + payload shape 2 ケース + 部分変化 + round-trip + 初回全送出 + 同値 0 events)。Commit 6.1 (`with_error_handling.ts`) と同じ「別ファイル + 純関数 + ユニットテスト」パターン。`/api/events` integration test (接続 → 初回 6 event 受信 → close) は将来 commit で追加検討 |

### 残タスク詳細

#### Docker まわり（container 関連）

- **`ContainerQueryService`**: 読み取り系 (`listManagedContainers` /
  `listContainersWithSessions`)。`DockerService` + `sessions/store.ts`
  依存。fake DockerService で Live compose logic を unit test 可能に
- **`ContainerLifecycleService`**: 書き込み系 (`stopContainer` /
  `cleanContainers` / `startShellSession`)。typed error
  (`ContainerNotRunningError` / `NotNasManagedContainerError`) を
  service から投げて UI route の `instanceof` 分岐で 403/409 にする形
- `NasContainerInfo` / `joinSessionsToContainers` を
  `src/domain/container/` に移し、`networks: string[]` を wire に追加。
  frontend `src/ui/frontend/src/api.ts` の `ContainerInfo` にも同期
- CLI の `Promise.all(names.map(inspect))` は `Promise.allSettled` に
  寄せて並列性を保ちつつ個別 skip を実現する（UI の for+skip に
  直列化させない）

#### Route boilerplate 削減

`src/ui/routes/api.ts` で 24 箇所の `try { ... } catch (e) { return
json({error: e.message}, 500); }` を `withErrorHandling(handler)` で
一元化。エラー型 → HTTP status のマップをここに集約 (`instanceof`
分岐で実装):

- `LaunchValidationError` → 400
- `ContainerNotRunningError` → 409
- `NotNasManagedContainerError` → 403
- `Session not found:` prefix → 404 (`SessionUiService` の既存契約)
- default → 500

`Data.TaggedError` ベースへの移行は **採用しない**。CLI/stages/UI 全部
`Effect.Effect<T, Error>` で統一し、typed error は既存
`class XxxError extends Error` + `instanceof` 分岐を継続。

### SSE 純化

完了 (Commit 7、上の完了 table 参照)。`/api/events` の integration test
(接続 → 初回 6 event 受信 → close) は将来 commit で追加検討。

### daemon.ts の service 化 (defer)

`src/ui/daemon.ts` の `spawn` / `setsid` / `lsof` 直叩きを
`DaemonProcService` に切る案は **defer** (priority low)。

defer 判断根拠:
- **発火回数 0〜1**: `ensureUiDaemon` は「running なら何もしない」semantics。
  実 spawn 発火は「daemon 落ち初回」のみで、1 nas プロセス内で事実上
  0〜1 回。呼び出し元 4 箇所 (`cli.ts` / `network/notify.ts` /
  `hostexec/notify.ts` / `cli/ui.ts`) も running なら early return
- **既に部分的に testable**: `parseListeningPids` / `resolveDaemonPidsToStop`
  は純関数化済、`syncDaemonStatePid` も ad-hoc DI (3 関数注入オプション)
  済。`daemon_test.ts` 4 本既存。regression 出やすい純関数 / state DI 部分は
  service 化なしでカバー済
- **CLI/UI 対称性なし**: Phase 2 service の動機 (CLI/UI 共有 CRUD) は
  daemon に適用しづらい。CLI は `nas ui daemon-stop` だけ、UI 側は notify
  path 自動起動だけで CRUD パターンに収まらない
- **コスパ**: 250-350 行追加 + 4 import サイト変更 vs 得られる test 強化
  (shellCmd assert / poll-loop / SIGTERM 各 1-2 本)。real value は
  integration test (実 daemon 起動) の方が大きい

将来 service 化を再考するトリガ条件:
- `/api/events` 等 daemon 起動を検証する integration test を追加する流れ
  になり、Fake spawn が必要になった時
- `ensureUiDaemon` が複数 port / 複数 lifecycle を扱う変更で、複数回
  spawn 経路を持つようになった時 (現状単一 daemon の前提が崩れた場合)

将来再着手は容易: daemon.ts 内部 helper は既に分離済 (`syncDaemonStatePid`
が示している)、後から service 化する障壁は低い。

### Phase 3 ステータス

Phase 3 主要 commit (#1〜#7) + #9 完了。`#8` は defer 維持 (上記根拠)。
#9 で `defaultBackend` 廃止 + CLI 経路 service 化 + orphan dtach socket
掃除 semantic 統合 (UI と CLI で挙動一致、副作用範囲は `getSocketDir()`
配下に閉じる) を atomic に完了。次 commit (Phase 4 前) で
`src/container_clean.ts` を `src/domain/container/clean.ts` に移設する
候補あり (本 commit では所有権維持、Docker 非依存の pure module として
そのまま据え置き)。

## Phase 4 — Frontend 整理

Phase 4-α 開始。Preact reducer 分解と純関数抽出 (`terminalSessions_test.ts`
スタイル踏襲) で対応。コンポーネント描画テストは費用対効果悪く見送り。

### 全体 commit 分割マップ (案 A: コンポーネント単位逐次)

| # | Commit | 推定 | 依存 | 状況 |
|---|---|---|---|---|
| 1 | terminal UI state reducer 抽出 + tests | +500/-100 | — | `a625db2` |
| 2a | TerminalModal: 純関数 + TerminalTabLabel 抽出 | +200/-140 | — | `1c151b2` |
| 2b | TerminalModal: search bar 分割 (optional) | — | 独立可 | defer |
| 2c | TerminalModal: toolbar 分割 (optional) | — | 独立可 | defer |
| 3 | ContainersTab split (style + 内部 component) | +633/-419 | — | `83e3ee0` |
| 4 | (optional) EditableSessionName 共通化 | +200/-300 | #2a, #3 | TODO |
| 5 | (optional) module organization cleanup | +100/-200 | #1〜#4 | TODO |

scope 縮小: Phase 4-α (Commit 1) だけで App.tsx の最大複雑性ホットスポット
解消、reducer test 16 本で unit カバー大幅増。残り (#2-#5) は別 commit
で熟慮判断。

### 完了

| Commit | hash | 備考 |
|---|---|---|
| terminal UI state reducer 抽出 | `a625db2` | `App.tsx` の 4 useState (`dtachSessions` / `openTermSessionIds` / `activeTermSessionId` / `termVisible`) を `terminalUiReducer` 純関数に集約、`useReducer` 経由で扱う形に。7 action (`set-dtach-sessions` / `attach` / `shell-started` / `select-tab` / `close-tab` / `minimize` / `restore`)、`default: never` 網羅性 guard 付き。reconcile useEffect (旧 L307-324) を `set-dtach-sessions` action 内統合で削除。重要不変条件保存: (1) reference-equality 最適化 (子 component memo 効果)、(2) `close-tab` 2 分岐 (active 自身 vs 他)、(3) `shell-started` optimistic + SSE catch-up 重複防止。他 state 8 個 (SSE 直 set / 単純 set) は reducer 化 loss として touch 回避。`terminalUiState_test.ts` に 16 reducer unit test (`terminalSessions_test.ts` スタイル踏襲、`bun:test`)。backend wire 不変 (`api_integration_test.ts` 26 + `sse_diff_test.ts` 15 全 pass)。`bun run build-ui` success |
| TerminalModal 低リスク抽出 | `1c151b2` | `TerminalModal.tsx` 976 → 841 行 (-137/+2)。純関数 `getTerminalSize` / `sendTerminalResize` + `TerminalSize` interface を `terminalSize.ts` に、`TerminalTabLabel` component を `TerminalTabLabel.tsx` に move。xterm + WebSocket lifecycle (init useEffect L226-408) は 1 行も touch せず。`sendTerminalResize` に defensive OPEN check 追加 (既存 call-site 全てが外側で OPEN guard 済みのため bit-identical)。`terminalSize_test.ts` に 7 本純関数 test。侵襲的な 2b (search bar) / 2c (toolbar) は defer (xterm init useEffect 内 `setSearchOpen(true)` + `searchInputRef.current?.select()` wiring が state lift / ref forwarding を侵襲的にする、`terminalRef` handler 散在、dtach SIGWINCH workaround timing logic がリスク) |
| ContainersTab 分割 | `83e3ee0` | `ContainersTab.tsx` 645 → 247 行 (+46/-420)。`containersHelpers.ts` に純関数 5 個 (`isAckEligibleTurn` / `startedTimestamp` / `sortContainers` / `formatDateTime` / `formatRelativeTime`)、`containersTab.styles.ts` に 29 style const、`TurnCell.tsx` / `EditableSessionName.tsx` / `ContainerDetailPanel.tsx` に子 component を分離。`formatRelativeTime` のみ signature 拡張 (defaulted optional `now = Date.now()`、呼出サイト無編集、test 注入可能)。`TurnCell` / `EditableSessionName` 内 `{color:"#64748b"}` inline literal は styles.ts に move せず (bit-identical)。`turnBadgeBaseStyle` spread 評価順維持。`onShell` dead prop (App.tsx:358、`ContainersTabProps` 宣言外の pre-existing 温存、#5 module cleanup 余地)。`EditableSessionName` と `TerminalTabLabel` の 2 重化は #4 で共通化予定。`containersHelpers_test.ts` に 20 test |

### 残タスク詳細

- **TerminalModal.tsx** (976 行) の分割: Pane / Tabs / Actions / Header に切り出し。xterm + WebSocket lifecycle は Pane に残す。3 sub-commit に再分割可 (純関数 + small component / search bar / toolbar)
- **ContainersTab.tsx** (644 行) の分割: inline style 切り出し (~200 行削減)、`EditableSessionName` / `ContainerDetailPanel` / `TurnCell` を別ファイル化
- **`EditableSessionName` 共通化** (optional): TerminalTabLabel と類似、共通 hook + thin wrapper に
- **module organization cleanup** (optional): `DeepLink` 型を `App.tsx` から独立 module 化等

## 作業時の知見 / 落とし穴

Phase 2 を進めながら溜まったもの。Phase 3 以降で同じ轍を踏まない
ための覚書。

- **CLI side `const client = ...` の位置**: network/hostexec CLI は
  `run*Command` 関数内、UI は module-level で揃える。audit では一度
  誤って CLI 側 module-level に置いて code-reviewer に design
  finding 差し戻しされた
- **(paths, filter) 引数順**: `queryAuditLogs(filter, auditDir?)` の
  ような既存 primitive と逆順になる場合、domain service 側は
  `(paths, ...)` 規約に揃える。swap を型で押さえにくいので Live test
  に「引数順 regression 防止」コメント付きで挙動検証ケースを 1 本
  足す
- **broker protocol と API の非対称**: network deny は scope を取る
  が hostexec deny は取らない。service signature / fake config /
  plain-async client 全部で broker 実装と一致させる。network から
  コピペして `scope?` を残さない
- **gc 呼び出し位置**: network は listPending/approve/deny 全部で
  gc、hostexec は listPending のみで gc。既存 CLI/UI 挙動を維持する
  方針で揃え、挙動変更になる場合は commit message で明記
- **Docker primitive の testability**: fs / SQLite primitive は
  tmpdir で Live test 可能だが、Docker primitive は mock 不能。この
  ため container service は「DockerService 経由にして fake を差し込む」
  選択肢 B を取らないと Live compose logic の unit test が書けない。
  → Phase 3 で解決
- **コミット粒度**: 先行 3 service はいずれも 1 コミットで service
  新設 + CLI/UI 両側置換 + test を完結させる。分割すると data.ts が
  「service 経由 / 直叩き」混在の中間状態になるのを避けるため
- **`effect-separation` SKILL.md 参照**: Tag + Live + Fake の 3 点
  セット、primitive service は probe か domain service 越しに使う、
  D1/D2 分離などの規約は `.claude/skills/effect-separation/SKILL.md`
  に定義済み
