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

## Phase 2 — Domain service 層の横展開

### 完了

| Service | Commit | 備考 |
|---|---|---|
| `NetworkApprovalService` | `7ae3fcd` | PoC。設計思想の本体はこのコミットメッセージに |
| `HostExecApprovalService` | `43cbac1` | network のミラー。deny が scope を取らない点が network との構造差 |
| `AuditQueryService` | `834674c` | read-only 1 method。`(auditDir, filter)` の引数順 regression を test で押さえ。`DEFAULT_EXCLUDE_COMMAND_PREFIXES` / `slice(-limit)` は UI 表示方針として data.ts 側残置 |

### 残り

優先順（Docker を触らない軽いものから順）:

1. **`SessionUiService`** — `sessions/store.ts` の list / rename / ack CRUD
   - CLI `cli/session.ts` と UI `ui/data.ts` の `renameSession` / `acknowledgeSessionTurn` / `getSessions` 内 session 取得が対象
   - fs 経路の primitive なので先行 3 と同じパターンで Live test 書ける

2. **`TerminalSessionService`** — dtach セッション一覧と kill
   - `ui/data.ts` の `getTerminalSessions` / `killTerminalClients`
   - `dtach/client.ts` の `dtachListSessions` / `killDtachClients` ラップ
   - Live test はソケットを用意する必要があり、どこまで unit で書くかは要判断

3. **`SessionLaunchService`** — 新規セッションの dtach 起動
   - `ui/launch.ts` の `launchSession` と `cli.ts` の `runInsideDtach` が
     `shellEscape` + `dtachNewSession` + `socketPathFor` を独立に組んでおり重複
   - 副作用が強く、Live test は書きづらい。Fake 中心になりそう

### Phase 2 で遵守するパターン

- `src/domain/<name>.ts` を barrel、外部 (`cli/`, `ui/`) は barrel 経由で import、service_test.ts のみ直参照
- Tag 文字列は `"nas/<Name>Service"`
- `toError: (e) => e instanceof Error ? e : new Error(String(e))` ヘルパで `Effect.tryPromise` の catch を正規化。typed error class はそのまま保持される
- `makeXxxClient(layer = Live)` の plain-async adapter を同梱
- テストは Live 2〜3 + Fake 2〜3 + client 1 の 6〜7 本が目安
- broker / integration test が既にカバーする happy path は重複させない
- CLI 側は `const client = make*Client();` を `run*Command` 関数内に、UI 側は module-level に置く (CLI/UI それぞれの既存 sibling と揃える)
- 既存挙動（gc 呼び出し位置、filter default、error class 等）を極力保存。逸脱する場合は commit message で明記

## Phase 3 — 積み残し

Phase 2 を先行させて Phase 3 に送ったもの。ここで一気に片付ける方が
boundary が綺麗という判断。

### Docker まわり（container 関連）

- **`DockerService` 拡張**: `inspect(name)` と `listContainerNames()` を
  method に追加。`.orDie` は stages だけで必要なので、Live は error
  channel を返す形に撤回し、stage 側で `.pipe(Effect.orDie)` する。
  これで UI が 500 応答する経路と整合する
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

### Route boilerplate 削減

`src/ui/routes/api.ts` で 24 箇所の `try { ... } catch (e) { return
json({error: e.message}, 500); }` を `withErrorHandling(handler)` で
一元化。エラー型 → HTTP status のマップをここに集約:

- `LaunchValidationError` → 400
- `ContainerNotRunningError` → 409
- `NotNasManagedContainerError` → 403
- `SessionNotFound` (新規 tagged error) → 404
- default → 500

domain service の error channel を `Data.TaggedError` ベースに移行する
タイミング。Phase 2 の `Effect.Effect<T, Error>` は暫定。

### SSE 純化

`src/ui/routes/sse.ts` の `diffSnapshots(prev, next): SseEvent[]` を純
関数として抽出、unit test でカバー。現状は controller の closure で
前回値を抱えており test しづらい。

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
