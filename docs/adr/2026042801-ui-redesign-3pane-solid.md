---
Status: Accepted
Date: 2026-04-28
---

# ADR: nas UI 3-pane 再設計と Solid 移行

## Context
旧 UI (Preact) は Sessions / Pending / Audit / Sidecars をタブ切替で
見せる単一フォーカス前提のレイアウトで、3 つの致命的痛点を抱えていた。
(a) launch 後に自動 attach されず Sessions タブから明示クリックが必要、
(b) TerminalModal がフルスクリーン overlay のため Pending が視認できず
approval 業務が中断される、(c) ×ボタンと Close ボタンの語が逆。さらに
TerminalModal は 846 行で xterm 初期化 / WS lifecycle / 検索 / ACK /
Shell / Kill が同居し、busy/acking などの局所 state が各 Tab に重複
していた。

## Decision

### レイアウト
3-pane (Sessions / Terminal Workspace / Pending) を恒常表示する。
中央 pane は **タブも分割も持たない単一 xterm**、セッション選択は
左 pane から行う。1 画面 = 1 端末で複数端末を同時に見る手段は出さない。
launch 完了で自動 attach、Pending は右 pane に常駐 (collapsed-rail に
縮約は可、左 Sessions pane は折りたたみ非対応)。Sidecars は Settings
配下に移し普段は目立たせない。Shell は独立タブではなく
**中央 pane 内の agent ⇄ shell トグル** (1 container = 1 shell)。
非表示側 WS は keep-alive、shell exit で自動的に agent に戻る。
これにより痛点 (a)(b)(c) は新仕様の意味論で解消される (×ボタン問題は
タブが消えたため自然消滅)。

### フロントエンド技術スタック
新規ディレクトリ `src/ui/frontend-next/` で **Solid 1.9** で書き直し、
旧 `src/ui/frontend/` (Preact) は移行完了時に物理削除する。ビルドは
`Bun.build + 自前 Bun.plugin (scripts/solid_plugin.ts ~50行) +
babel-preset-solid`。配信は既存 daemon (`src/ui/server.ts`) を
`NAS_UI_NEXT=1` env で `dist-next/` 切替する経路で行い、別ポートや
proxy を立てない。フォントは `@fontsource-variable/geist-mono` を
self-host。

### 状態管理
SSE は App ルートで 1 本だけ張り、named-event を各 store に dispatch
する。`sessionsStore` / `pendingStore` / `auditStore` /
`terminalsStore` / `uiStore` / `pendingActionStore` を分離し、
busy/acking 等の inFlight も store 側に集約する。Pending request の
identity は `<domain>|<sessionId>|<requestId>` の合成 key とし、
network/hostexec 衝突と SSE 更新時の scope 選択 reset を同時に回避する。
`reconcilePendingActionState` が SSE 更新で消えた key を gc する。

### Routing と view 切替
hash-based router (`routes/router.ts`、~60 行) を自前で書く。Settings ↔
workspace の切替は `<Show>` ではなく `display:none`
(`workspace-hidden` / `settings-shell-hidden` class) で行い、
DOM・terminal handles・WS を全て keep-alive にする。a11y の隔離は
HTML5 `inert` 属性 (Solid 1.9 の JSX 型で対応済) で行い、`aria-hidden`
は `noAriaHiddenOnFocusable` リスクのため採用しない。

### キーボード
`keybindsCatalog.ts` を正本にした catalog 駆動の `dispatchShortcut`。
`Ctrl+1..9` と `Ctrl+Shift+]` のように range / 左 pane 非対応のものは
spec=null でハードコード経路に置く。catalog 経路と hard-coded 経路で
**`metaKey` の扱いを揃える** (どちらも metaKey を検査しない)。
`matchShortcut` は `allowInTextField?: boolean` で TEXTAREA / INPUT /
contenteditable の bypass を opt-in 可能にし、terminal focus 中・dialog
input focus 中でも UI 側 shortcut が届くようにする。Approve/Deny の
対象選択は state-less な
`focused-card → network[0] → hostexec[0]` の 3 段 fallback、collapsed
時は no-op。

## Consequences
- TerminalModal (846 行) が解体され、xterm lifecycle は
  `attachTerminalSession.ts` (DI seam: createTerminal / createWebSocket /
  createFitAddon / setTimeoutFn / clearTimeoutFn / onError) に閉じる。
  dispose 冒頭で WS ハンドラを null 化する規約を確立。
- DeepLink (`?type=...&sessionId=...&requestId=...`) は Pending が常駐
  pane になったため近接ジャンプの必要が下がり、新 UI の scope 外に置いた。
- favicon バッジは `useFaviconBadge` で 16x16 Canvas に再描画、
  `network > hostexec` 優先で max lamp を反映する規約に統一。
- Settings は別ルート (`#/settings/{sidecars,audit,keybinds,prefs}`)
  であり、workspace 表示中は `inert` で a11y tree とフォーカスから外れる。
- Shell view 中の Toolbar context は `contextAgentRow`
  (Ack / rename の対象) と `activeTerminalId` (Search / Kill clients
  の対象) を分けて持つ。`shellSpawnInFlight` 表示は AGENT に固定。
- Bun 1.3.9 の `Bun.build({ watch: true })` は未公開のため、
  `scripts/build_ui_next.ts` で 500ms polling fallback を持つ。
- xterm.css と fontsource emit の `main.css` は build 時に
  `bundledCss` 先頭に inline 結合する (link 経路を持たないため)。
- `server.ts:preloadAssets` は `assets/fonts/` のような nested dir を
  扱うため flat readdir ではなく再帰 walk が必要。
- 旧 `src/ui/frontend/` の物理削除と `NAS_UI_NEXT` env flag の除去は
  P7 として残っており、`terminalInput.ts` / `terminalSize.ts` /
  `api.ts` の旧側コピーもここで解消する。

## Rejected alternatives
- **タブ UI を維持して TerminalModal を縮小**: 痛点 (b) (Pending 不可視)
  が消えない。3-pane 常駐が前提の問題。
- **中央 pane に terminal 分割 / タブを持たせる**: 1 画面 1 端末の
  原則を崩すと session 識別が中央 pane 側にも必要になり、Sessions
  pane の active row との二重表示になる。
- **Shell を独立 session row として左 pane に並べる**: agent ⇄ shell
  は 1 container 内のトグルなので、別 row にすると親子関係が UI に
  漏れて pending count や lamp の集計が壊れる。
- **Preact を継続**: Solid を試してみたかったのが一次動機。結果と
  しては旧コードの local state 分散と SSE reducer 分散を解く際に
  Solid の `createStore` + `produce` が store 設計に綺麗に乗ったが、
  これは選定時の根拠ではなく実装後に確認できた性質。
- **`bun-plugin-solid`**: 1 年メンテ無し。`babel-preset-solid` を直接
  叩く ~50 行の自前 plugin で代替。
- **Vite + `vite-plugin-solid` + dev proxy**: WebSocket / CORS / SSE の
  取り回しが複雑になる。既存 daemon 1 本で配信する方が運用が単純。
- **Google Fonts 配信**: 外部依存と calligraphic 系の混入を避けるため
  Geist Mono を self-host、mono 一本に絞る。
- **`@solidjs/router`**: SSR / nested route が不要で build size を
  膨らませるだけ。hash 1 段で足りる。
- **Settings ↔ workspace を `<Show>` で切替**: terminal の WS が
  unmount で切断する。`display:none` で DOM keep-alive にする。
- **`aria-hidden` で workspace を隠す**: focusable 子のある container に
  付けると `noAriaHiddenOnFocusable` を踏む。`inert` を採用。
- **Pending request の identity を `requestId` 単独**: network と
  hostexec で衝突しうる。`<domain>|<sessionId>|<requestId>` の
  合成 key にする。
- **scope 選択を card component の local state**: SSE で同じ requestId
  が再到着すると reset する。store に集約する。
- **Approve/Deny shortcut のターゲットを selection store**: SSE で
  消えた card が selected として残る。state-less な毎回再計算にする。
- **Manual `nas ui` shortcut override 機構を初期実装に含める**:
  catalog が正本になった時点で素直に乗せられる構造になっているが、
  要望ベースでよく初期 scope に入れない。
