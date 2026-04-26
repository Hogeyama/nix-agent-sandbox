# nas UI 再設計 — 進捗管理

`docs/ui-redesign.md` の設計に基づく実装の進捗トラッカ。新しいセッションで再開するときはまずここを読む。

設計 (不変条件): `docs/ui-redesign.md`
進捗 (生きた状態): 本ファイル

最終更新: 2026-04-26 / P3 完了時点

---

## 全体ステータス

| Phase | 状態 | 完了条件 |
|-------|------|---------|
| P0 セットアップ + topbar + SSE dot | ✅ done | topbar + SSE dot が live 表示 |
| P1 Sessions / Pending pane (読み取り) | ✅ done | 既存 API から一覧が出る |
| P2 NewSessionDialog + 自動 attach | ✅ done | launch → 入力できる |
| P3 セッション切替 + Rename + Shell + drag-resize | ✅ done | 痛点 (a)(b)(c) 解決 |
| P4 Pending Approve/Deny + Audit accordion | ☐ todo | Pending 業務完結 |
| P5 Settings (Sidecars / Audit / Keybinds / Prefs) | ☐ todo | 機能パリティ |
| P6 Keyboard shortcuts + focus trap + a11y | ☐ todo | 完了 |
| P7 旧 `src/ui/frontend/` 削除 + build target 切替 | ☐ todo | ship |

---

## 完了済みコミット

### P0 (3 commits, 2026-04-26)

| hash | message |
|------|---------|
| `12ca9a7` | chore(ui-next): scaffold Solid frontend-next with self-rolled Bun glue |
| `b872145` | feat(ui-next): serve dist-next via daemon and port topbar + 3-pane shell |
| `7d3301f` | feat(ui-next): wire SSE connection indicator with offline grace fallback |

検証状態: `bun run check` pass / `bun test src/` 1417 pass / 7 skip / 0 fail / `bun run build-ui-next` success

### P1 (4 commits + 1 follow-up fix, 2026-04-26)

| hash | message |
|------|---------|
| `97aa843` | feat(ui-next): add sessions and pending stores with normalization |
| `3032c82` | feat(ui-next): dispatch SSE named events into stores via useConnection |
| `e5964fe` | feat(ui-next): render sessions list bound to store |
| `bd2b637` | feat(ui-next): render pending cards bound to store (read-only) |
| `4d3c094` | fix(ui): walk nested subdirectories under dist/assets |

検証状態: `bun test src/ui/frontend-next/` 63 pass / 0 fail / `bun run check` clean / `bun run build-ui-next` success / `bun test src/ui/` 303 pass / 0 fail (preloadAssets 再帰対応の追加テスト含む)

### P2 (7 commits, 2026-04-26)

| hash | message |
|------|---------|
| `85ca8b9` | build(ui-next): inline xterm.css into bundled stylesheet |
| `f909112` | feat(ui-next): add terminalsStore for dtach sessions and active id |
| `5eaab56` | feat(ui-next): wire terminal:sessions SSE into terminalsStore |
| `8061fcb` | feat(ui-next): add api client and wsToken helper for launch and terminal |
| `b619fc4` | feat(ui-next): extract attachTerminalSession (xterm + ws lifecycle) |
| `535e78f` | feat(ui-next): mount terminal in TerminalPane bound to activeId |
| `8c7dbe9` | feat(ui-next): wire NewSessionDialog to launch and auto-activate terminal |

検証状態: `bun run check` clean / `bun test src/ui/frontend-next/` 132 pass / 0 fail (251 expect, 14 files) / `bun run build-ui-next` success (387.84 kB main.js) / `bun test src/` 1554 pass / 7 skip / 0 fail (regression なし)

### P3 (2026-04-26, landing order)

| hash | message |
|------|---------|
| `7312172` | feat(ui-next): expose containerName and lastEventAt on SessionRow |
| `7921608` | feat(ui-next): add HttpError, ackSessionTurn, renameSession, stopContainer, startShell to api client |
| `1248f01` | feat(ui-next): wire row click to selectSession with closest-check guard |
| `793b10c` | feat(ui-next): keep-alive terminal handles via reconcileTerminals reducer |
| `79cfdde` | feat(ui-next): drag-resize panes with uiStore-backed widths and right-pane collapse |
| `b760538` | feat(ui-next): center-pane Toolbar with ack, search, font-size, kill-clients |
| `b0b840b` | feat(ui-next): inline session row actions stop, rename, shell with optimistic state |
| `341657d` | feat(ui-next): shell toggle and per-session view restore via terminalsStore.viewBySession |
| `d2d9ff4` | refactor(ui-next): inline validateName into editableSessionNameLogic |
| `64cfa7a` | refactor(ui-next): clarify shell toggle toolbar state |
| `ce10aa4` | feat(ui-next): add renderIdle slot for toolbar rename |
| `8b31557` | refactor(ui-next): switch SessionsPane rename to title triggers |

検証状態: 各 commit で `bun run check` clean / `bun test src/ui/frontend-next/` pass / `bun run build-ui-next` success

レビュー差し戻し: Commit 2 (design + test-coverage) / Commit 5 (design 4 + error-handling 1 + test-coverage 3) / Commit 6 (design 2) / Commit 7 (tombstone 1 + design 3)。いずれも 1 iteration で approve。Commit 4 で URL spec の typo を implementer が検出 (orchestrator 修正後に再投入)。Commit 7 は biome a11y (`useKeyWithClickEvents`) を pre-commit hook で捕捉、`stopPropagation` を `e.target === e.currentTarget` パターンに置換して解消。

---

## ビルド・起動方法 (動作確認)

```bash
# terminal A: frontend-next の継続ビルド (Bun 1.3.9 では 500ms polling fallback)
bun run build-ui-next --watch

# terminal B: daemon を NAS_UI_NEXT=1 で起動 (frontend-next を serve)
NAS_UI_NEXT=1 bun run dev -- ui --port 3939 --no-open

# ブラウザで http://localhost:3939
```

- `NAS_UI_NEXT` 未設定だと既存 Preact UI が serve される (regression 確認に使える)
- 起動ログに `[nas] UI mode: next` または `classic` が出る
- P0 動作確認: topbar の LIVE dot が teal で `breathe` アニメーション。daemon kill → 5s 後 offline (muted dot) → 再起動で即 live 復帰
- P1 動作確認: 起動直後は左 `No sessions` / 右 `Network · out 00` `Host exec · cmd 00` の空表示。`nas <profile>` で agent 起動すると左 pane に行が追加され、turn 値で dot/badge が切り替わる (`user-turn` → amber pulse + `Turn` バッジ / `agent-turn` → teal dim + `Busy` バッジ)。allowlist 外 curl や hostexec 必要な操作で右 pane にカードが追加、相対時刻が 1 秒ごとに更新される。Approve/Deny/scope ボタンは `disabled` で無反応 (read-only 仕様)
- P2 動作確認: 中央 pane は initial state で `Launch a session to attach a terminal` の placeholder。Topbar の `+ new session` をクリックすると dialog が開き、profile / cwd / worktree (none/main/current/custom) / sessionName を入力できる。cwd を切替えると `Loading branches...` を経て worktree 選択肢が更新される。Launch を押すと dialog が閉じ、左 pane に行が追加され、数秒以内に中央 pane で xterm が立ち上がりプロンプトが表示・入力可能になる (= 自動 attach)。launch validation エラー (profile 空など) では dialog 内に赤字でメッセージが出て dialog は閉じない。submit 中は Cancel / Esc / backdrop click のいずれも無視される (`tryClose` が `submitting()` でガード)。daemon を kill すると 5s 後に Topbar が offline になり、xterm 側に Disconnected エラーが出る
- P3 動作確認: 左 pane の row click で中央 pane の terminal が切り替わり、行き来しても scrollback が残る。Toolbar context は `AGENT` / `SHELL` バッジと `Open shell` / `Return to agent` / `Spawning…` を切り替える。手動確認スコープは rename の未テスト DOM 経路に絞る: (1) SessionsPane title の double-click が inline edit を開き、Enter で確定し、Esc で破棄する (2) Toolbar context name の double-click が同じ edit 経路を開き、Enter で確定し、Esc で破棄する (3) 保存中に別 row へ切り替えても edit 状態が漏れない
- 既知の未実装 (P4): Pending Approve/Deny / scope selector / Audit アコーディオンは未配線。右 pane は read-only 表示のまま

---

## 採択した技術スタック (`docs/ui-redesign.md` §5 決定事項より)

- フロント: **Solid 1.9** (Preact 不採用)
- ビルド: **Bun.build + 自前 Bun.plugin (`scripts/solid_plugin.ts`)** + `babel-preset-solid` + `@babel/preset-typescript`
  - `bun-plugin-solid` (1年メンテ無し) は不採用
  - Vite + `vite-plugin-solid` + dev proxy も不採用 (WebSocket / CORS / SSE の取り回しが複雑になる)
- 配信: **既存 daemon (`src/ui/server.ts`) を `NAS_UI_NEXT=1` で `dist-next/` 切替**。別ポート / proxy server なし
- フォント: **`@fontsource-variable/geist-mono` を self-host** (Google Fonts 不採用)。calligraphic 排除、mono 一本
- 型チェック: production は `tsconfig.json` (`types: []`)、test は `tsconfig.test.json` (`types: ["bun-types"]`)
- テスト: `bun:test` + 純関数 + DI (Solid runtime に依存しない)

---

## ディレクトリ構成 (P2 完了時点)

```
src/ui/frontend-next/
  index.html.tmpl                      # {{NAS_WS_TOKEN}} / {{CSS}} / {{JS}} placeholder
  tsconfig.json                        # production (types: [])
  tsconfig.test.json                   # test (types: ["bun-types"])
  README.md                            # dev workflow など (xterm.css inline 含む)
  src/
    ambient.d.ts                       # *.css, fontsource 宣言
    main.tsx                           # entry: fontsource import + render
    App.tsx                            # .app grid + stores と dispatch、Topbar / TerminalPane / NewSessionDialog 配線
    styles.css                         # shell rule + Sessions 行 / Pending カード / .terminal-empty / .terminal-error / .dialog-* CSS
    api/
      client.ts                        # request<T> + launch / terminal の 5 関数。encodeURIComponent / silent success 禁止
      client_test.ts                   # 9 ケース (header / 4xx / fetch reject / non-JSON / URL encoding x2)
      wsToken.ts                       # getWsToken(doc) — meta 不在 / 空 / placeholder で必ず throw
      wsToken_test.ts                  # 4 ケース
    components/
      Topbar.tsx                       # connected + onNewSession (required prop)
      SessionsPane.tsx                 # 左 pane <For> 描画、turn → dot/badge mapping を sessionRowView から
      sessionRowView.ts                # 純関数: describeSessionRow / formatSessionTree
      sessionRowView_test.ts           # 8 ケース
      TerminalPane.tsx                 # 中央 pane: onMount + createEffect で activeId を観測し attachTerminalSession を mount/dispose、errorMessage signal で UI 表示
      terminalPaneTransition.ts        # 純関数: pickTerminalAction(prev, next) → "noop" | "mount" | "remount" | "unmount"
      terminalPaneTransition_test.ts   # 5 ケース
      PendingPane.tsx                  # 右 pane <For> 描画 (Network / HostExec)、setInterval で 1s tick
      pendingCardView.ts               # 純関数: formatRelativeTime / sessionLabel
      pendingCardView_test.ts          # 13 ケース
      StatusBar.tsx                    # footer 最低限
    dialogs/
      NewSessionDialog.tsx             # Solid Dialog: launchInfo / launchBranches 2 段階 fetch、submit で launchSession → onLaunched(sessionId)。tryClose で submit 中の dismiss を抑止
      newSessionForm.ts                # 純関数: pickWorktreeBase / pickEffectiveCwd / reconcileWorktreeChoice
      newSessionForm_test.ts           # 18 ケース
    hooks/
      createConnectionController.ts        # 純関数 + DI、5000ms grace / 3000ms backoff、named-event 購読
      createConnectionController_test.ts   # 8 ケース
      createSseDispatch.ts                 # SSE_EVENT_NAMES (4 要素: containers / network:pending / hostexec:pending / terminal:sessions) + extractItems + 4 イベント分岐
      createSseDispatch_test.ts            # 8 ケース (terminal:sessions valid/invalid 含む)
      useConnection.ts                     # Solid 薄 wrapper
    stores/
      types.ts                         # SSE payload Like 型 + UI 用 SessionRow 型 + DtachSessionLike
      sessionId.ts                     # shortenSessionId (共通 helper)
      sessionId_test.ts                # 3 ケース
      sessionsStore.ts                 # createStore + accessor
      sessionsStore_test.ts            # 9 ケース
      pendingStore.ts                  # network / hostexec
      pendingStore_test.ts             # 11 ケース
      terminalsStore.ts                # dtachSessions / activeId / pendingActivateId。requestActivate (launch 後の race 吸収) / setActive (P3 行クリック用) を分離
      terminalsStore_test.ts           # 10 ケース (set / pending 昇格 / pending 上書き / setActive / activeId 失効 / immediate-activate での pending クリア / pending と activeId 失効が同時)
    terminal/
      attachTerminalSession.ts         # xterm + WS lifecycle factory (Solid 非依存、DI seam: createTerminal / createWebSocket / createFitAddon / setTimeoutFn / clearTimeoutFn / onError)。dispose 冒頭で ws ハンドラ null 化 + 内側 nudge timer も全 clear。エラー経路は onError で surface (構築時 throw も吸収して NOOP_HANDLE 返却)
      attachTerminalSession_test.ts    # 13 ケース (mount / dispose / initial resize / dtach 1s nudge / 異常 close / 正常 close / onData → ws.send / 構築時 throw / setFontSize / ws.onerror / dispose 内 onError 経路 / inner timer cancel)
      terminalInput.ts                 # キー入力フォワーディング (旧 frontend から複製、P7 で統合)
      terminalSize.ts                  # cols/rows 計算と resize 送信
      terminalSize_test.ts             # 8 ケース
  design/
    control-room.html                  # 静的モック (CSS の正本)

scripts/
  build_ui_next.ts                     # Bun.build + index.html.tmpl 展開 + woff2 cp + xterm.css inline (bundledCss 先頭)
  solid_plugin.ts                      # Bun.plugin + babel glue (~50行)
  solid_plugin_test.ts                 # 2 ケース

src/ui/
  server.ts                            # resolveDistBase(env) + preloadAssets (assets/ ネスト対応)
  server_dist_base_test.ts             # 4 ケース
  server_preload_assets_test.ts        # 5 ケース
  dist-next/                           # ビルド出力 (.gitignore 対象)
```

---

## 次セッションで P4 に着手する手順

**P4 完了条件**: Pending pane で Approve/Deny と scope selector が完結し、Audit アコーディオンで直近ログを確認できる。

### 作業の流れ (planner 投入時の参考)

1. **Pending Approve/Deny の配線**
   - Network / HostExec の approve / deny API を右 pane から呼び出す
   - busy / error 表示はカード単位で閉じる
2. **scope selector の状態管理**
   - Pending card ごとの選択値を UI state に寄せる
   - SSE 更新後も requestId 単位で選択を維持するかどうかを helper で固定する
3. **Audit アコーディオン**
   - right pane 下段に default closed のアコーディオンを置く
   - 直近ログの取得と再描画を Pending と干渉させない
4. **手動確認**
   - Approve / Deny 後に Pending からカードが消え、Audit に decision が出ることを確認する
   - accordion 開閉が terminal 操作と干渉しないことを確認する

### `/implement-with-review` skill で進める場合のメモ

- protected dirty paths: 着手時に `git status --short` で確認
- scope 外: `src/ui/frontend/`, `scripts/build_ui.ts`, `flake.nix` (P7 まで不変)
- review-config: `error-handling` / `security` / `design` / `tombstone-comments` / `test-coverage` がいずれも `no_findings` (warning でも差し戻し)
- 旧 frontend からの複製 (`terminalInput.ts` / `terminalSize.ts` / `api.ts` 一部) は P7 で旧 UI 削除と同時に解消する。P3 で新 API を足すときも同じ規約で複製しつつ、各 commit message に DRY 例外を明記
- a11y: P2 で `useKeyWithClickEvents` を `e.target === e.currentTarget` パターンで回避している。P4 でも button semantics を優先し、click handler を載せる要素の keyboard alternative を欠かさない

---

## 既知の TBD / 未決事項

- **routes 設計** (`docs/ui-redesign.md` §7): `#/settings/...` の hash routing か `@solidjs/router` か未決。**判断期限: P5 着手前**
- **キーボードショートカットの上書き**: `docs/ui-redesign.md` §8 末尾 "Settings で上書き可（将来）" は P6 以降の判断事項

---

## 設計メモ: `pendingActivateId` の流入経路

`pendingActivateId` is driven by the launch flow and the shell-spawn flow only. Both routes set the value through `requestActivate` once the API call returns the dtach session id, and the next `setDtachSessions` snapshot promotes it to `activeId`. The keep-alive layer keys mount/dispose on `dtachSessions` membership rather than `activeId`, so a stale pending entry cannot pin a vanished session in memory: the next snapshot either confirms the id (promoting it) or carries a different shape (pending stays in place but no terminal handle is mounted on its behalf).

---

## P0 で踏んだ罠と回避策 (再発防止メモ)

- **`Bun.build` の `watch: true` が Bun 1.3.9 で未公開** → `scripts/build_ui_next.ts` で `--watch` フラグ時に 500ms polling fallback
- **fontsource side-effect import で `dist-next/assets/main.css` が emit されるが index.html から link されない** → `build_ui_next.ts` で main.css を styles.css と一緒に inline 結合
- **frontend-next tsconfig が `types: []` だと `bun:test` の型が解決できない** → `tsconfig.test.json` を分離 (production と test の責務分離、`exclude` を `["node_modules"]` に override して test ファイルを include)
- **Biome `noSvgWithoutTitle` で gear icon SVG が blocking** → `aria-hidden="true"` (button 側に既に `aria-label="Settings"` があるため SVG は装飾扱い)
- **`@babel/core` 等の型不在** → `@types/babel__core` を追加せず `@ts-expect-error` 3行で対処 (deps 最小化)
- **`bun.lock` 変更で `bun.nix` が stale** → `bun install` 後に必ず `bun run bun2nix -o bun.nix` を走らせる
- **`build_ui_next.ts` が `assets/fonts/` サブディレクトリを作るが `server.ts:preloadAssets` が flat readdir 前提で EISDIR クラッシュ** → `4d3c094` で `readdir({ withFileTypes: true })` + 再帰 walk に変更。`server_preload_assets_test.ts` で nested fixture を pin。frontend-next 配信を初めて起動した P1 動作確認時に表面化したリグレッションで、P0 時点では classic dist/ が flat だったため未検出だった

## P1 で踏んだ罠と回避策 (再発防止メモ)

- **`createConnectionController` に `DEFAULT_EVENT_NAMES` を持たせると app vocabulary が lifecycle 層に漏れる** → review で差し戻し、`createSseDispatch.SSE_EVENT_NAMES` に移し、controller は `eventNames?: readonly string[]` (default `[]`) として vocabulary を一切知らない形に。`useConnection` に `UseConnectionOptions.eventNames` を生やして App.tsx から渡す
- **`shortenSessionId` が両 store に重複** → review で差し戻し、`stores/sessionId.ts` に共通 helper として抽出。`stop_when: no_findings` 設定下では DRY 違反も blocking
- **JSON.parse 失敗の silent catch** → Preact 側 `useSSE.ts` の空 catch 慣習を踏襲しないよう、`createConnectionController` の named-event listener では `console.warn(name, e)` で必ず surface してから当該 payload だけ skip
- **Pending pane の `setInterval` 解放忘れリスク** → `onCleanup(() => clearInterval(...))` を必ず対にする。1 秒 tick で `formatRelativeTime(now)` を再評価する設計

## P2 で踏んだ罠と回避策 (再発防止メモ)

- **`requestActivate` の immediate-activate パスで stale pending が残る** → `requestActivate("a")` 後に dtach 一覧に既にある "b" を `requestActivate("b")` すると、`activeId="b"` は立つが `pendingActivateId="a"` が残り、後続 SSE で "a" が出現すると意図せず activeId を上書きする bug。code-reviewer に差し戻され、immediate-activate パス内でも `s.pendingActivateId = null` を必ず実行する形に。境界条件は `terminalsStore_test.ts` の "requestActivate clears stale pending when the new id is already present" で pin
- **xterm.css が build に inline されないと viewport が壊れる** → `scripts/build_ui.ts` (旧) は inline していたが `build_ui_next.ts` には未実装だった。Commit 1 で `node_modules/@xterm/xterm/css/xterm.css` を `bundledCss` の先頭に concatenate する処理を追加。失敗時は path 付きで throw
- **`SseDispatchStores` の doc コメントから消費イベントを抜き忘れる** → `terminal:sessions` を consume するようになった後も「未消費イベントの例」一覧に残すと tombstone 違反 (review-config 上 blocking)。Commit 3 で同 commit 内に doc コメント修正を含めた
- **`fetch` の DI を `globalThis.fetch` に逃がしたら Bun の `typeof fetch` が `preconnect` プロパティを要求して TS エラー** → test 内で `installFetch` 引数の型を `(input, init?) => Promise<Response>` の simpler shape に narrow し、代入時のみ `as unknown as FetchFn` でキャスト
- **`attachTerminalSession` の `dispose` 後に `ws.onclose`/`ws.onerror` が `reportError` を呼ぶ** → `disposed=true` をセットしただけでは ws ハンドラは残るため、通常 close (code 1005) で reportError が誤発火する。Commit 5 で dispose 冒頭に `ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null` を追加。`armDtachInitialResizeNudge` の内側 setTimeout も `timeoutHandles` に push して全 clear
- **`createTerminal` DI seam の契約乖離による二重 open リスク** → fake と本物経路で `loadAddon`/`open` の呼び方が違うと、本物の Terminal を渡したとき二重 open する。Commit 5 で `createDefaultTerminal` に「new Terminal のみ」の責務を絞り、`loadAddon`/`open` は本体側で一律実行する形に統一
- **errorMessage を unmount 時にリセットし忘れて empty placeholder と error UI が重なる** → Commit 6 で `unmount` 内に `setErrorMessage(null)` を追加。`<Show when={errorMessage()}>` の表示条件を絞る選択肢もあったが、source of truth を一箇所にする選択を採用
- **Solid `onMount` と `createEffect` の登録順依存** → 同じ component 内で `onMount` を先に登録し `prevActiveId` を初期化、その後 `createEffect` を登録することで「effect の初回実行時に prev === next となり noop」になる。順序を入れ替えると初回 attach が二重に走る。Commit 6 で doc コメントに登録順依存を明示
- **`request<T>` の URL 組み立てで `cwd` / `sessionId` を encodeURIComponent し忘れると path traversal や 404 になる** → Commit 4 で全箇所に `encodeURIComponent` を入れ、`getLaunchBranches` (空白・日本語) と `killTerminalClients` (`/` `&`) のテストで pin
- **`getWsToken` の placeholder (`{{NAS_WS_TOKEN}}`) を silent fallback すると spoofable な WS を作る** → Commit 4 で必ず throw する形に。理由を doc コメントに現在形で明記
- **dialog の Esc / backdrop / Cancel が `submitting()` を bypass** → Cancel button だけ disabled でも、Esc / backdrop click は in-flight submit を中断できてしまう。Commit 7 で `tryClose` ヘルパーに集約
- **biome `useKeyWithClickEvents` が dialog 内側 div の `onClick={(e) => e.stopPropagation()}` を blocking** → `e.target === e.currentTarget` チェックを overlay 側に集約することで、内側 div から `onClick` を完全に除去。a11y rule への自然な対応として推奨パターン
- **plan の URL spec typo を implementer が検出** → `killTerminalClients` の URL を `/api/terminal/sessions/{id}/kill-clients` と書いていたが正しくは `/api/terminal/{id}/kill-clients`。implementer が `src/ui/routes/api.ts` と旧 `api.ts` の double-check で blocked を返したのが正解。orchestrator は plan を盲信させないこと

---

## P3 で踏んだ罠と回避策 (再発防止メモ)

- **shell view の Toolbar context は agent row と active terminal id を分けて持つ必要がある** → `describeTerminalToolbarContext` が `contextAgentRow` と `ackTargetSessionId` を parent agent session に固定し、`activeTerminalId` は表示中 terminal の id を保つ。これで Ack / rename は agent 側を向き、Search / Kill clients は表示中 terminal 側を向く
- **`shellSpawnInFlight` の in-flight 表示は AGENT に固定する必要がある** → `describeShellToggle` の anchor コメントが `in-flight = AGENT` 契約を守る。spawn 中でも表示先は agent terminal のままなので badge は AGENT を保つ
- **Toolbar rename と SessionsPane rename は同じ start 経路に揃える必要がある** → 両方の dblclick は `renderIdle` slot から start action を呼ぶ。`<input>` と `.rename-edit` wrapper は入力イベントを `stopPropagation` で隔離し、row selection や toolbar click へ漏らさない
- **`renderIdle` の DOM 経路は reducer test だけでは固定できない** → 手動確認で rename の未テスト DOM 経路を押さえる。手順: (1) Toolbar context の session 名を dblclick して inline edit を開き、入力して Enter で確定する (2) SessionsPane の session 名でも同じ手順を通し、Esc で破棄する (3) 保存中に別 row へ切り替えても edit 状態が漏れないことを確認する

---

## 進捗を更新するルール

- 1 phase 完了 (= 完了条件達成) ごとに本ファイル冒頭の Phase ステータス表を更新
- コミットしたら **完了済みコミット** セクションに hash + message を追記
- 設計を変更したら `docs/ui-redesign.md` 本体も同時更新 (§5 決定事項 / §6 新 UI 設計 / §9 phases)
- TBD が解消したら本ファイル「既知の TBD」から外す
- 新たな TBD が発生したら同セクションに追加 (判断期限を併記)
- ファイル冒頭の「最終更新」を更新
