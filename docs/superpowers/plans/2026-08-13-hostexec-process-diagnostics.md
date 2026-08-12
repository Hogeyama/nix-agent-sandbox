# Hostexec Process Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl-C またはコンテナ停止時の hostexec/Forgejo signal 経路を特定できる永続 JSONL 証跡を追加する。

**Architecture:** Linux `/proc` を読む小さな hostexec 診断モジュールを追加し、broker の lifecycle 境界から best-effort で呼ぶ。Forgejo helper は shell 側で同形式のイベントを永続 state directory に追記する。

**Tech Stack:** Bun, TypeScript, Bash, Linux `/proc`, JSON Lines

## Global Constraints

- 診断失敗で hostexec/Forgejo の本来の動作を失敗させない。
- シークレット、環境変数、stdin/stdout/stderr 本文は記録しない。
- テストは `test-policy` に従い、実装前に失敗を確認する。
- hostexec の side effect は `HostExecBroker` 内に閉じ、stage に I/O を追加しない。

---

### Task 1: Hostexec process diagnostics

**Files:**
- Create: `src/hostexec/process_diagnostics.ts`
- Create: `src/hostexec/process_diagnostics_test.ts`
- Modify: `src/hostexec/broker.ts`
- Modify: `src/hostexec/broker_integration_test.ts`

**Interfaces:**
- Produces: `HostExecProcessDiagnostics`, `parseLinuxProcStat(stat: string)`, `readProcessIdentity(pid: number)`
- Consumes: `HostExecRuntimePaths.runtimeDir`, broker `sessionId`, spawned `Subprocess.pid`

- [ ] Unit test `/proc/<pid>/stat` parsing and one-line JSON append; run `bun test src/hostexec/process_diagnostics_test.ts` and confirm missing module/API failure.
- [ ] Implement the parser and best-effort JSONL appender with `path = <runtime>/diagnostics/<session>.jsonl`.
- [ ] Instrument broker start/close, command spawn, stream failure, signal send, and exit.
- [ ] Add an integration assertion that a successful command produces `command_spawned` followed by `command_exited`; run the focused broker test.

### Task 2: Forgejo child diagnostics

**Files:**
- Modify: `skills/patched-superpowers/scripts/lib/forgejo_instance.sh`
- Modify: `skills/patched-superpowers/scripts/forgejow`
- Modify: `skills/patched-superpowers/scripts/test_forgejow.sh`

**Interfaces:**
- Produces: `fj_diagnostics_file`, `fj_log_process_event EVENT PID [SIGNAL]`
- Consumes: Forgejo PID captured from `$!`

- [ ] Extend the integration assertions for `forgejo_spawned`, PID/PGID/SID, and the displayed diagnostic path; run the script and confirm failure.
- [ ] Add best-effort JSONL append on spawn and before `fj_down` sends SIGTERM.
- [ ] Print the persistent diagnostic path from `request-review`, then rerun the integration script.

### Task 3: Verification

**Files:** No production changes expected.

- [ ] Run focused unit/integration tests.
- [ ] Run `bun run fmt`, `bun run lint`, `bun run check`, and `bun test` according to `post-change-checks`.
- [ ] Report the two diagnostic paths and the exact fields to inspect after reproduction.
