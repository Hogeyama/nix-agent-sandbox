# nas UI 再設計 — 進捗管理

`docs/ui-redesign.md` の設計に基づく実装の進捗トラッカ。新しいセッションで再開するときはまずここを読む。

設計 (不変条件): `docs/ui-redesign.md`
進捗 (生きた状態): 本ファイル

最終更新: 2026-04-26 / P1 完了時点

---

## 全体ステータス

| Phase | 状態 | 完了条件 |
|-------|------|---------|
| P0 セットアップ + topbar + SSE dot | ✅ done | topbar + SSE dot が live 表示 |
| P1 Sessions / Pending pane (読み取り) | ✅ done | 既存 API から一覧が出る |
| P2 NewSessionDialog + 自動 attach | ☐ todo | launch → 入力できる |
| P3 セッション切替 + Detach/Stop/Rename + Shell + drag-resize | ☐ todo | 痛点 (a)(b)(c) 解決 |
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
- 既知の未実装 (P2-P3): `+ New Session` 反応なし / 行クリックでセッション切替なし / 中央 pane 空 / pane drag-resize なし / 右 pane 折りたたみ無効 (collapse ボタン disabled)

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

## ディレクトリ構成 (P1 完了時点)

```
src/ui/frontend-next/
  index.html.tmpl                      # {{NAS_WS_TOKEN}} / {{CSS}} / {{JS}} placeholder
  tsconfig.json                        # production (types: [])
  tsconfig.test.json                   # test (types: ["bun-types"])
  README.md                            # dev workflow など
  src/
    ambient.d.ts                       # *.css, fontsource 宣言
    main.tsx                           # entry: fontsource import + render
    App.tsx                            # .app grid + Topbar + workspace + StatusBar、stores と dispatch を生成して useConnection と panes に配線
    styles.css                         # control-room.html の shell rule + .live.offline + Sessions 行 / Pending カード CSS
    components/
      Topbar.tsx                       # connected prop + classList offline
      SessionsPane.tsx                 # 左 pane <For> 描画、turn → dot/badge mapping を sessionRowView から
      sessionRowView.ts                # 純関数: describeSessionRow / formatSessionTree
      sessionRowView_test.ts           # 8 ケース (turn / worktree フォールバック)
      TerminalPane.tsx                 # 中央 pane 外枠 (空、P2-P3 で実装)
      PendingPane.tsx                  # 右 pane <For> 描画 (Network / HostExec)、setInterval で 1s tick
      pendingCardView.ts               # 純関数: formatRelativeTime / sessionLabel
      pendingCardView_test.ts          # 13 ケース (時間境界 / 未来 clamp / sessionName フォールバック)
      StatusBar.tsx                    # footer 最低限
    stores/
      types.ts                         # SSE payload Like 型 + UI 用 SessionRow 型
      sessionId.ts                     # shortenSessionId (両 store 共通 helper)
      sessionId_test.ts                # 3 ケース
      sessionsStore.ts                 # createStore + accessor。containers payload を normalize
      sessionsStore_test.ts            # 9 ケース (sidecar 除外 / フィールドフォールバック)
      pendingStore.ts                  # network / hostexec 2 セット accessor
      pendingStore_test.ts             # 11 ケース (verb default / argv join / ISO parse 失敗)
    hooks/
      createConnectionController.ts        # 純関数 + DI、5000ms grace / 3000ms backoff、named-event 購読
      createConnectionController_test.ts   # 8 ケース (5 既存 + onEvent 経路 3)
      createSseDispatch.ts                 # SSE_EVENT_NAMES + extractItems + 3 イベント分岐
      createSseDispatch_test.ts            # 5 ケース
      useConnection.ts                     # Solid 薄 wrapper、UseConnectionOptions で eventNames 受け渡し
  design/
    control-room.html                  # 静的モック (ビルド対象外、CSS の正本)

scripts/
  build_ui_next.ts                     # Bun.build + index.html.tmpl 展開 + woff2 cp + assertion
  solid_plugin.ts                      # Bun.plugin + babel glue (~50行)
  solid_plugin_test.ts                 # 2 ケース (TSX 変換 / .ts filter)

src/ui/
  server.ts                            # resolveDistBase(env) + preloadAssets (assets/ ネスト対応)
  server_dist_base_test.ts             # 4 ケース pin (unset / "1" / "0" / "true")
  server_preload_assets_test.ts        # 5 ケース (nested fonts/ / 不在 / 空 / 深いネスト)
  dist-next/                           # ビルド出力 (.gitignore 対象)
```

---

## 次セッションで P2 に着手する手順

**P2 完了条件**: NewSessionDialog + 自動 attach。`+ New Session` ボタンから dialog → `POST /api/launch` → containers SSE で行追加 → 中央 pane に xterm が立ち上がって入力できる、までが繋がる。

### 作業の流れ (planner 投入時の参考)

1. **`stores/terminalsStore.ts` を追加** (Solid `createStore`)
   - `dtachSessions` (id → metadata) と `activeId` を保持
   - `terminal:sessions` SSE を `createSseDispatch` の switch に足す
2. **`hooks/useXTerm.ts` / `hooks/useTerminalWS.ts` を新設**
   - 既存 Preact `TerminalModal.tsx` (846行) の xterm 初期化と WS lifecycle を pure 関数 + DI で抽出
   - 設計 §7 のフォルダ構成に揃える
3. **`components/TerminalPane/` を実装**
   - `index.tsx` で activeId に対応する xterm を mount、非表示 session の WS は keep-alive
   - 中央 pane の Toolbar (`docs/ui-redesign.md` §6.3) は最小実装で良い (ack/shell/search は P3 へ)
4. **`dialogs/NewSessionDialog.tsx`**
   - Preact 版 `NewSessionDialog.tsx` (456行) の profile / cwd / worktree / sessionName 入力 UI を Solid 化
   - launch 成功で取得した sessionId を `terminalsStore` に流し込み、自動 attach
5. **Topbar の `+ New Session` ボタンに handler 配線**
   - dialog open / close
   - 既知の TBD「`+ New Session` の disabled 化」はこの commit で同時に解消

### `/implement-with-review` skill で進める場合のメモ

- protected dirty paths: 着手時に `git status --short` で確認
- scope 外: `src/ui/frontend/`, `scripts/build_ui.ts`, `flake.nix` (P7 まで不変)
- review-config: `error-handling` / `security` / `design` / `tombstone-comments` / `test-coverage` がいずれも `no_findings` (warning でも差し戻し)
- Commit 粒度の目安: terminalsStore + dispatch 拡張 → useXTerm/useTerminalWS 抽出 → TerminalPane mount → NewSessionDialog → launch wiring の 4-5 commits
- xterm.js は既存 Preact 版で動いているので、import はそちらと同じ npm package で問題なし。WebSocket auth トークンは `index.html` の `<meta name="nas-ws-token">` に既に注入されている (P0 で確認済)

---

## 既知の TBD / 未決事項

- **routes 設計** (`docs/ui-redesign.md` §7): `#/settings/...` の hash routing か `@solidjs/router` か未決。**判断期限: P5 着手前**
- **`+ New Session` ボタン**: P0 で markup だけ存在 (handler 無し)。**判断期限: P2 で NewSessionDialog をマウントする時に同時 wiring**
- **キーボードショートカットの上書き**: `docs/ui-redesign.md` §8 末尾 "Settings で上書き可（将来）" は P6 以降の判断事項
- **`+ New Session` の disabled 化**: 現状クリックしても無反応で a11y 違反。P2 まで放置するなら `disabled` 属性を入れた方が誠実 (P2 着手と同時に handler 配線で解消する想定)
- **行クリックでセッション切替**: P1 完了時点で `cursor: pointer` だけ付与され listener なし。**判断期限: P3 着手時** (P2 で attach は自動化されるため、P2 中は単一 session 前提で運用可能)

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

---

## 進捗を更新するルール

- 1 phase 完了 (= 完了条件達成) ごとに本ファイル冒頭の Phase ステータス表を更新
- コミットしたら **完了済みコミット** セクションに hash + message を追記
- 設計を変更したら `docs/ui-redesign.md` 本体も同時更新 (§5 決定事項 / §6 新 UI 設計 / §9 phases)
- TBD が解消したら本ファイル「既知の TBD」から外す
- 新たな TBD が発生したら同セクションに追加 (判断期限を併記)
- ファイル冒頭の「最終更新」を更新
