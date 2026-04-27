# nas UI 再設計 — 進捗管理

`docs/ui-redesign.md` の設計に基づく実装の進捗トラッカ。新しいセッションで再開するときはまずここを読む。

設計 (不変条件): `docs/ui-redesign.md`
進捗 (生きた状態): 本ファイル

最終更新: 2026-04-27 / P6 完了時点

---

## 全体ステータス

| Phase | 状態 | 完了条件 |
|-------|------|---------|
| P0 セットアップ + topbar + SSE dot | ✅ done | topbar + SSE dot が live 表示 |
| P1 Sessions / Pending pane (読み取り) | ✅ done | 既存 API から一覧が出る |
| P2 NewSessionDialog + 自動 attach | ✅ done | launch → 入力できる |
| P3 セッション切替 + Rename + Shell + drag-resize | ✅ done | 痛点 (a)(b)(c) 解決 |
| P4 Pending Approve/Deny + Audit accordion | ✅ done | Pending 業務完結 |
| P5 Settings (Sidecars / Audit / Keybinds / Prefs) | ✅ done | 機能パリティ |
| P6 Keyboard shortcuts + focus trap + a11y | ✅ done | 完了 |
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

### P4 (6 commits + chore, landing order)

| hash | message |
|------|---------|
| `b4de00a` | feat(ui-next): model pending request identity and approval actions |
| `26f8cd4` | feat(ui-next): wire pending card actions with keyed scope state |
| `7a04524` | feat(ui-next): stream audit logs into pending pane accordion |
| `197efce` | feat(ui-next): show pending indicator on sessions with awaiting approvals |
| `143d128` | feat(ui-next): show favicon badge from max session lamp |
| `d546c31` | feat(ui-next): light session row dot when approvals pend |

主要追加: `handlers/createPendingActionHandlers.ts` (approve/deny API + busy/error 配線) / `stores/pendingActionStore.ts` (key 単位の inFlight + scope 選択 + error message) / `stores/pendingRequestKey.ts` (`<domain>|<sessionId>|<requestId>` 形式の key 生成) / `stores/reconcilePendingActionState.ts` (SSE 更新で消えた key の状態を gc) / `components/sessionPendingSummary.ts` + `components/sessionLamp.ts` (Sessions 行への "Approvals pending" 表示と amber dot 同期) / `hooks/useFaviconBadge.ts` (max lamp を favicon に反映)。Audit accordion は default closed、展開で直近 50 件を fetch、Pending と SSE は独立に更新。

検証状態: `bun run check` clean / `bun test src/ui/frontend-next/` pass / `bun run build-ui-next` success

### P5 (5 commits, landing order)

| hash | message |
|------|---------|
| `0e2845b` | feat(ui-next): add hash-based router with workspace and settings shell |
| `7c34e9f` | feat(ui-next): render Sidecars settings page with stop action |
| `0fc3886` | feat(ui-next): render Audit settings page with filter and infinite scroll |
| `fad95ec` | feat(ui-next): render Keyboard shortcuts settings page from static catalog |
| `fd3582f` | feat(ui-next): render Preferences settings page with font size and pane reset |

主要追加: `routes/router.ts` + `routes/router_test.ts` (`#/` workspace / `#/settings/{sidecars,audit,keybinds,prefs}` の hash routing、`@solidjs/router` 不採用 — TBD 解消) / `components/settings/SettingsShell.tsx` (左 nav rail + 各 page の `<Show>` 切替、`workspace-hidden` / `settings-shell-hidden` の display:none で view 隔離) / `SidecarsPage.tsx` / `AuditPage.tsx` (filter + 無限スクロール) / `KeybindsPage.tsx` (`keybindsCatalog.ts` の §8 表を静的描画) / `PrefsPage.tsx` (font size + pane size reset) / Topbar の gear icon を anchor (`href="#/settings/sidecars"`) で実装。

検証状態: `bun run check` clean / `bun test src/ui/frontend-next/` pass / `bun run build-ui-next` success

### P6 (7 commits, landing order)

| hash | message |
|------|---------|
| `eda6858` | feat(ui-next): extend matchShortcut with allowInTextField bypass |
| `d6bff52` | feat(ui-next): wire ShortcutSpec into keybinds catalog with allowInTextField |
| `d352de2` | feat(ui-next): build pure shortcut dispatcher driving global hook |
| `0d4ed66` | feat(ui-next): wire global shortcuts to App handlers |
| `abf0670` | feat(ui-next): add selectedPendingKey resolver and wire approve/deny shortcut |
| `c773d9d` | feat(ui-next): add focus trap and aria polish to NewSessionDialog |
| `e750bc5` | feat(ui-next): hide workspace from a11y tree while settings active |

主要追加: `hooks/dispatchShortcut.ts` (catalog id → handler を純関数で dispatch、`Ctrl+1..9` と `Ctrl+Shift+]` は spec=null のためハードコード経路、`Ctrl+Shift+[` は左 pane 非対応で no-op) / `hooks/matchShortcut.ts` 拡張 (`allowInTextField?: boolean` で TEXTAREA / INPUT / contenteditable ガードを opt-out 可) / `keybindsCatalog.ts` 拡張 (`spec` を持つ全エントリに `allowInTextField: true`、`pane.toggleCollapse` に `note` で左非対応を明示) / `handlers/selectedPendingKey.ts` (`document.activeElement.closest('[data-pending-key]')` → network[0] → hostexec[0] の 3 段 fallback、collapsed 時は no-op) / `dialogs/createFocusTrap.ts` (純関数 + DI seam: `getRoot` / `getInitialFocus` / `getActiveElement` / `setFocus`、idempotent activate で再 activate 時に opener を保持) / NewSessionDialog の `aria-labelledby` 化と Tab cycle 配線 / `<main class="workspace">` / SettingsShell `<section>` への `inert` 属性 (a11y tree から外し focus も止める、`aria-hidden` は `noAriaHiddenOnFocusable` リスクで不採用) / PendingPane collapse/expand button の `aria-expanded` + `aria-controls`。

検証状態: 各 commit で `bun run check` clean / `bun test src/ui/frontend-next/` 524 pass / 0 fail / `bun run build-ui-next` success

レビュー差し戻し: Commit 3 (tombstone 2 + design metaKey 非対称 + test-coverage 1) / Commit 6 (design 2: initial focus comment 乖離 + idempotency 未 pin)。いずれも 1 iteration で approve。

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
- P4 動作確認: Network / HostExec カードの Approve / Deny ボタンが活性。scope chip を切り替えて Approve すると右 pane から該当カードが消え、Audit アコーディオン (default closed) を開くと decision がストリーム表示。busy 中の同カードへの再 Approve はストアの inFlight gate で抑止。Sessions pane の row には pending 件数バッジと amber lamp が出て、tab を切り替えなくても Pending 業務が分かる。favicon に最大 lamp の dot が反映 (network=red, hostexec=yellow)
- P5 動作確認: Topbar の gear アイコンで `#/settings/sidecars` に遷移、左 nav から Sidecars / Audit / Keyboard shortcuts / Preferences を切り替え。`#/settings/...` の hash 直打ちでも遷移可能。Sidecars は Stop ボタンが working、Audit は session/domain/activeOnly フィルタと無限スクロールで全件閲覧、Keybinds は §8 表の静的レンダ、Prefs は font size とペイン幅 reset。workspace に戻るときは `#/` または gear から
- P6 動作確認: 全 §8 shortcut が catalog 駆動で発火 — `Ctrl+N` で NewSessionDialog 開、`Ctrl+1..9` で左 pane の rendered order に従って中央 pane 切替、`Ctrl+,` で Sidecars / `Ctrl+?` で Keybinds、`Ctrl+Shift+]` で右 pane collapse、`Ctrl+Shift+A/D` で focused (or 先頭) Pending を Approve/Deny。terminal focus 中・dialog input focus 中いずれでも shortcut が届く (`allowInTextField` opt-in)。NewSessionDialog 内の Tab/Shift+Tab は dialog 内で循環、Esc / Cancel / backdrop で opener へ focus 復帰。Settings 表示中の workspace は `inert` で Tab 巡回・スクリーンリーダー読みから除外、PendingPane collapse/expand button に `aria-expanded` + `aria-controls`

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

## ディレクトリ構成 (P2 完了時点 — P3-P6 で追加された主要ファイルは以下に追記)

P3-P6 で増えたファイル (それ以前の構成は下記ツリーが正本):

```
src/ui/frontend-next/src/
  App.tsx                              # P3-P6 で hash router / pending action / global shortcuts / inert を配線
  routes/
    router.ts                          # P5: hash routing (`#/` workspace / `#/settings/{sidecars,audit,keybinds,prefs}`)
    router_test.ts                     # 5 ケース
  hooks/
    matchShortcut.ts                   # P6: ShortcutSpec.allowInTextField? で TEXTAREA/contenteditable bypass を opt-in
    matchShortcut_test.ts              # 9 ケース
    dispatchShortcut.ts                # P6: catalog id → handler の純関数 dispatcher。Ctrl+1..9 / Ctrl+Shift+] はハードコード経路
    dispatchShortcut_test.ts           # 21 ケース (catalog 経路 / hard-coded / handler 不在 / TEXTAREA bypass / metaKey 対称)
    useGlobalKeyboard.ts               # P3 で右 pane collapse を捌いていた hook を P6 で全 ShortcutHandlers 受け入れに拡張
    useFaviconBadge.ts                 # P4: max lamp を 16x16 Canvas で favicon に反映
  handlers/
    createPendingActionHandlers.ts     # P4: approve/deny API + busy/error 配線、DEFAULT_NETWORK_SCOPE / DEFAULT_HOSTEXEC_SCOPE export
    selectedPendingKey.ts              # P6: focused card → network[0] → hostexec[0] の 3 段 fallback、collapsed 時 no-op
    selectedPendingKey_test.ts         # 9 ケース
  stores/
    pendingActionStore.ts              # P4: key 単位 inFlight / scope 選択 / error message
    pendingRequestKey.ts               # P4: `<domain>|<sessionId>|<requestId>` 形式の key 生成
    reconcilePendingActionState.ts     # P4: SSE 更新で消えた key の状態 gc
    uiStore.ts                         # P3 から、P5/P6 で settings 表示中の inert 連動を追加 (rightCollapsed / leftWidth / rightWidth)
  components/
    sessionPendingSummary.ts           # P4: session id → pending counts の純関数 (memoize 可能 shape)
    sessionLamp.ts                     # P4: lamp 計算 (network/hostexec の優先, max severity)
    PendingPane.tsx                    # P4 で Approve/Deny 配線、P5 で audit accordion、P6 で aria-expanded + aria-controls + data-pending-key + tabindex=-1
    settings/
      SettingsShell.tsx                # P5: 左 nav rail + page <Show>、display:none で workspace と独立、P6 で inert
      SidecarsPage.tsx                 # P5: dind/proxy/envoy 一覧 + Stop ボタン
      AuditPage.tsx                    # P5: filter (session/domain/activeOnly) + 無限スクロール
      KeybindsPage.tsx                 # P5: catalog の §8 表を静的レンダ、P6 で note 表示
      PrefsPage.tsx                    # P5: font size + pane size reset
      keybindsCatalog.ts               # P5 静的 catalog、P6 で `allowInTextField` / `note?` 拡張
      keybindsCatalog_test.ts          # 12+ ケース
  dialogs/
    NewSessionDialog.tsx               # P2 から、P6 で focus trap + aria-labelledby + ref
    createFocusTrap.ts                 # P6: 純関数 + DI (getRoot/getInitialFocus/getActiveElement/setFocus)、idempotent activate
    createFocusTrap_test.ts            # 10 ケース
```

P0-P2 で確立した構成 (下記) は変更なし。

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

## 次セッションで P7 に着手する手順

**P7 完了条件**: 旧 `src/ui/frontend/` (Preact) を削除し、build target を `dist-next/` 一本化。`NAS_UI_NEXT` env flag は除去、daemon は frontend-next のみを serve。

### 作業の流れ (planner 投入時の参考)

1. **旧 frontend からの複製を解消**
   - `terminalInput.ts` / `terminalSize.ts` / `api.ts` の一部は P2-P3 で旧 UI から複製した。frontend-next が正本になるので旧側を削除し、新側で完結させる
   - 各 commit message で DRY 例外を明記してきた経緯があるので、削除 commit でも経緯を残す
2. **`NAS_UI_NEXT` env flag の除去**
   - `src/ui/server.ts` の `resolveDistBase(env)` を `dist-next/` 固定に
   - 起動ログの `[nas] UI mode: next | classic` 分岐も除去
   - regression 用に classic を呼ぶ手段が無くなる旨を doc に明記 (rollback は git revert で)
3. **`scripts/build_ui.ts` (旧) と `dist/` 出力の削除**
   - `package.json` から旧 `build-ui` script を削除
   - `flake.nix` / `bun.nix` で旧 build に依存していた箇所があれば追従
4. **`src/ui/frontend/` の物理削除**
   - 残った旧 components / hooks / types / tests / styles を一括削除
   - 旧 frontend だけが import していた deps があれば `package.json` からも除去
5. **動作確認**
   - daemon を立てて frontend-next が直接 serve されることを確認
   - 旧 UI URL (`?classic` 等) が無効化されていることを確認

### `/implement-with-review` skill で進める場合のメモ

- protected dirty paths: 着手時に `git status --short` で確認
- scope 外: なし (P7 は scope 全開)。ただし `src/cli/` / `src/daemon/` / agent/pipeline 系は touch 不要のはず
- review-config: `error-handling` / `security` / `design` / `tombstone-comments` / `test-coverage` がいずれも `no_findings` (warning でも差し戻し)
- 旧 frontend からの複製 (`terminalInput.ts` / `terminalSize.ts` / `api.ts` 一部) はここで解消する。「旧側にしかなかった機能」が無いか先に grep で確認 (例: 検索機能、ショートカット、バッジロジックの差分)
- a11y: P2 で `useKeyWithClickEvents` を `e.target === e.currentTarget` パターンで回避している。P6 で `aria-keyshortcuts` / `aria-labelledby` / `inert` / `aria-expanded` も導入済。P7 で削除する旧 UI に同等以上の a11y 対応がそろっていることを確認

---

## 既知の TBD / 未決事項

- **キーボードショートカットの上書き**: `docs/ui-redesign.md` §8 末尾 "Settings で上書き可（将来）" は未着手。catalog (`keybindsCatalog.ts`) の `spec` を user override 可能にする道筋は P6 で `dispatchShortcut` が catalog を正本にした関係で素直に乗せやすい。**判断期限: なし (将来要望ベース)**
- **`docs/ui-redesign.md` §11 メモ未対応分**: 「favicon が計画に入ってないのでは」(P4 で対応済) / 「検索が実装されてないのでは」(中央 Toolbar の Ctrl+F は P3 で実装、catalog の `terminal.search` 等は未追加) / 「Session の DIR を tilde expand」「Session の ID から `s_sess_` prefix を除去」は **未対応**。UX polish として P7 完了後に追加 phase で扱う候補

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

## P4 で踏んだ罠と回避策 (再発防止メモ)

- **Pending request の identity を `requestId` 単独にすると network/hostexec 衝突しうる** → `pendingRequestKey.ts` で `<domain>|<sessionId>|<requestId>` 形式の合成 key を導入。store の `inFlight` Set と scope 選択 Map を同じ key で引く。SSE 更新で消えた key の状態は `reconcilePendingActionState` が gc
- **scope 選択を card component の local state に置くと SSE 更新で reset する** → `pendingActionStore.scopeFor(key)` を store 側に集約。SSE で同じ requestId が再到着しても scope が保持される
- **Approve/Deny 中の二重 click は disable だけでは漏れる** → `pendingActionStore.beginAction(key)` で in-flight gate を立てる。エラー時は `endAction(key, message)` でエラー文字列を card に表示
- **Sessions pane に pending count を出すと SSE 更新ごとに rerender が走る** → `sessionPendingSummary.ts` に純関数を切り出し、map (`sessionId → counts`) を memoize。row 単位で `==` 比較できる shape にして `<For>` の reconcile が抑制される
- **favicon の dot 描画はキャンバスから生成するため複数 lamp の優先順を決める必要がある** → `useFaviconBadge` 内で `network > hostexec` の優先で max lamp を計算し、Canvas で 16x16 redraw。lamp 0 件のときは originalFavicon に戻す

## P5 で踏んだ罠と回避策 (再発防止メモ)

- **`@solidjs/router` を入れると build size が膨らむ + SSR / nested route の機能が要らない** → 自前 hash router (`routes/router.ts`, ~60 行) を採用。`hashchange` event を listen して signal を更新、`navigate(hash)` は `window.location.hash = ...` を書くだけ。テストは fake `window` で 5 ケース pin
- **Settings ↔ workspace を `<Show>` で切替えると terminal の WS が unmount で切断する** → `display: none` (`workspace-hidden` class) で **DOM は残したまま視覚だけ隠す**。terminal handles / SSE / WS state は全部 keep-alive
- **`AuditPage` の無限スクロールで Pending pane の audit accordion と同じ API を叩くと race する** → settings 側は `#/settings/audit` で開いた瞬間に独自 fetch、Pending 側 accordion は audit の最近 50 件のみを取る別経路。互いに独立で SSE は両方が listen
- **gear icon の `<a href="#/settings/sidecars">` は `aria-label` だけでは a11y warning が出る** → `<svg aria-hidden="true">` で SVG を装飾扱いにし、anchor 側に `aria-label="Settings"` を付与
- **`KeybindsPage` の表が catalog 由来なので runtime と display が同期するべきだが、`Ctrl+1..9` のような range は `spec: null`** → P5 時点では catalog の `display` 文字列のみを使い、dispatch 連携は P6 で `note?: string` フィールド経由で説明補強

## P6 で踏んだ罠と回避策 (再発防止メモ)

- **catalog 経路 (`matchShortcut`) と hard-coded 経路 (`Ctrl+1..9` / `Ctrl+Shift+]`) で `metaKey` の扱いを揃えないと Cmd 押し下げ時に挙動が分岐する** → review で差し戻し、`matchShortcut` が metaKey を検査しないのに合わせて hard-coded 経路からも `!e.metaKey` を削除。`dispatchShortcut.ts` の doc コメントで対称性の WHY を現在形で明示し、`Ctrl+Meta+N` / `Ctrl+Meta+1` / `Ctrl+Meta+Shift+]` の 3 ケースで invariant を pin
- **focus trap の `previouslyFocused` を毎回上書きすると open() 振動でレース** → review で差し戻し、`activate()` を `previouslyFocused === null` ガード付きの idempotent 操作に変更。「activate を二重に呼んでも opener を保持」をテスト 10 で pin。NewSessionDialog の `createEffect` + `queueMicrotask` で振動した場合でも restore 先は壊れない
- **`<Show when={!loading() && launchInfo()}>` 配下のフォームは activate 時点で未 mount なので initial focus が当たらない** → review 1 周目で「コメントは radio に focus と謳っているが実際は body のまま」と指摘。コメントを実挙動 (loading 中は initial focus 空、Tab cycle と restore は loading 非依存で動く) に書き直し、再 activate で initial focus を当て直す機能は本 phase の scope 外と判断
- **`aria-hidden` を focusable 子のある container に付けると `noAriaHiddenOnFocusable` を踏む** → plan-reviewer の critical 指摘で `aria-hidden` を **採用せず**、HTML5 標準の `inert` 属性に切替。Solid 1.9 の JSX 型に `inert?: boolean` が既に定義されており module augmentation 不要。`display: none` (workspace-hidden / settings-shell-hidden) と二重防御
- **`Ctrl+Shift+A` / `Ctrl+Shift+D` の対象を新 store で持つと SSE で消えた card が selected として残る** → state-less な `selectPendingTarget(activeElement, network, hostexec, collapsed)` 純関数で毎回計算。focused card → network[0] → hostexec[0] の 3 段 fallback、collapsed 時は no-op
- **`document.activeElement` を Solid signal 経由で読むと reactive scope に入って意味がない** → `resolvePendingTarget()` を keydown handler 内で毎回呼ぶ形にし、`pending.network()` / `pending.hostexec()` / `ui.rightCollapsed()` も毎回 accessor を叩く。closure で cache しない
- **`useGlobalKeyboard` の signature を変えると App.tsx の既存呼び出しが壊れる** → 全 handler を optional にして後方互換 (App.tsx の `{ onToggleRightCollapse: ui.toggleRightCollapsed }` 単独呼び出しが Commit 3 完了時点でビルド通過する)。`App.tsx` の handler bind は Commit 4 で初めて拡張
- **`commit -m` の HEREDOC が hostexec policy で permission denied になる** → 長文 commit message は `/tmp/commit*-msg.txt` に Write してから `git commit -F <file>` で渡す。`-m` の HEREDOC inline は短文 (Commit 1-3 で動いていた) と長文 (Commit 4-) で挙動差があるため、長文は file 経由が確実

---

## 進捗を更新するルール

- 1 phase 完了 (= 完了条件達成) ごとに本ファイル冒頭の Phase ステータス表を更新
- コミットしたら **完了済みコミット** セクションに hash + message を追記
- 設計を変更したら `docs/ui-redesign.md` 本体も同時更新 (§5 決定事項 / §6 新 UI 設計 / §9 phases)
- TBD が解消したら本ファイル「既知の TBD」から外す
- 新たな TBD が発生したら同セクションに追加 (判断期限を併記)
- ファイル冒頭の「最終更新」を更新
