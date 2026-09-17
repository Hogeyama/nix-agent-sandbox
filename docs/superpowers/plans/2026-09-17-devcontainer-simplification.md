# Dev Container 実装の減量 計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `5a846a4f..HEAD` で入った Dev Container 実装から、production 3,228 行 + test 2,592 行（計 5,820 行）を削除し、同じ機能を約 700 行のライフサイクルで再実装する。通常 CLI 経路の挙動は一切変えない。

**Architecture:** Dev Containers 側が Compose サービスの生成・再利用・attach を行うことが実測で確定したため、nas 側は「登録情報を 1 枚書く / Compose を 1 枚生成する / `docker compose up -d` を叩く」だけでよい。常駐 supervisor、世代管理、起動後の実構成照合、自前の硬化ファイル I/O は、この契約が不明だった時期の保険であり、契約が確定した今は不要。

**Tech Stack:** Bun / TypeScript / bun:test / Docker Compose

---

## この計画の前提となる測定

2026-09-17、ホスト実機で `tests/devcontainer_contract_e2e_test.ts` を実行し、**pass**（12.1s / 9 assertions）。

- 環境: Dev Containers CLI 0.89.0 / Docker 29.6.2 / Docker Compose 5.1.4
- fixture image `nas-devcontainer-contract:latest`（`nas-test`, uid 1000, `/home/nas-test`）

確定した契約:

| 測定項目 | 結果 |
| --- | --- |
| `initializeCommand` の実行順 | attach より先に走る |
| 既存 Compose サービスへの attach | attach する。クライアントは作り直さない |
| 2 回目の `devcontainer up` | 同一コンテナを再利用する（冪等） |
| `updateRemoteUserUID: false` での識別 | uid 1000 / `HOME=/home/nas-test` で入る |

`docs/superpowers/research/2026-09-15-devcontainer-contract.md` は「not executed」のままなので、Task 0 で更新する。

## 削除の判断基準

各項目は次の 3 つのいずれかに該当する場合に削除する。判断に迷ったら削除せず、理由をこの文書に追記する。

1. **契約で置き換えられた** — 上表で確定した挙動を、実行時に毎回確認し直しているもの。
2. **脅威モデル外** — 攻撃者が「自分自身の uid で動く Docker/Compose/カーネル」である場合にのみ意味を持つ検査。nas の脅威モデルはコンテナ内エージェントであり、ホスト側の Docker は信頼する。
3. **同一リポジトリ内で流儀が重複** — nas の既存実装が別のやり方で同じ問題を既に解いているもの。

---

## 残すもの

削除対象を選ぶ前に、残す理由を確定させる。以下は**触らない**。

| 対象 | 行 | 残す理由 |
| --- | --- | --- |
| `src/stages/launch/plan.ts` | 46 | `finalizeLaunchPlan` の純粋関数抽出。devcontainer と無関係に通常 CLI 経路を改善している |
| `src/stages/launch/compose.ts` | 126 | `ContainerPlan` → Compose JSON。Compose 方式の中核。`extraRunArgs` を黙って捨てず例外にする設計も妥当 |
| `src/stages/launch/compose_stage.ts` | 65 | Task 4 で `serve` の呼び先だけ差し替える。ステージ自体は残す |
| `src/domain/devcontainer/config.ts` | 60 | `renderDevcontainerConfig` / 指紋計算。生成する devcontainer.json の形そのもの |
| `src/docker/embed/devcontainer-env.sh` ほか 4 本 | 61+ | VS Code が自前のシェルを起こす以上、方式に依らず必要 |
| `shmSize` の構造化 (`pipeline/state.ts`, `container_plan.ts`) | - | `extraRunArgs` の文字列から構造化フィールドへの昇格。通常経路にも効く改善 |
| `cli.ts` → `pipeline/cli_builder.ts` + `pipeline/live.ts` の分解 | 144 | cli.ts から 204 行の import/配線が消えた。devcontainer と独立した改善 |
| `tests/devcontainer_contract_e2e_test.ts` | 321 | 上の測定を行った試験そのもの。CI に載せる |
| `src/docker/client.ts` の `runDockerCommand` / `DockerCommandOptions` | - | timeout + signal 付きの bounded docker 実行。汎用的に有用 |

**合計 679 行を残す。**

## 消すもの

### D1. 起動後の実構成照合 — 956 行

**Files:** `src/docker/launch_inspection.ts` (263), `src/stages/launch/inspection.ts` (143), `src/docker/launch_inspection_test.ts`, `src/docker/launch_inspection_integration_test.ts`, `src/stages/launch/inspection_test.ts`

**何を:** `docker inspect` の全出力を型付きデコードし、mount / env / network / capability / label / entrypoint / user を計画と全項目照合する仕組み。

**なぜ:** 判断基準 1。nas 自身が生成した Compose ファイルで起動したコンテナが、その Compose の通りに構成されているかを毎回検査している。これは「Docker が指示と異なる設定で起動する」ことを想定した検査であり、脅威モデル外（判断基準 2）。加えて `tests/devcontainer_contract_e2e_test.ts` が同じことを 12 秒で CI 上で証明するため、実行時に持つ必要がない。

**付随して消えるもの:** `src/services/docker.ts` の `inspectLaunch` / `inspectLaunchImage`（型 + Live + Fake config + Fake default = 61 行）。**この 2 つの API には production の呼び出し元が存在しない**（呼んでいるのは自身のテストのみ。`compose_session_service.ts` は `DockerService` を経由せず `runDockerCommand` を直接呼んでいる）。共有サービスに足された完全な死にコード。

### D2. 自前の硬化ファイル I/O 層 — 845 行

**Files:** `src/domain/devcontainer/store.ts` (606), `src/domain/devcontainer/store_test.ts` (239)

**何を:** `assertNoSymlinks`（パス全成分を lstat）、`nlink !== 1` 検査、`O_NOFOLLOW`、モード 0600 強制、1MB サイズ上限、`fsync`、排他作成の `link`+`unlink`、`DevcontainerStoreOps` という Effect Tag 経由の I/O 注入層。

**なぜ:** 判断基準 3。書き込み先は `~/.local/state/nas/` 配下の自分の 0700 ディレクトリで、nas の他の状態（`src/sessions/store.ts`）は `ensureDir` + 通常の write で書いている。同一リポジトリ内に状態書き込みの流儀が 2 つできている。判断基準 2 でもある（symlink 攻撃を仕掛けられるのは自分の uid を既に持つ者だけ）。

**代替:** `sessions/store.ts` と同じ流儀。登録情報 1 枚の read/write と `ensureDir` のみ。

### D3. supervisor と世代管理 — 1,501 行

**Files:** `src/domain/devcontainer/supervisor.ts` (937), `supervisor_test.ts`, `supervisor_cleanup_test.ts`, `supervisor_integration_test.ts`

**何を:** `setsid` で分離した常駐プロセス、UDS のチャレンジレスポンス制御プロトコル、`lifetimeIsFree`（flock を timeout 0 で取得して生存判定）、`sameGeneration` / `waitForGeneration` / `recover` / `writeTerminal` / `markSupervisorFailure`、`up` の 2 回リトライループ、`preparing→starting→ready→stopping→stopped/failed` の状態機械。

**なぜ:** 判断基準 1。この常駐機構は「Dev Containers がコンテナの寿命をどう扱うか不明」という前提の産物。実測では 2 回目の `up` が同一コンテナを再利用し、`shutdownAction: none` でウィンドウを閉じても停止しない。つまり**コンテナの寿命は Docker が持っており、nas が常駐して見張る必要がない**。状態は `docker compose ps` が持つ。

チャレンジレスポンスは判断基準 2。0600 の UDS に毎回 UUID を載せて往復させているが、接続ごとに新規ソケットを張る以上、相関以上の意味がない。同一 uid しか到達できない。

**代替:** `up` = Compose 生成 → `docker compose up -d`。`status` = `docker compose ps` の委譲。`down` = `docker compose down`。同時実行の排他は workspace ごとの flock 1 個（約 20 行）。

**2026-09-17 の修正（実装時の判断）:** 分離プロセス自体は残す。上の「何を」のうち削除するのは、UDS のチャレンジレスポンス制御プロトコル、世代管理（`sameGeneration` / `waitForGeneration` / `recover` / `markSupervisorFailure`）、`up` の 2 回リトライループ、6 相の状態機械である。

理由: 元 plan（`2026-09-15-devcontainer.md`）の Architecture は「独立した supervisor が**パイプラインの Effect Scope を保持し**」と書いており、分離プロセスの第一の役割はコンテナの監視ではなく、proxy / hostexec broker / maskfs / port_bind をコンテナと同じ寿命で生かすことだった。D3 の論拠（コンテナの寿命は Docker が持つ）は監視の不要性しか示しておらず、Scope 保持の必要性を否定しない。`initializeCommand` は完了を待つため前景で保持することもできない。

したがって残すのは「`setsid` で分離して起動し、ready を待ち、停止時に signal で終了させる」部分だけで、約 150 行を見込む。D3 の削減量はその分目標を下回る。

### D4. 5 重の mount 検証 — 1,214 行

**Files:** `src/domain/devcontainer/service.ts` (468), `service_test.ts` (375), `policy.ts` (89), `policy_test.ts` (103), `compose_session_service.ts` の `validateComposeSessionRequest` 部分、`src/devcontainer/runtime.ts` の `validateOriginalMountRoots`

**何を:** 同一の「マウントが保護パスを露出していないか」を、init/verify 時（`validateDevcontainerMount`）、起動直前（`validateComposeSessionRequest`）、起動後（`compareLaunchInspection`）、runtime 入口（`validateOriginalMountRoots`、`policy.ts` のロジックを手書きで再実装）の 4 箇所で検査。さらに `compose_session_service.ts:125` にはローカル版 `pathContains` が再定義されている（`policy.ts` に同名関数がある）。

**なぜ:** 判断基準 3。マウント集合を決めているのは nas 自身（`planMount`）であり、それを 4 回検算している。1 箇所で正しく組み立てれば足りる。

**残す核:** profile の妥当性検査（`validateDevcontainerProfile`: nix/docker/worktree/gpg を devcontainer では拒否）は `planMount` の入口に 1 箇所だけ残す。約 30 行。

### D5. init のロールバックと指紋の二重管理 — D4 に含む

**何を:** `undo` 配列に逆操作を積んで `Effect.onError` で逆順実行する手書きトランザクション。`registration.fingerprint`（configBytes を含む SHA-256）とは別に `ownership.json` に `configHash` を保存。`loadDevcontainerInputs` の trust hash を読み込み前後で 2 回計算する TOCTOU 検査と、`!(global === null && globalAfter === 'amends "Schema.pkl"\n')` という初回自動生成だけを通す特例ハードコード。

**なぜ:** 判断基準 2。5 ファイルの作成に対する分散トランザクション。失敗したら `.devcontainer` が中途半端に残るだけで、再実行すれば直る。

**残す核:** 「既存の `.devcontainer` を上書きしない」検査（約 10 行）と、「設定が変わったら再起動を促す」ための指紋 1 個。`ownership.json` と二重持ちしない。

### D6. `~/.claude` 隔離の残骸 — D2/D4 に含む

**何を:** `DevcontainerPaths.claudeDir` / `claudeJson`、`init` が作る `state/<id>/claude/` と `claude.json`（中身 `{}`）、`dedicatedMounts` ポリシー、`validateComposeSessionRequest` の `hostHome ? ... : stateRoot/claude` という三項演算子。

**なぜ:** `affb8085 fix(devcontainer): reuse host Claude authentication` でマウント元はホストの `~/.claude` に戻っている（`src/devcontainer/runtime.ts:165-166`）。**誰もマウントしない空ディレクトリを作り、それを守るための分岐が全経路に残っている。** 完全な死にコード。

### D7. 常駐ヘルスプローブ — `compose_session_service.ts` に含む (722 + 460)

**Files:** `src/stages/launch/compose_session_service.ts` (722), `compose_session_service_test.ts` (460)

**何を:** 起動後の監視ループ（`compose_session_service.ts:412-427`）が `POLL_MS = 500` ごとに `docker inspect` + broker socket 2 本 + `probeContainerGateways`（`docker exec` でコンテナ内に Bun ランタイムを起動して proxy と hostexec socket に接続を試みる one-liner）を実行。

**なぜ:** 判断基準 1 + 実害。セッションが生きている間ずっと、毎秒 2 回コンテナ内で Bun プロセスが起動する。起動時の 1 回のヘルスチェックとしては妥当だが、定常監視に入れるものではない。コンテナの死活は Docker の restart policy と `docker compose ps` が持つ。

**残す核:** 起動完了判定の readiness marker 確認（`/run/nas-devcontainer/ready`）1 回のみ。

---

## 未測定のまま残る契約

**この 2 つを「検証済み」と書かないこと。** 今回の測定の対象外である。

1. **`userEnvProbe: "loginInteractiveShell"`** — `devcontainer-env.sh` + `/etc/profile.d/nas.sh` の環境再生機構は、VS Code が login interactive bash を起こすことに全面的に依存している。違えば環境復元が丸ごと動かない。今回の fixture はこの設定を使っていない。
2. **`claudeCode.claudeProcessWrapper`** — `devcontainer-claude.sh` は実バイナリが argv[1] で渡ると仮定している（`binary=$1`）。Claude Code 拡張がこの設定を実際にどう呼ぶかは未確認。検証には VS Code 実機と拡張本体が要る。

---

## Global Constraints

- 通常 CLI 経路（`nas` / `nas <profile>`）の挙動を変えない。`src/stages/launch/stage.ts` と `planMount` の非 devcontainer 分岐には手を入れない。
- 実装者とレビュアーは以下を読むこと: `.claude/skills/effect-separation/SKILL.md`、`.claude/skills/security-constraints/SKILL.md`、`.claude/skills/test-policy/SKILL.md`。
- ランタイムは Bun。`bun:test` を使う。
- 各 Task の終わりに `bun run check` と `bun run test:unit` を通す。最後に一度だけ `bun run test`。
- 削除した検査のうち「残す核」と書いたものは、消す前に移設先を作る。移設を忘れた削除をしない。

---

### Task 0: 測定結果の記録

**Files:** Modify: `docs/superpowers/research/2026-09-15-devcontainer-contract.md`

- [ ] **Step 1:** 「NAS result」節の「The automated contract was not executed」を、2026-09-17 の実行結果に差し替える。実行環境（Dev Containers CLI 0.89.0 / Docker 29.6.2 / Compose 5.1.4）、pass、9 assertions、確定した 4 項目を記録する。
- [ ] **Step 2:** 未測定のまま残る契約 2 件を明記する。測定済みと未測定を混ぜて書かない。

**なぜ最初か:** この文書は測定結果を記録するために作られたが、記録されていないために同じ調査が繰り返される。削除作業の根拠でもある。

### Task 1: 死にコードの削除（振る舞い不変）

**Files:** Modify: `src/services/docker.ts`; Delete: `src/docker/launch_inspection.ts`, `src/stages/launch/inspection.ts` とそれぞれの test

- [ ] **Step 1:** `DockerService.inspectLaunch` / `inspectLaunchImage` を型・Live・Fake config・Fake default ごと削除する。production の呼び出し元がないことを `grep -rn inspectLaunch src/` で再確認してから消す。
- [ ] **Step 2:** D6 の `~/.claude` 残骸を削除する。`DevcontainerPaths.claudeDir` / `claudeJson`、`init` の `createDir(paths.claudeDir)` / `write(paths.claudeJson, "{}\n")`、`dedicatedMounts`、`validateComposeSessionRequest` の `hostHome` 三項演算子。
- [ ] **Step 3:** D1 の 2 ファイルと 3 つの test を削除し、`src/stages/launch.ts` の barrel から export を外す。

このタスクは振る舞いを変えない。`bun run test:unit` が通ることを確認する。

### Task 2: ライフサイクルの最小再実装

**Files:** Create: `src/domain/devcontainer/lifecycle.ts`, `lifecycle_test.ts`

- [ ] **Step 1:** 失敗するテストを書く。`up` が「Compose を生成し、`docker compose up -d` を呼び、readiness marker を 1 回確認して ready を返す」こと。`status` が `docker compose ps` の結果を投影すること。`down` が `docker compose down` を呼ぶこと。Docker 呼び出しは注入で差し替える。
- [ ] **Step 2:** 登録情報の read/write を `sessions/store.ts` と同じ流儀で実装する。`ensureDir` + JSON 1 枚。指紋 1 個。`ownership.json` を作らない。
- [ ] **Step 3:** workspace ごとの flock による同時 `up` の排他（約 20 行）。世代 ID、状態機械、リトライループを作らない。
- [ ] **Step 4:** `validateDevcontainerProfile` 相当（nix/docker/worktree/gpg の拒否）を `planMount` の devcontainer 入口 1 箇所に移設する。
- [ ] **Step 5:** 「既存の `.devcontainer` を上書きしない」検査を `init` に移設する。

### Task 3: supervisor と検証層の削除

**Files:** Delete: `src/domain/devcontainer/{supervisor,store,service,policy}.ts` とそれぞれの test（`supervisor_cleanup_test.ts`, `supervisor_integration_test.ts` を含む）; Modify: `src/domain/devcontainer.ts`, `src/devcontainer/runtime.ts`, `src/cli/devcontainer.ts`, `src/cli.ts`

- [ ] **Step 1:** `src/cli/devcontainer.ts` の `makeClient` を Task 2 の lifecycle に差し替える。CLI の引数解釈と出力形式は変えない。
- [ ] **Step 2:** `src/cli.ts` から `_supervise` 内部サブコマンドと `runDevcontainerSupervisorEntry` を削除する。`src/cli/devcontainer_args.ts` の `parseDevcontainerSupervisorArgs` も削除する。
- [ ] **Step 3:** `src/devcontainer/runtime.ts` の `validateOriginalMountRoots` を削除する（D4）。`createStartupGuard` は Task 2 の deadline に統合できるか検討し、できなければ残す。
- [ ] **Step 4:** 4 ファイルと test を削除し、`src/domain/devcontainer.ts` の barrel を残った export だけに絞る。

### Task 4: 常駐ヘルスプローブの削除

**Files:** Modify/Delete: `src/stages/launch/compose_session_service.ts`, `compose_session_service_test.ts`; Modify: `src/stages/launch/compose_stage.ts`

- [ ] **Step 1:** 監視ループ（`Effect.forever` の tick + inspect + broker probe ×2 + `probeContainerGateways`）を削除する。
- [ ] **Step 2:** 起動時の readiness marker 確認 1 回だけを残し、`ComposeSessionOps` の 20 近い操作を lifecycle が使う数個に絞る。`validateComposeSessionRequest` を削除する（D4）。
- [ ] **Step 3:** `compose_stage.ts` の `serve` 呼び出しを Task 2 の lifecycle に向ける。`finalizeDevcontainerPlan`（`NAS_DEVCONTAINER` env と devcontainer label の付与）は残す。

### Task 5: 検証

- [ ] **Step 1:** `bun run check` と `bun run test`（full）を通す。sandbox 内では `imageBuildable` 系の skip が出るため、unit の pass 件数と integration/e2e の pass/skip を分けて報告する。
- [ ] **Step 2:** hostexec で `tests/devcontainer_contract_e2e_test.ts` を再実行し、pass することを確認する。ホストの `/tmp/nas-devcontainer-cli/` に Dev Containers CLI 0.89.0 が置いてある（グローバルには入れていない）。
- [ ] **Step 3:** 削除前後の行数を報告する。目標は production −3,228 / test −2,592。
- [ ] **Step 4:** `docs/superpowers/specs/2026-09-15-devcontainer-design.md` の、常駐 supervisor と実構成検査を前提にした記述を、この計画の結果に合わせて更新する。設計書を放置して実装だけ変えない。
