# nas UI 再設計 — 進捗管理

`docs/ui-redesign.md` の設計に基づく実装の進捗トラッカ。新しいセッションで再開するときはまずここを読む。

設計 (不変条件): `docs/ui-redesign.md`
進捗 (生きた状態): 本ファイル

最終更新: 2026-04-26 / P0 完了時点

---

## 全体ステータス

| Phase | 状態 | 完了条件 |
|-------|------|---------|
| P0 セットアップ + topbar + SSE dot | ✅ done | topbar + SSE dot が live 表示 |
| P1 Sessions / Pending pane (読み取り) | ☐ todo | 既存 API から一覧が出る |
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
| `b9020e1` | chore(ui-next): scaffold Solid frontend-next with self-rolled Bun glue |
| `cf74318` | feat(ui-next): serve dist-next via daemon and port topbar + 3-pane shell |
| `ae33c1d` | feat(ui-next): wire SSE connection indicator with offline grace fallback |

検証状態: `bun run check` pass / `bun test src/` 1417 pass / 7 skip / 0 fail / `bun run build-ui-next` success

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

## ディレクトリ構成 (P0 完了時点)

```
src/ui/frontend-next/
  index.html.tmpl                      # {{NAS_WS_TOKEN}} / {{CSS}} / {{JS}} placeholder
  tsconfig.json                        # production (types: [])
  tsconfig.test.json                   # test (types: ["bun-types"])
  README.md                            # dev workflow など
  src/
    ambient.d.ts                       # *.css, fontsource 宣言
    main.tsx                           # entry: fontsource import + render
    App.tsx                            # .app grid + Topbar + workspace + StatusBar
    styles.css                         # control-room.html の shell rule + .live.offline
    components/
      Topbar.tsx                       # connected prop + classList offline
      SessionsPane.tsx                 # 左 pane 外枠 (空 ul)
      TerminalPane.tsx                 # 中央 pane 外枠 (空)
      PendingPane.tsx                  # 右 pane 外枠 + collapse btn (disabled)
      StatusBar.tsx                    # footer 最低限
    hooks/
      createConnectionController.ts        # 純関数 + DI、5000ms grace / 3000ms backoff
      createConnectionController_test.ts   # 5 ケース pin (bun:test)
      useConnection.ts                     # Solid 薄 wrapper (createSignal + onMount + onCleanup)
  design/
    control-room.html                  # 静的モック (ビルド対象外、CSS の正本)

scripts/
  build_ui_next.ts                     # Bun.build + index.html.tmpl 展開 + woff2 cp + assertion
  solid_plugin.ts                      # Bun.plugin + babel glue (~50行)
  solid_plugin_test.ts                 # 2 ケース (TSX 変換 / .ts filter)

src/ui/
  server.ts                            # resolveDistBase(env) 追加 (NAS_UI_NEXT=1 で dist-next)
  server_dist_base_test.ts             # 4 ケース pin (unset / "1" / "0" / "true")
  dist-next/                           # ビルド出力 (.gitignore 対象)
```

---

## 次セッションで P1 に着手する手順

**P1 完了条件**: Sessions pane + Pending pane が読み取りのみで動く (既存 API から実データの一覧が描画される)。Approve/Deny やセッション切替は P2-P4 に残す。

### 作業の流れ (planner 投入時の参考)

1. **store スケルトンを追加** (`src/ui/frontend-next/src/stores/`)
   - `sessionsStore.ts` (containers + turn 状態)
   - `pendingStore.ts` (network + hostexec)
   - Solid の `createStore` + `produce` で immutable-like 更新
2. **`useConnection` を named-event 対応に拡張**
   - 既に `createConnectionController` の `onEvent?` 拡張点が DI されている (P0 で布石済)
   - Solid wrapper で各 store にディスパッチを生やす
   - SSE イベント (`containers`, `network:pending`, `hostexec:pending` など) を購読
3. **`SessionsPane` を data-bound に**
   - 行レイアウトは `docs/ui-redesign.md` §6.2 通り (dot / 名前 / dir / prof / tree / id / badge)
   - state 連動 CSS (`.session.active`, `.session-dot.turn`, `.badge-turn` など) を control-room.html から styles.css へ追加移植
4. **`PendingPane` を data-bound に**
   - カード形式 (`docs/ui-redesign.md` §6.4)
   - `.section-label` / `.card` / `.card-head` / `.card-req` / `.scope` 系 CSS を移植
   - **読み取りのみ**: scope selector ・Approve / Deny ボタンは表示するが click handler は P4 に残す (`disabled` で良い)

### `/implement-with-review` skill で進める場合のメモ

- protected dirty paths: 着手時に `git status --short` で確認 (現在 stash@{0} に `.agent-sandbox.nix` の autostash 1件が残るが本実装には無関係)
- scope 外: `src/ui/frontend/`, `scripts/build_ui.ts`, `flake.nix` (P7 まで不変)
- review-config: `error-handling` / `security` / `design` / `tombstone-comments` / `test-coverage` がいずれも `no_findings` (warning でも差し戻し)
- Commit 粒度の目安: store 追加 → SSE dispatch 拡張 → SessionsPane data-bind → PendingPane data-bind の 3-4 commits

---

## 既知の TBD / 未決事項

- **routes 設計** (`docs/ui-redesign.md` §7): `#/settings/...` の hash routing か `@solidjs/router` か未決。**判断期限: P5 着手前**
- **状態 dot のセマンティクス詰め**: agent-turn 中 (`teal dim`) の彩度・透明度を control-room.html の最終ピクセルに合わせる。**判断期限: P1 SessionsPane 着手時**
- **`+ New Session` ボタン**: P0 で markup だけ存在 (handler 無し)。**判断期限: P2 で NewSessionDialog をマウントする時に同時 wiring**
- **キーボードショートカットの上書き**: `docs/ui-redesign.md` §8 末尾 "Settings で上書き可（将来）" は P6 以降の判断事項
- **`+ New Session` の disabled 化**: 現状クリックしても無反応で a11y 違反。P2 まで放置するなら `disabled` 属性を入れた方が誠実 (P1 の polish commit で対応するか別途判断)

---

## P0 で踏んだ罠と回避策 (再発防止メモ)

- **`Bun.build` の `watch: true` が Bun 1.3.9 で未公開** → `scripts/build_ui_next.ts` で `--watch` フラグ時に 500ms polling fallback
- **fontsource side-effect import で `dist-next/assets/main.css` が emit されるが index.html から link されない** → `build_ui_next.ts` で main.css を styles.css と一緒に inline 結合
- **frontend-next tsconfig が `types: []` だと `bun:test` の型が解決できない** → `tsconfig.test.json` を分離 (production と test の責務分離、`exclude` を `["node_modules"]` に override して test ファイルを include)
- **Biome `noSvgWithoutTitle` で gear icon SVG が blocking** → `aria-hidden="true"` (button 側に既に `aria-label="Settings"` があるため SVG は装飾扱い)
- **`@babel/core` 等の型不在** → `@types/babel__core` を追加せず `@ts-expect-error` 3行で対処 (deps 最小化)
- **`bun.lock` 変更で `bun.nix` が stale** → `bun install` 後に必ず `bun run bun2nix -o bun.nix` を走らせる

---

## 進捗を更新するルール

- 1 phase 完了 (= 完了条件達成) ごとに本ファイル冒頭の Phase ステータス表を更新
- コミットしたら **完了済みコミット** セクションに hash + message を追記
- 設計を変更したら `docs/ui-redesign.md` 本体も同時更新 (§5 決定事項 / §6 新 UI 設計 / §9 phases)
- TBD が解消したら本ファイル「既知の TBD」から外す
- 新たな TBD が発生したら同セクションに追加 (判断期限を併記)
- ファイル冒頭の「最終更新」を更新
