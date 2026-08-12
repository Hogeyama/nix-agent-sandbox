# Forgejow Session Lifetime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `forgejow request-review` alive as a Coding Agent lifecycle lease while running Forgejo in a TTY-independent session that is cleaned up with the lease.

**Architecture:** `request-review` remains attached to the Coding Agent tool process, prints the review information, then waits for the Forgejo it launched. Forgejo runs under `setsid` with no controlling TTY, while signal and exit traps on the waiter call the existing idempotent `fj_down` cleanup path.

**Tech Stack:** Bash, util-linux `setsid`, Forgejo 16.0.2, Linux process sessions/groups, existing real-Forgejo integration test

## Global Constraints

- Read and follow `docs/superpowers/specs/2026-08-13-forgejow-session-lifetime-design.md`.
- Read and follow `skills/test-policy/SKILL.md`; the real Forgejo integration test owns and cleans all processes it starts.
- Finish with `skills/post-change-checks/SKILL.md`: `bun run fmt`, `bun run lint`, `bun run check`, then `bun test`, stopping at the first failure.
- Do not modify hostexec broker lifecycle, Docker lifecycle, systemd units, or Forgejo upstream.
- Do not add a fallback that starts Forgejo in the caller's SID/PGID/TTY when `setsid` is unavailable or isolation validation fails.
- Keep `fetch-comments`, `push`, `reply`, `resolve`, and `down` compatible with the shared run directory and PID file.
- Preserve the existing staged process-diagnostics work and commit it separately before staging lifecycle changes.
- `SIGKILL` of only the lease process remains outside the guarantee because Bash cannot trap it.

---

### Task 1: Close the existing process-diagnostics change

**Files:**
- Existing staged files only; inspect with `git diff --cached --name-only`
- Do not stage any Forgejow lifecycle implementation in this task

**Interfaces:**
- Produces: a clean commit containing the already-staged hostexec and Forgejo diagnostic logging
- Consumes: the current Git index exactly as it exists before lifecycle implementation

- [ ] **Step 1: Confirm the staged boundary**

Run:

```bash
git diff --cached --name-only
git diff --cached --check
```

Expected: only the two existing diagnostic docs, hostexec diagnostic source/tests, and current Forgejow diagnostic edits are listed; `git diff --cached --check` exits 0.

- [ ] **Step 2: Verify the staged diagnostic implementation**

Run:

```bash
bun test src/hostexec/process_diagnostics_test.ts src/hostexec/broker_integration_test.ts
./skills/patched-superpowers/scripts/test_forgejow.sh
```

Expected: both commands exit 0. This is verification of the already-written debugging instrumentation, not a new bugfix TDD cycle.

- [ ] **Step 3: Commit only the staged diagnostic baseline**

```bash
git commit -m "chore(debug): record hostexec process lifecycle"
git status --short
```

Expected: the diagnostics leave the index as their own commit; no lifecycle behavior has been added.

---

### Task 2: Isolate the Forgejo server from the caller terminal

**Files:**
- Modify: `skills/patched-superpowers/scripts/test_forgejow.sh:70-94`
- Modify: `skills/patched-superpowers/scripts/lib/forgejo_instance.sh:186-244`

**Interfaces:**
- Produces: `fj_process_is_isolated PID`, returning 0 only when `PID == PGID == SID` and TTY is `?`
- Produces: global `FJ_STARTED_PID`, set to the PID started by the current shell and empty when `fj_up` reused an existing instance
- Consumes: util-linux `setsid`, `ps`, existing `web.pid`, `web.log`, and `fj_log_process_event`

- [ ] **Step 1: Add failing process-topology assertions**

After the first successful `fj_up` in `test_forgejow.sh`, capture the web PID and assert its topology:

```bash
WEB_PID="$(cat "$(fj_run_dir)/web.pid")"
read -r WEB_PGID WEB_SID WEB_TTY < <(
  ps -o pgid=,sid=,tty= -p "$WEB_PID"
)
assert_eq "Forgejo が専用 process group にいる" "$WEB_PID" "$WEB_PGID"
assert_eq "Forgejo が専用 session にいる" "$WEB_PID" "$WEB_SID"
assert_eq "Forgejo が controlling TTY を持たない" "?" "$WEB_TTY"
```

- [ ] **Step 2: Run the integration test and verify the regression test fails**

Run:

```bash
./skills/patched-superpowers/scripts/test_forgejow.sh
```

Expected: at least the PGID/SID assertions fail because current `nohup forgejo ... &` remains in the caller's process group and session.

- [ ] **Step 3: Add strict isolation validation**

Add this helper to `forgejo_instance.sh`:

```bash
fj_process_is_isolated() {
  local pid="$1" actual_pid pgid sid tty
  read -r actual_pid pgid sid tty < <(
    ps -o pid=,pgid=,sid=,tty= -p "$pid" 2>/dev/null
  ) || return 1
  [ "$actual_pid" = "$pid" ] &&
    [ "$pgid" = "$pid" ] &&
    [ "$sid" = "$pid" ] &&
    [ "$tty" = "?" ]
}
```

At the start of `fj_up`, reset ownership and require the launch dependency:

```bash
FJ_STARTED_PID=""
fj_healthy && return 0
command -v forgejo >/dev/null || { fj_die "forgejo が見つからない"; return 1; }
command -v jq >/dev/null || { fj_die "jq が見つからない"; return 1; }
command -v setsid >/dev/null || { fj_die "setsid が見つからない"; return 1; }
```

Replace the `nohup` launch with a non-job-control background child that `setsid` can exec without forking:

```bash
set +m
setsid forgejo web -c "$conf" </dev/null >"$run/log/web.log" 2>&1 &
pid=$!
echo "$pid" >"$run/web.pid"
fj_log_process_event forgejo_spawned "$pid"
```

When health becomes ready, validate topology before returning ownership to the caller:

```bash
if fj_healthy; then
  if ! fj_process_is_isolated "$pid"; then
    fj_log_process_event forgejo_isolation_failed "$pid"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 1
  fi
  FJ_STARTED_PID="$pid"
  return 0
fi
```

- [ ] **Step 4: Run the integration test and verify isolation passes**

Run:

```bash
./skills/patched-superpowers/scripts/test_forgejow.sh
```

Expected: all existing assertions and the three new topology assertions pass.

- [ ] **Step 5: Commit the isolation change**

```bash
git add skills/patched-superpowers/scripts/lib/forgejo_instance.sh \
  skills/patched-superpowers/scripts/test_forgejow.sh
git diff --cached --check
git commit -m "fix(forgejow): isolate Forgejo from caller terminal"
```

---

### Task 3: Hold a foreground lease for the Forgejo lifetime

**Files:**
- Modify: `skills/patched-superpowers/scripts/test_forgejow.sh:15-35,96-203`
- Modify: `skills/patched-superpowers/scripts/lib/forgejo_instance.sh:246-260`
- Modify: `skills/patched-superpowers/scripts/forgejow:14-19,39-69`
- Modify: `skills/patched-superpowers/SKILL.md` in `Phase 3: 全体 diff の人間レビュー`

**Interfaces:**
- Produces: `fj_wait_for_web PID OWNED_PID`, using Bash `wait` when `PID == OWNED_PID` and liveness polling only for a reused non-child process
- Produces: `request-review` output before it blocks, followed by a live tool process until Forgejo stops
- Consumes: `FJ_STARTED_PID`, `web.pid`, idempotent `fj_down`, and Coding Agent background/yield execution

- [ ] **Step 1: Convert the test request into a bounded asynchronous lease**

Add process tracking and bounded wait helpers to `test_forgejow.sh`:

```bash
REQUEST_PID=""
REQUEST_OUT=""

wait_until() {
  local description="$1"; shift
  for _ in $(seq 1 120); do
    "$@" && return 0
    sleep 0.25
  done
  ng "$description" "timed out"
  return 1
}

process_is_dead() { ! kill -0 "$1" 2>/dev/null; }
output_has_pr() { grep -q '/pulls/1' "$1" 2>/dev/null; }

start_request_lease() {
  REQUEST_OUT="$WORK/request-review-$RANDOM.out"
  setsid "$FORGEJOW" request-review "$(cat "$WORK/base")..HEAD" \
    >"$REQUEST_OUT" 2>&1 &
  REQUEST_PID=$!
  wait_until "request-review がPR情報を出力する" output_has_pr "$REQUEST_OUT"
}
```

Extend `cleanup` so it terminates and waits for `REQUEST_PID` before removing `$WORK`:

```bash
if [ -n "$REQUEST_PID" ]; then
  kill -TERM "$REQUEST_PID" 2>/dev/null || true
  wait "$REQUEST_PID" 2>/dev/null || true
fi
```

Replace the blocking command substitution in Task 2 of the test:

```bash
start_request_lease
OUT="$(cat "$REQUEST_OUT")"
assert_eq "request-review が出力後もleaseを保持する" yes \
  "$(kill -0 "$REQUEST_PID" 2>/dev/null && echo yes || echo no)"
```

- [ ] **Step 2: Add failing cleanup assertions for explicit down and TTY hangup**

After the existing API/review assertions, stop the first instance explicitly and assert that its waiter exits:

```bash
"$FORGEJOW" down
wait_until "down 後にrequest-reviewが終了する" process_is_dead "$REQUEST_PID"
assert_eq "down でleaseが終了する" no \
  "$(kill -0 "$REQUEST_PID" 2>/dev/null && echo yes || echo no)"
wait "$REQUEST_PID" 2>/dev/null || true
REQUEST_PID=""
```

Start one final lease and send `SIGTERM` directly to the waiter:

```bash
start_request_lease
TERM_WEB_PID="$(cat "$(fj_run_dir)/web.pid")"
kill -TERM "$REQUEST_PID"
wait_until "SIGTERM後にrequest-reviewが終了する" process_is_dead "$REQUEST_PID"
wait_until "SIGTERM cleanup後にForgejoが終了する" process_is_dead "$TERM_WEB_PID"
assert_eq "waiterのSIGTERMでForgejoも終了する" no \
  "$(kill -0 "$TERM_WEB_PID" 2>/dev/null && echo yes || echo no)"
wait "$REQUEST_PID" 2>/dev/null || true
REQUEST_PID=""
```

Start another lease, capture its isolated Forgejo PID, and hang up only the waiter's dedicated process group:

```bash
start_request_lease
HUP_WEB_PID="$(cat "$(fj_run_dir)/web.pid")"
kill -HUP -- "-$REQUEST_PID"
wait_until "SIGHUP後にrequest-reviewが終了する" process_is_dead "$REQUEST_PID"
wait_until "SIGHUP cleanup後にForgejoが終了する" process_is_dead "$HUP_WEB_PID"
assert_eq "waiterのSIGHUPでForgejoも終了する" no \
  "$(kill -0 "$HUP_WEB_PID" 2>/dev/null && echo yes || echo no)"
wait "$REQUEST_PID" 2>/dev/null || true
REQUEST_PID=""
```

Run:

```bash
./skills/patched-superpowers/scripts/test_forgejow.sh
```

Expected: the lease-alive assertion fails because current `request-review` exits after printing. The HUP cleanup scenario cannot pass until the lease and traps exist.

- [ ] **Step 3: Implement child wait and reused-process monitoring**

Add to `forgejo_instance.sh`:

```bash
fj_wait_for_web() {
  local pid="$1" owned_pid="${2:-}"
  if [ -n "$owned_pid" ] && [ "$pid" = "$owned_pid" ]; then
    wait "$pid"
    return $?
  fi
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.25
  done
}
```

- [ ] **Step 4: Install cleanup traps before PR setup and hold the lease after output**

Update the usage text in `forgejow` to say that `request-review` waits until Forgejo stops. In `cmd_request_review`, install cleanup immediately after `fj_up` succeeds:

```bash
local web_pid owned_pid rc
fj_up || return 1
web_pid="$(cat "$(fj_run_dir)/web.pid")"
owned_pid="${FJ_STARTED_PID:-}"
trap 'fj_down' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
```

Keep the existing smoke, push, PR creation, and output code unchanged. After the final diagnostic-path output, hold and then cleanly release the lease:

```bash
fj_wait_for_web "$web_pid" "$owned_pid"
rc=$?
trap - HUP INT TERM EXIT
fj_down
return "$rc"
```

The `EXIT` trap covers every early `return` after startup. Signal traps convert the signal into an exit so the `EXIT` cleanup runs exactly through `fj_down`.

- [ ] **Step 5: Document how agents must retain the long-running tool session**

In `skills/patched-superpowers/SKILL.md`, replace the synchronous Phase 3 startup instruction with:

```markdown
2. `./skills/patched-superpowers/scripts/forgejow request-review implementation-base..HEAD`
   を長時間実行として起動する。PR URL とログイン情報が出力された後も、このtool session/jobを
   終了させず、レビュー完了までhandleを保持する。Codexではyieldされたexec sessionを保持し、
   background executionを明示する必要があるagentではbackground jobとして起動する。
```

Keep the existing instruction to run `forgejow down` after human approval; that command now also releases the waiting `request-review` tool session.

- [ ] **Step 6: Run the complete real-Forgejo integration test**

Run:

```bash
./skills/patched-superpowers/scripts/test_forgejow.sh
```

Expected: all assertions pass, including output-before-wait, explicit-down release, isolated topology, and SIGHUP cleanup. The test process table contains no PID recorded in any test `web.pid` after cleanup.

- [ ] **Step 7: Commit the lease behavior and its usage contract**

```bash
git add skills/patched-superpowers/scripts/forgejow \
  skills/patched-superpowers/scripts/lib/forgejo_instance.sh \
  skills/patched-superpowers/scripts/test_forgejow.sh \
  skills/patched-superpowers/SKILL.md
git diff --cached --check
git commit -m "fix(forgejow): bind review server to request lifetime"
```

---

### Task 4: Full verification

**Files:**
- No production changes expected except formatter output

**Interfaces:**
- Consumes: all commits from Tasks 1-3
- Produces: fresh repository-wide verification evidence

- [ ] **Step 1: Run the standard post-change checks in order**

```bash
bun run fmt
bun run lint
bun run check
bun test
```

Expected: each command exits 0. Stop at the first failure and diagnose it before continuing.

- [ ] **Step 2: Re-run the lifecycle integration test after repository formatting**

```bash
./skills/patched-superpowers/scripts/test_forgejow.sh
```

Expected: all assertions pass and cleanup leaves no test Forgejo or request-review process.

- [ ] **Step 3: Inspect the final commit range and worktree**

```bash
git log --oneline --decorate -4
git status --short
git diff --check
```

Expected: diagnostics, isolation, and lease behavior are separate commits. Any remaining changes predate this plan or are explicitly reported; no lifecycle implementation remains uncommitted.
