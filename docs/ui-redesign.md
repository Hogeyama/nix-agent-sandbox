# nas UI 再設計 — 現状棚卸し

Step 1: 画面再設計のための、現状の機能・フロー・痛点の洗い出し。判断はまだ含めない。

---

## 1. 画面/機能の一覧

### タブ構成 (`App.tsx:30-37`)

| タブ | 表示内容 | 主要操作 |
|------|---------|---------|
| **Sessions** | agent セッション（コンテナ）テーブル。turn ステータス、profile、作成時刻 | Attach / Shell / ACK turn / Rename / Stop / 行展開で詳細 |
| **Pending** | network・hostexec の承認待ち要求 | scope 選択 → Approve / Deny |
| **Audit** | 承認・拒否ログ。domain/session フィルタ、activeOnly、無限スクロール | 閲覧のみ |
| **Sidecars** | dind / proxy / envoy コンテナ | Stop のみ |

### モーダル・ダイアログ

- **TerminalModal** (`TerminalModal.tsx`, 846行): 複数タブの dtach 端末。xterm.js + WebSocket。検索、フォントサイズ、ACK turn、Shell 起動、Kill clients、最小化
- **NewSessionDialog** (`NewSessionDialog.tsx`, 456行): profile / cwd / worktree / sessionName 入力 → launch

### 常駐 UI

- ヘッダー：brand + SSE 接続ドット (live/offline)
- favicon バッジ：pending（赤）/ user-turn（黄）件数を Canvas 描画 (`useFaviconBadge.ts`)
- 最小化バー：terminal 非表示時の画面下部復帰 UI (`App.tsx:397-412`)

### DeepLink

URL param `?type=network|hostexec&sessionId=*&requestId=*` → Pending タブへ自動遷移＋該当行ハイライト (`App.tsx:122-137`)

---

## 2. データソース・状態管理

### SSE イベント (`App.tsx:249-274`)

| イベント | 更新先 |
|---------|--------|
| `network:pending` | networkPending |
| `hostexec:pending` | hostExecPending |
| `sessions` | sessions (network/hostexec 側の紐付け) |
| `terminal:sessions` | dtachSessions（reducer） |
| `audit:logs` | auditLogs |
| `containers` | containers |

### 初回 fetch

`getLaunchInfo()` / `getContainers()` / `getTerminalSessions()` (`App.tsx:72-120`)

### App.tsx の state 数

useState 8個 + useReducer 1個（terminalUi）。局所状態が各 Tab コンポーネントに分散（busy / acking / expandedNames / scopeMap 等）

---

## 3. 主要ユーザーフロー

### 新規セッション launch → 接続

1. New Session クリック → Dialog
2. profile 等入力 → `POST /api/launch` → sessionId
3. dialog close
4. SSE `containers` で Sessions テーブルに新行
5. **ユーザーが明示的に Attach クリック** ← 摩擦点
6. TerminalModal 開く → xterm が WebSocket 接続

### turn 通知 → 応答

1. agent が user-turn に → `containers` SSE
2. Sessions 行に "Your turn"、favicon 黄点
3. Attach → 端末で応答入力
4. agent 側で ack → agent-turn に戻る

### Pending 承認・拒否

1. Pending タブで network/hostexec 参照
2. scope selector で粒度選択
3. Approve/Deny → `POST /api/network/approve` 等
4. SSE で pending 再取得、Audit に decision ログ

### Shell 起動

1. Sessions 行 Shell ボタン → `POST /api/containers/{name}/shell` → dtachSessionId
2. `shell-started` action で optimistic 反映
3. SSE `terminal:sessions` で確定、TerminalModal に shell タブが出る

---

## 4. 痛点

### ユーザー指摘（確定）

- **(a) launch 後に自動 attach されない**
  sessionId 取得しても TerminalModal は開かない。Sessions タブで Attach クリックが必要
- **(b) Terminal 表示中に Pending が見えない**
  TerminalModal がフルスクリーン overlay。Pending や Audit が視認不能 → approval 業務が中断される
- **(c) ×ボタン挙動が期待と違う**
  「×」= タブ 1つ閉じる (`onCloseSession`)、「Close」= モーダル全体最小化 (`onMinimize`)。用語・アイコンが逆っぽい (`TerminalModal.tsx:482-509 / 675`)

### コード観察による追加痛点

- **TerminalModal 肥大化（846行）**：xterm 初期化 / WS ライフサイクル / 検索 / フォントサイズ / ACK / Shell / Kill が 1 コンポーネントに同居。useXTerminal / useTerminalWS などに分離余地
- **状態分散**：busy/acking フラグが各 Tab で独立実装。session 情報も App.tsx と各 Tab で二重取得
- **レイアウトが単一フォーカス前提**：タブ切替でしか情報を見られない。Pending ↔ Sessions ↔ Terminal の並行観察ができない
- **最小化バーの層別が粗い**：全タブで表示されたまま、dismissable でない
- **DeepLink ハイライトが stale**：approve 後も highlight ref が残る、再訪問で復元しない (`PendingTab.tsx:48`)
- **Sidecars タブが Sessions と UI 共用**：本来不要な Attach / Shell 列がちらつく
- **focus trap 無し**：TerminalModal に `aria-modal` は付くが Tab キーで背景にフォーカス抜ける
- **キーボード操作の一貫性欠如**：terminal 内 Ctrl+F のみ。タブ切替 / session 切替 / approve 等のショートカット無し

---

## 5. 決定事項

| 論点 | 決定 |
|------|------|
| レイアウト方針 | **3-pane**（Sessions / Terminal / Pending）。Terminal はタブ無し単一 xterm、セッション選択は左 pane から |
| Terminal 自動 attach | launch 完了で **必ず attach** |
| Pending 可視性 | **右サイドバーに常駐** |
| Sidecars | **Settings 配下** に移動。普段は目立たない |
| フレームワーク | **Solid** で新規 (`src/ui/frontend-next/`)。既存 Preact は ship 時に削除 |
| 痛点 (c) ×ボタン | 新UIの意味論で自然解消（仕様は §6.3 参照） |

---

## 6. 新 UI 設計

### 6.1 レイアウト

```
┌──────────────────────────────────────────────────────────────────────┐
│ nas  ●live          [+ New Session]                  ⚙ Settings     │  Topbar
├──────────────┬──────────────────────────────────────┬────────────────┤
│              │                                      │                │
│  Sessions    │   Terminal Workspace (center)        │  Pending       │
│  (left)      │                                      │  (right)       │
│              │                                      │                │
│  ● s1 TURN   │                                      │  Network       │
│    profile-a │   xterm fills the whole area         │  ▸ s1 curl ...│
│    dir/tree  │   (no tabs, no internal header)      │   [Allow once]│
│  ○ s2        │                                      │   [Allow host]│
│    profile-b │                                      │   [Deny]      │
│    dir/tree  │                                      │                │
│              │                                      │  HostExec      │
│              │   [Ack turn] [Shell] [Search] ...    │  ▸ s2 cmd...   │
│              │                                      │   [Approve]    │
│              │                                      │   [Deny]       │
│              │                                      │                │
│              │                                      │  [Audit ▸]     │
│              │                                      │                │
│              │   [● s1 · feat/...] [Ack][Shell]...  │  [Audit ▸]     │
├──────────────┴──────────────────────────────────────┴────────────────┤
│ status · shortcut hint                                                │  Statusbar
└──────────────────────────────────────────────────────────────────────┘
```

- **初期幅**: 左 Sessions 288px / 中央 flex / 右 Pending 340px
- **drag-resize**: 左右 pane と中央との**境界に drag handle** を持ち、ドラッグでリアルタイムに幅を変更できる。特に Sessions pane は dir / worktree 名が長くなりがちで頻繁に調整される想定。最小幅 = 左 200px / 右 240px。幅は localStorage に永続化
- **折りたたみ**: 右 Pending pane のみ対応。ヘッダのボタン or `Ctrl+Shift+]` で 38px の collapsed-rail に縮約。左 Sessions pane は折りたたみ非対応（常時参照）

### 6.2 左 pane — Sessions

- 表示するのは **agent セッションのみ**。shell は左 pane に出さない
- Session 1行レイアウト（ヘッダ行 + meta 4項目）:
  ```
  [状態dot] [session名]                              [turn badge]
             dir    ~/projects/nas
             prof   nix-claude
             tree   wt-auth ← main
             id     s_7a3f
  ```
  - `tree` は worktree 名 ← base branch 形式。worktree なしは淡色で `— direct on <branch>`
  - `id` は薄い色で補助情報として表示
- 状態 dot: `amber pulse` (user-turn) / `teal dim` (agent-turn/busy) / `muted` (idle)
- turn badge: `Turn` (amber, ランプ付き) / `Busy` (teal, 控えめ) / なし
- 行クリック → 中央 pane で該当セッションを選択表示（active 左エッジに amber グロー）
- 行のインライン or ホバーアクション: `Shell / Rename / Stop`
- 右クリック/長押し → 上記に加え `Copy attach-cmd`
- リネームはインライン編集（従来の `EditableSessionName` を流用）
- **left pane は折りたたみ非対応**。drag-resize のみ（§6.1 参照）

### 6.3 中央 pane — Terminal Workspace

**タブも分割も持たない単一 xterm pane**。左 pane で選択された session の端末を全面表示する。1画面 = 1端末の原則で、複数端末を同時に見る手段は用意しない。

#### 挙動

- **選択は左 pane から**：セッション行クリックで中央 pane の表示が切替わる
- **裏側の端末も keep-alive**：非表示 session の WebSocket は維持、出力はバッファ継続
- 中央 pane 内にブランチ名やヘッダは出さない（識別は Sessions pane の active 行で）

#### Toolbar (pane 下部)

```
[● session名 · id]  [Ack turn] [Shell] [Search]    [14px] [Kill clients]
```

- 左端：選択中セッションのコンテキスト（dot + 名前 + id）
- 中央：アクションボタン（`Ack turn` はアンバー強調）
- 右端：font-size + destructive action

#### 用語

- **Stop** = container を kill（左 pane の行アクション経由）
- **Shell** = この container に新しい shell を起こす（配置は下の TBD）
- Attach / Detach は UI の表面から排除。WS 接続は自動管理されユーザーが意識しない

#### Shell 起動 — 中央 pane トグル

Shell セッションは**中央 pane 内の agent ⇄ shell トグル**で実装する。

- `Shell` ボタン（or `Ctrl+.`）で中央 pane の表示を切替。シェル未作成なら初回クリックで spawn + 切替
- ボタンラベルは表示中の反対を指す：
  - agent 表示中 → `Shell`
  - shell 表示中 → `Agent`
- toolbar の context ラベルに現在の view を `AGENT` / `SHELL` バッジで明示
- 両方の WS は keep-alive。非表示側もバッファ継続
- shell プロセス exit → 自動で agent に戻り、ボタンは `Shell` に戻る
- **1 container に shell は 1 つだけ**（設計上の制約）
- session 切替時は各 session 毎の「最後に見ていた view」を復元

#### 自動 attach フロー

```
[+New Session] → Dialog → Launch API
                            ↓
                      containers SSE  →  Sessions pane に行追加
                            ↓
              terminal:sessions SSE で dtach 検知
                            ↓
              中央 pane で active 切替（= 自動 attach）
```

### 6.4 右 pane — Pending / Audit

- 上段 **Pending** (primary)
  - Network / HostExec 2 セクション
  - カード形式: `[session chip] [要求 summary]  [scope selector] [Approve] [Deny]`
  - 空のとき `No pending` をごく薄く表示（常駐確認のため pane は出したまま）
- 下段 **Audit** (アコーディオン、default closed)
  - クリックで展開、最近 50件をスクロール表示
  - 詳細は Settings の Audit ページで（filter、無限スクロール、全件）

### 6.5 Topbar / Settings

- Topbar: brand / SSE dot / NewSession / gear
- Settings (モーダル or 別ルート `#/settings`):
  - **Sidecars** (dind/proxy/envoy 管理、Stop のみ)
  - **Audit** (フル機能)
  - **Keyboard shortcuts** (一覧)
  - **Preferences** (font, theme, pane sizes など)

---

## 7. 情報アーキ / 状態設計 (Solid)

```
stores/
  sessionsStore.ts      // containers + turn + rename
  pendingStore.ts       // network + hostexec
  auditStore.ts         // logs
  terminalsStore.ts     // dtachSessions, openIds, activeId
  uiStore.ts            // pane sizes, collapsed, theme

hooks/
  useSSE.ts             // 単一 EventSource → 各 store に dispatch
  useXTerm.ts           // xterm ライフサイクル
  useTerminalWS.ts      // WebSocket ライフサイクル
  useKeyboard.ts        // グローバルショートカット

routes/
  / (workspace)
  /settings/sidecars
  /settings/audit
  /settings/keybinds
  /settings/prefs

components/
  workspace/
    Topbar.tsx
    SessionsPane.tsx
    TerminalPane/
      index.tsx
      TabBar.tsx
      Toolbar.tsx
    PendingPane.tsx
    StatusBar.tsx
  dialogs/
    NewSessionDialog.tsx
  settings/
    SidecarsPage.tsx
    AuditPage.tsx
    ...
```

- **SSE は App ルートで 1本だけ**, 受信→store 更新（Preact 版の reducer 分散を解消）
- **busy/acking** も store に集約（Pending store 側で該当 id を `inFlight` Set で管理）
- Solid の `createStore` + `produce` で immutable-like に更新

---

## 8. キーボードショートカット

| Key | Action |
|-----|--------|
| `Ctrl+N` | New Session |
| `Ctrl+1..9` | セッション切替（左 pane の順） |
| `Ctrl+Shift+A` | 選択中 Pending を Approve (once) |
| `Ctrl+Shift+D` | 選択中 Pending を Deny |
| `Ctrl+Shift+[` / `]` | 左 / 右 pane 折りたたみ |
| `Ctrl+,` | Settings |
| `Ctrl+?` | ショートカット一覧 |

- Terminal focus 中はほぼ全キーを xterm に渡す。`Ctrl+Shift+` プレフィックスなら UI 側でキャプチャ、で衝突回避
- `useKeyboard` hook で一元管理、Settings で上書き可（将来）

---

## 9. 実装フェーズ

| Phase | 内容 | 完了条件 |
|-------|------|---------|
| P0 | セットアップ (Bun + Solid、既存 daemon と結線) | topbar + SSE dot が live 表示 |
| P1 | Sessions pane + Pending pane (読み取りのみ) | 既存 API から一覧が出る |
| P2 | NewSessionDialog + 自動 attach + Focus モード端末 1つ | launch → 入力できる |
| P3 | セッション切替（左 pane クリック）/ Detach / Stop / Rename / Shell 起動 / pane drag-resize | 痛点 (a)(b)(c) 解決 |
| P4 | Approve/Deny + scope selector + Audit アコーディオン | Pending 業務完結 |
| P5 | Settings (Sidecars / Audit / Keybinds / Prefs) | 機能パリティ |
| P6 | Keyboard shortcuts / focus trap / a11y | 完了 |
| P7 | 旧 `src/ui/frontend/` 削除、build target 切替 | ship |

各 Phase は 1 コミット以上・ブランチ or PR 単位で進める。

---

## 10. 進捗管理

実装の進捗・完了済みコミット・次に着手すべき phase は、生きたトラッカとして
**`docs/ui-redesign-progress.md`** に分離した。新しいセッションで再開するときは
そちらを最初に読むこと。本ドキュメントは設計上の不変条件 (決定事項・レイアウト・
情報アーキ・キーボード規約) を保持する役割に閉じる。
