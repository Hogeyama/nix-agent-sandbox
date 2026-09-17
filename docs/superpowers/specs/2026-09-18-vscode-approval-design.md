# nas Approval Routing into VS Code (Dev Container) 設計

状態: 2026-09-18 設計承認済み。実装は未着手。

## この設計で決めること

nas の devcontainer セッション内で動くエージェント (Claude Code 拡張) が出す
承認要求 — hostexec (ホストコマンド実行) と network (外向き通信) — は
ACP にも VS Code 拡張の UI にも届かない。利用者が気づかなければ、エージェントは
承認タイムアウトまで停止する。

Avante.nvim 向けに nix-config 側へ入れた承認ルーティング
(`~/nix-config/docs/superpowers/specs/2026-09-17-nas-approval-routing-design.md`)
と同じ問題を、dev container + VS Code の構成でも解く。VS Code には
`nvim --remote-expr` 相当の外部 push チャネルがないため、通知の受け手と
回答 UI の両方を持つ小さな VS Code 拡張を新設する。

対象は Linux ホストのデスクトップ版 VS Code + Dev Containers 拡張で
nas 管理のコンテナに接続したウィンドウ。回答 UI は `nas ui` の pending カードを
参考にした Webview とする。Marketplace 公開、Copilot / Codex 拡張固有の連携、
SSH / WSL リモートは範囲外とする。

## 構成

```text
VS Code (ホスト, UI extension host)
 └ nas-approval extension        extensionKind: ["ui"]
    │  contrib/vscode-nas-approval/
    ├ nas devcontainer status --workspace <ws> --json   → sessionId 解決
    ├ nas hostexec watch --session <sid>   (spawn, JSONL)
    ├ nas network  watch --session <sid>   (spawn, JSONL)
    ├ status bar item + toast notification   (件数のみ)
    └ WebviewPanel "nas approvals"           (カード UI, nas ui 準拠)
        └ nas <domain> approve|deny <sid> <reqid> [--scope <s>]  (spawn)
```

devcontainer セッションは `nas devcontainer up` / `_serve` が保持し、
VS Code は後から既存コンテナへ接続する。nvim 版のような「起動ラッパーに
watcher をぶら下げる」置き場所がないため、購読の所有は拡張自身が持つ。

### 拡張の形

- `extensionKind: ["ui"]` — remote ウィンドウでもローカル extension host で
  動作する。コンテナ内には `nas` がないので必須。`child_process.spawn` が
  ホスト上で動くこともこの kind が担保する。
- `activationEvents: ["onStartupFinished"]` — activate 直後に
  `vscode.env.remoteName === "dev-container"` を確認し、違えば即 return。
  `workspaceContains:**/.devcontainer/devcontainer.json` は自作の
  devcontainer でも発火するため activation 条件には使わない。
- contributes: コマンド `nas-approval.review` / `nas-approval.refresh`、
  設定 `nas-approval.nasPath` (既定 `"nas"`)。
- ランタイム依存ゼロの素の JavaScript + `package.json`。バンドル・
  トランスパイル工程を持たない。

### nas 管理下の判定

拡張は nas の Dev Container の中でのみ有効でなければならない。
二段のゲートで絞る。

1. `vscode.env.remoteName !== "dev-container"` → 非活性。
2. workspace folder ごとに
   `nas devcontainer status --workspace <path> --json` を実行する。
   `null` (init されていない workspace) ならその folder は非対象として
   以後ポーリングしない。`nas` バイナリ不在 (ENOENT) も同様に静かに終了する。
3. status が非 null なら `phase === "ready"` かつ `sessionId` があるまで
   30 秒間隔でポーリングし、解決できたら watch を開始する。

ウィンドウを開いた後に初めて `init` する経路は Reopen in Container で
ウィンドウが開き直されるため自然にカバーされる。手動での再判定用に
`nas-approval.refresh` コマンドを用意する。

### 購読と件数管理

- sessionId 解決後、`nas <domain> watch --session <sid>` を domain ごとに
  spawn する。
- stdout を行区切り JSON として読み、`added` は `entry` を
  `sessionId/requestId` キーの Map に積み、`removed` は消す。
  件数とカード描画の両方がこの Map を正本にする。
- watch が終了したら (EOF は `--session` 購読のセッション終了通知) 両方の
  watcher を畳み、status ポーリングへ戻る。`down` / `up` でセッションが
  新しくなっても追随する。
- watch の stderr と spawn 失敗は OutputChannel "nas approval" へ流す。
  JSONL のパース失敗はその行を捨てて継続する。
- deactivate 時は `context.subscriptions` 経由で子プロセスを SIGTERM する。
  watch 側は SIGTERM で止まる実装済み。
- multi-root workspace では folder ごとに独立した watcher セットを持つ。

### 通知層 (件数のみ)

- セッション解決中のみ status bar item を表示する。pending 0 は
  `$(shield) nas`、pending ありは `$(bell-dot) nas: N` の warning 色。
  クリックで `nas-approval.review`。
- 合計件数が 0→N に立ち上がった時だけ
  `showWarningMessage("nas: N pending approvals", "Review")` を出す。
  N→N+1 では再通知しない。編集中の割り込みを避ける判断は nvim 版と同じ。

### 回答 UI (Webview)

`nas-approval.review` はシングルトンの WebviewPanel "nas approvals" を開く。
pending が無ければ info メッセージだけを出す。

カードは watch の `entry` (structured payload) から描画し、
`nas ui` の pending カード (`src/ui/frontend/src/components/pendingCardView.ts`)
の語彙に揃える。

- network カード: `METHOD host:port`、経過時間、reviewContext
  (path / body サイズ)、ruleId、askReason の説明文、violations の列挙、
  `approvalScopes` に基づく scope セレクト
- hostexec カード: `argv0 args`、cwd、ruleId、`integrityChanged` の警告、
  scope セレクト (`once` = "This request only" / `capability` =
  "Matching command for this session"、`defaultScope` を初期選択)
- scope ごとの効果説明文も `pendingCardView.ts` の文言に揃える。

ボタン押下は `nas <domain> approve <sid> <reqid> --scope <s>` /
`nas <domain> deny <sid> <reqid>` を spawn する (端末を介さない)。
カードは busy 表示にし、watch の `removed` が届いて消える。
状態の正本は broker にあり、楽観的に消さない。spawn 失敗はカード内に
エラーを出す。

sessionId / requestId を spawn の argv に入れる前に `[A-Za-z0-9_-]+` を
検証する。シェルを介さなくても、`-` 始まりの値がフラグとして解釈される
経路を塞ぐ。

Webview は `var(--vscode-*)` テーマ変数だけで描く素の HTML/CSS/JS とし、
外部リソースを読まない。CSP は `default-src 'none'` 系で厳格にし、
フレームワークは入れない (ビルド工程ゼロを維持する)。

Webview に渡すのは pending のメタデータのみであり、秘密の値は含まれない
(capability の envBindings はキー名と由来だけで値を持たない)。

### nas 側の変更

`toHostExecPendingItem` の `structured` に `integrityChanged` /
`defaultScope` / `capability` を追加する。pending エントリはこれらを
既に保持しており、表示に使うだけで新しい情報源は増えない。
`pending --format json` と `watch` の両方に乗る。既存フィールドは
変更しないので後方互換。network 側の `structured` は現状で足りる
(`injectHeaders` などの追加は将来の拡張とする)。

### 配布

- nix (nix-config): `programs.vscode.extensions` に
  `pkgs.vscode-utils.buildVscodeExtension` でソースから組み込む。
  `mutableExtensionsFile` 既定 (true) で手動インストール済み拡張と共存する。
- 非 nix:
  `cd contrib/vscode-nas-approval && bun x @vscode/vsce package --no-dependencies`
  で vsix を作り `code --install-extension` する。`--no-dependencies` で
  `npm ls` を走らせず bun/npm 非依存にする (依存ゼロなので実質 zip 化のみ)。
  `package.json` に `publisher` を入れておく。vsce を入れたくない向けに
  `~/.vscode/extensions/<publisher>.nas-approval-<version>/` への手動配置も
  README に記載する。
- Marketplace には公開しない (個人ツール前提)。

## 検証と完了条件

- Unit: イベント reducer (added/removed/dup)、status JSON → sessionId 解釈、
  sessionId / requestId 形式検証、Map → webview 状態への写像を bun:test で。
  VS Code API 面は薄いアダプタに閉じ込めてテスト対象から外す。
- hostexec `structured` の追加フィールドは既存の `hostexec_test.ts` 系で担保する。
- 実機チェックリスト: devcontainer ウィンドウで hostexec 要求と network 要求を
  起こし、通知 → カード review → approve/deny の往復、`down`/`up` 後の
  新セッション追随、非 nas ウィンドウ (ローカル・SSH・自作 devcontainer) で
  拡張が何もしないこと、を確認する。

## なぜこのアプローチを選んだか

nvim 版では「要求の中身はエディタに持ち込まず `nas review` に委譲する」ことが
設計の核心だった。今回は利用者の要求により回答 UI を nas ui 相当のカードに
変えたため、その前提が外れ、payload は拡張に入る。それでも状態の正本を
broker に置く設計 (watch が真実・ボタンは CLI 経由の決定送信のみ) は維持し、
web UI が持つ承認ロジックの複製は避けている。

拡張が `extensionKind: ["ui"]` でローカルに動く以上、nvim 版の中継プロセス
(`nas-approval-watch`) の存在意義 — 外部からエディタへ push する — は消える。
spawn・購読・描画を一つのプロセスに閉じ込める方が、寿命管理も配布も単純になる。

## なぜ他の案を選ばなかったか

- **fzf 端末に `nas review` を流す案** — 実装は最小だが、violations や
  scope 説明を含むカード相当の情報密度は端末 fzf では出せない。利用者の
  却下により不採用。
- **中継プロセス方式 (nvim 版の完全移植)** — `_serve` から watcher を起こし
  状態を socket/ファイル経由で拡張へ渡す。拡張が直接 `nas` を spawn できる
  ため中継は純粋に冗長。所有権と後始末の複雑さだけ増える。
- **QuickPick 多段の素の UI 案** — Webview 不要で最も軽いが、カードに相当する
  情報 (ruleId・askReason・violations・scope 効果) を段階プロンプトに
  押し込むと判読性が落ちる。nas ui との見た目の一致も捨てることになる。
- **通知だけ拡張、回答は nas ui を開く案** — `nas ui` デーモンの常駐が前提に
  なり、未起動では何も届かない。`devcontainer up` との連携まで含めると
  総量は増える。
- **devcontainer.json への nas マーカー付与** — `status` の null 判定で
  nas 管理下は識別できるため、生成設定への変更としては不要。

## 確認した資料

- `src/cli/approval_watch.ts` / `src/cli/approval_command.ts` —
  watch の JSONL 形式と `--session` 購読の終了契約。
- `src/cli/network.ts` / `src/cli/hostexec.ts` — `structured` payload の
  フィールドと approve/deny の CLI 形。
- `src/ui/frontend/src/components/pendingCardView.ts` / `pendingStore.ts` —
  nas ui のカードが使う語彙と行データ。
- [Extension Host | VS Code Extension API](https://code.visualstudio.com/api/advanced-topics/extension-host) —
  `extensionKind` と remote ウィンドウでの実行位置。
- `~/nix-config/docs/superpowers/specs/2026-09-17-nas-approval-routing-design.md` —
  Avante 版の設計。通知は件数のみ・割り込まない判断を継承する。
