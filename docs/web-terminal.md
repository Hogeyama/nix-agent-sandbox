# Web Terminal (xterm.js + dtach bridge)

ブラウザから dtach セッションを操作する機能。PoC を `99303cf` で実装済み。

## アーキテクチャ

```
[Browser xterm.js]
    ↕ WebSocket (binary + JSON control)
[Bun server  /api/terminal/:sessionId]
    ↕ Unix domain socket (dtach v0.9 packet protocol)
[dtach master]
    ↕ PTY
[Container shell / agent]
```

### dtach プロトコル概要

dtach v0.9 のワイヤープロトコルは非対称:

- **Client→Master**: 10バイト固定パケット `{ type: u8, len: u8, payload: [u8; 8] }`
- **Master→Client**: 生バイトストリーム（フレーミングなし、PTY出力そのまま）

| Type | 値 | 用途 |
|------|-----|------|
| MSG_PUSH | 0 | キーボード入力 (最大8バイト/パケット) |
| MSG_ATTACH | 1 | アタッチ要求 (出力の受信を開始) |
| MSG_DETACH | 2 | デタッチ通知 |
| MSG_WINCH | 3 | ウィンドウサイズ変更 |
| MSG_REDRAW | 4 | 再描画要求 (len=method, payload=winsize) |

`struct winsize` は 8 バイト (little-endian): `{ ws_row: u16, ws_col: u16, ws_xpixel: u16, ws_ypixel: u16 }`

接続シーケンス: connect → MSG_ATTACH → MSG_REDRAW(winsize) → 双方向データ転送開始

## PoC で実装済みのもの

- [x] WebSocket エンドポイント (`/api/terminal/:sessionId`) — `Bun.serve` の websocket upgrade
- [x] dtach ソケットブリッジ — dtach v0.9 パケットプロトコル準拠 (`src/ui/routes/terminal.ts`)
- [x] dtach セッション一覧 API (`GET /api/terminal/sessions`)
- [x] xterm.js フロントエンド (`src/ui/frontend/src/components/TerminalTab.tsx`)
- [x] Terminal タブ (セッション一覧 → Attach → ターミナル表示)
- [x] ウィンドウリサイズ対応 (MSG_WINCH)
- [x] Ctrl-a / Ctrl-e / Ctrl-w の TTY 転送を優先するキーハンドリング
- [x] 右クリックのブラウザコンテキストメニュー抑止（マウスイベントをターミナル側へ通しやすくする）
- [x] xterm.js CSS のビルドパイプライン統合
- [x] ダークテーマ (既存ダッシュボードのカラーパレットに統一)

## 未実装・要改善

### 必須 (本番化に向けて)

- [ ] **実機テスト** — 実際の dtach セッションでの動作確認がまだ。プロトコル実装のエンディアンやパケット境界に問題が出る可能性あり
- [ ] **認証** — 現状 WebSocket エンドポイントに認証なし。ローカル利用前提だが、ポートが外部に露出した場合に任意のセッションにアタッチできてしまう
- [ ] **エラーリカバリ** — dtach ソケット切断時のフロントエンド再接続ロジックがない。ブラウザ側で自動再接続 or 手動再接続 UI が必要
- [ ] **デタッチ UI** — 現状の Disconnect はソケットを破棄するのみ。dtach のデタッチキー相当の操作フローを設計する必要あり

### 推奨

- [ ] **SSE にターミナルセッショ��変更通知を追加** — 現状ポーリング (5秒) でセッション一覧を取得している。新セッション作成時にリアルタイム通知があると UX 向上
- [ ] **複数クライアント同時接続** — dtach 自体は複数クライアントをサポートするが、Web 側で「誰がアタッチ中か」を可視化する仕組みがない
- [ ] **Containers タブとの統合** — Containers タブのセッション情報から直接ターミナルを開けるとナビゲーションが楽
- [ ] **スクロールバック設定** — xterm.js の `scrollback` オプション。現状デフォルト (1000行) だがユーザー設定可能にすると良い
- [ ] **ユニットテスト** — `terminal.ts` の `makePacket` / `sendPushPackets` / `extractSessionId` 等のユニットテスト
- [ ] **WebSocket binary 最適化** — 現状 `sendBinary` で全データを即座に送っているが、大量出力時のバックプレッシャー制御がない

### 将来検討

- [ ] **Read-only モード** — 出力を見るだけで入力を送らないモード。モニタリング用途
- [ ] **セッション録画・再生** — ターミナル出力をキャプチャして後から再生できる機能
- [ ] **Web-only セッション** — dtach を経由せず `docker exec` で直接 PTY 接続。dtach セッション以外のコンテナにもアクセス可能に
