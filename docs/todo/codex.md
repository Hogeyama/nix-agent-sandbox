調査結果として、Claude では実現できている一方、Codex では不足しているものが主に 4 点あります。

**1. 履歴 UI の prompt・summary 表示**
最も明確な未実装です。

Claude は OTLP logs から user prompt を取り込み、以下を表示できます。

- conversation 一覧の summary
- Turn ヘッダーの prompt preview
- Turn 詳細の User prompt
- prompt と trace の対応付け
- hook 実行イベント

Codex は trace、token、model、conversation ID までは保存できますが、prompt 抽出器が存在しません。

関係ファイル:

- [observability.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/observability.ts:137)
  - Codex には trace exporter だけを `-c` で注入
  - log exporter と `otel.log_user_prompt=true` は未設定
- [prompts.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/prompts.ts:25)
  - Claude/Copilot の抽出器しか呼んでいない
- [claude_prompts.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/claude_prompts.ts:135)
  - Claude 専用の実装
- `src/agents/codex_prompts.ts`
  - 相当するファイルが存在しない
- [store.ts](/home/hogeyama/repo/nix-agent-sandbox/src/history/store.ts:652)
  - 最初の trace の prompt を conversation summary にしているため、Codex は `null`
- [conversationDetailView.ts](/home/hogeyama/repo/nix-agent-sandbox/src/ui/frontend/src/components/history/conversationDetailView.ts:994)
  - Turn の `userPromptText` も同じ extractor に依存
- [ConversationDetailPage.tsx](/home/hogeyama/repo/nix-agent-sandbox/src/ui/frontend/src/components/history/ConversationDetailPage.tsx:319)
  - prompt が取れた場合だけ UI 表示
- [2026051301-observability-logs-signal-ingest.md](/home/hogeyama/repo/nix-agent-sandbox/docs/adr/2026051301-observability-logs-signal-ingest.md:213)
  - Codex への `otel.log_user_prompt=true` 追加を「別 commit」と明記しているが、まだ実施されていない

Codex の現行仕様でも log exporter と `otel.log_user_prompt` は正式に提供されています。[Codex observability documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry)

ただし、既存の [ingest_logs.ts](/home/hogeyama/repo/nix-agent-sandbox/src/history/ingest_logs.ts:121) は Claude の `session.id`、`prompt.id`、`event.sequence` を必須としています。Codex log を有効にするだけでは足りず、Codex event schema 用の ingest と trace 対応付けも必要です。

**2. Codex の tool 詳細・実行イベントが薄い**
Claude では以下の telemetry を明示的に有効化しています。

- `OTEL_LOG_TOOL_DETAILS`
- `OTEL_LOG_TOOL_CONTENT`
- hook execution logs
- skill name
- tool input/output

Codex は現在 trace exporter だけなので、履歴上は `session_task.user_shell` や `mcp.tools.call` という span 名は見えても、コマンドや tool 引数などの詳細がほとんどありません。

関係ファイル:

- [observability.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/observability.ts:121)
- [codex_otel_minimal.json](/home/hogeyama/repo/nix-agent-sandbox/src/history/fixtures/codex_otel_minimal.json:113)
  - Codex tool span は `thread.id` 程度しか fixture にない
- [display.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/display.ts:43)
  - tool 名・詳細を attrs から抽出するが、Codex 側の attrs が不足
- [conversationDetailView.ts](/home/hogeyama/repo/nix-agent-sandbox/src/ui/frontend/src/components/history/conversationDetailView.ts:696)
- [ingest_logs.ts](/home/hogeyama/repo/nix-agent-sandbox/src/history/ingest_logs.ts:74)
  - Claude の hook events だけを保存

Codex log exporter は `codex.tool_result`、`codex.tool_decision`、`codex.user_prompt` などを出せるため、1 の対応とまとめて改善可能です。

**3. バイナリ未導入時の自動セットアップ**
Claude はホストにバイナリがなくても、コンテナ内で公式 installer を実行します。

- [claude.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/claude.ts:70)

Codex は即時エラーになります。

- [codex.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/codex.ts:55)
- [agents_integration_test.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/agents_integration_test.ts:569)

現在は Codex にも公式 standalone installer があるため、Claude と同じフォールバックを実装できます。

```sh
curl -fsSL https://chatgpt.com/codex/install.sh |
  CODEX_NON_INTERACTIVE=1 sh
```

README も Codex だけ Releases からの事前導入を要求しています。

- [README.md](/home/hogeyama/repo/nix-agent-sandbox/README.md:37)
- [README.md](/home/hogeyama/repo/nix-agent-sandbox/README.md:893)

**4. セッション終了を `done` にできない**
Claude の設定例は `SessionEnd` から `nas hook --kind stop` を呼ぶため、UI のセッション状態を `done` にできます。

- [README.md](/home/hogeyama/repo/nix-agent-sandbox/README.md:653)
- [hook.ts](/home/hogeyama/repo/nix-agent-sandbox/src/cli/hook.ts:187)
- [store.ts](/home/hogeyama/repo/nix-agent-sandbox/src/sessions/store.ts:186)

Codex の設定例は `Stop` を `attention` にするところまでで、`stop` を一度も送信しません。

- [README.md](/home/hogeyama/repo/nix-agent-sandbox/README.md:746)

ただしこれは NAS の設定漏れだけではありません。現行 Codex hooks には `SessionEnd` イベントがなく、`Stop` は「turn 終了」であって session 終了ではありません。[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)

対策するなら、hook ではなく Codex プロセス終了を監視する NAS 側 lifecycle から `done` を記録する必要があります。

**補足**
mouse mode が Codex だけ無効ですが、コード上は意図的な trait です。現時点では未実装とは判断できません。

- [terminalTraits.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/terminalTraits.ts:39)
- [terminalTraits_test.ts](/home/hogeyama/repo/nix-agent-sandbox/src/agents/terminalTraits_test.ts:30)

優先順位は、`Codex logs/prompt ingest`、`プロセス終了時の done 更新`、`自動 installer` の順が妥当です。

なお `fetch-codex-manual` は curl を選択していました。失敗原因は proxy 非対応ではなく、HEAD リクエストでも body 一時ファイルを読み込む実装で curl 経路が失敗し、native fetch の DNS エラーだけが最終表示される問題と見られます。直接 `curl` では manual を正常取得できました。コード変更やテスト実行は行っていません。
