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
| 8 | DaemonProcService (optional、優先度低) | — | TODO |
| 9 | `cleanNasContainers` の domain 化 + `defaultBackend` 廃止 + CLI 経路の service 化 | #4 | TODO |

### 完了

| Commit | hash | 備考 |
|---|---|---|
| DockerService 拡張 | `57a1bec` | 既存 16 method の `.pipe(Effect.orDie)` 撤回 + inspect/listContainerNames 追加。stage 側 8 箇所 (envoy 7 + launch 1) で `.pipe(Effect.orDie)` 補填 atomic。`docker_build` は E=unknown のまま (orDie 不要)。Docker primitive は mock 不能のため Fake 配線確認の test 5 本のみ。`Data.TaggedError` 不採用方針を確立 |
| ContainerQueryService | `96804a2` | 3 method (`listManaged` / `listManagedWithSessions` / `collectRunningParentIds`)。`Live` の R = `DockerService \| SessionUiService` を正直に宣言、default layer 閉包は plain-async client 内 `Layer.mergeAll(...)` で行う方針を確立 (Phase 3 後続も踏襲)。`cleanContainers` wrapper の docker 直叩き中間状態 (Phase 2 で「Phase 3 で解消予定」と明記) を本 commit で解消。`NasContainerInfo` は当面 `ui/data.ts` から逆 import (Commit 3 で反転)。compile-time `satisfies` で R-leakage regression を pin。fake-only test 8 本 |
| NasContainerInfo 移設 + `networks` wire | `c887ee1` | `domain/container/types.ts` 新設 (IO-free pure: `NasContainerInfo` interface + `joinSessionsToContainers` 純関数)。`service.ts` の逆向き import (`ui/data.ts` → `domain/container/`) と inline `joinSessionsToContainersPure` を解消。`NasContainerInfo.networks: string[]` を必須追加し `listManaged` で `details.networks` を投影。frontend `api.ts#ContainerInfo` には `networks?: string[]` optional を additive 追加 (backend 必須 / frontend optional の非対称設計、frontend は読み手不在で forward-compat)。`ui/data.ts` は `NasContainerInfo` / `joinSessionsToContainers` を `domain/container.ts` バレルから re-export する shim 化 (#4 `ContainerLifecycleService` 完了で `data.ts` 全体が薄くなったタイミングで剥がす予定)。`service_test.ts` 8 本維持し 2 ケースに `networks` 透過 assertion 追加 |
| ContainerLifecycleService + typed error | `b21e39a` | `domain/container/lifecycle_service.ts` 新設。`stopContainer` / `cleanContainers` / `startShellSession` の 3 method を Live + Fake + plain-async client。Live R = `DockerService \| SessionLaunchService \| ContainerQueryService` を Layer 依存で正直に宣言、`liveDeps` + `Layer.mergeAll` 1 階層閉包パターンを Phase 3 Commit 2 から踏襲。`ContainerNotRunningError` / `NotNasManagedContainerError` を `ui/data.ts` から `domain/container/types.ts` に移設、`api.ts` 側の `instanceof` 分岐 (403/409) は無編集で domain 経由に切替。plain-async adapter は `Effect.runPromiseExit` + `Cause.failureOption` で typed error を unwrap して直接 throw する (α) 戦略で `instanceof` identity を保持。`cleanNasContainers` には file-private な `makeBackendFromDockerService(docker)` adapter で fake DockerService 経由全貫通 (DI 第三案、Live test 不能を回避)。`DockerService` Tag に `listNetworkNames` / `inspectNetwork` / `listVolumeNames` / `inspectVolume` を追加 (Live + Fake config + Fake デフォルト)。`ui/data.ts` から `NasContainerInfo` / `joinSessionsToContainers` shim と typed error class / docker primitive direct import を完全撤去、`data_test.ts` の import path も `../domain/container.ts` に切替。`compile-time satisfies` で `R = never, never` 厳格 pin。`defaultBackend` 廃止と CLI 経路の service 化は将来 commit (#9) として明示的に defer |
| CLI Promise.allSettled 化 | `81e343b` | `src/cli/container.ts` の `Promise.all` → `Promise.allSettled` 置換 + `pickFulfilledContainerDetails` 純関数抽出 + `container_test.ts` 新規 4 test。silent skip で UI `for`+skip と semantics 一致、`--format json` パイプ非破壊性を契約として console spy で 1 行 assert (rejected reason はログ出力されない)。stderr warning による observability 強化は将来課題として `pickFulfilledContainerDetails` JSDoc にメモ。`cleanNasContainers()` 引数なし呼出と `defaultBackend` 経路は本 commit で触らず #9 で `cleanNasContainers` の domain 化と一緒に廃止予定。CLI が `ContainerQueryService.listManaged()` 経由になれば `pickFulfilledContainerDetails` は不要になる見通し |
| `withErrorHandling` boilerplate 削減 | `f325129` + `c3c52c6` | 2 commit 分割。Commit 6.1 (`f325129`) で `src/ui/routes/with_error_handling.ts` 新設 (`withErrorHandling(handler)` + `mapErrorToResponse(e)` export、test 10 本)。Commit 6.2 (`c3c52c6`) で `api.ts` 21 個 try/catch のうち 18 endpoint を一括置換、line 数 483 → 442 (-41)。`/launch` のみ `logWarn` / `logInfo` 副作用保持のため手動 catch 残置、ack endpoint は `Cannot acknowledge turn:` 409 を mapper に入れず 2 段 catch (内側 prefix-match + rethrow → 外側 mapper)。`Cannot acknowledge turn:` mapper 非含有理由は「他 endpoint で偶発的に同 prefix が出ると 409 化する semantic regression を避ける」defensive 戦略。bit-identical 保証として既存 24 integration test + `/launch/branches` 400 + rename 404 の 2 本追加 = 26 pass。`Data.TaggedError` 移行は不採用 (CLI/stages 全体方針) |
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

### daemon.ts の service 化

`src/ui/daemon.ts` が `spawn` / `setsid` / `lsof` を直叩きしている。
`DaemonProcService` に切って fake 可能にする。優先度は低い。

## Phase 4 — Frontend 整理

現在は手を付けない。Preact reducer 分解と純関数抽出 (`terminalSessions_test.ts`
が既にある方向) で対応できるはず。コンポーネント描画テストは費用対効果
悪く見送り。

- `App.tsx` (455 行) の handler を reducer に切る
- `TerminalModal.tsx` (976 行) の分割
- `ContainersTab.tsx` (644 行) の分割

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
