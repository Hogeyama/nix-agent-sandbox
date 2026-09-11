#!/usr/bin/env bash
# Exercise the built sumi binary against decoy values. Never touches a real
# repository; needs bash and jq.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sumi="${SUMI_BIN:-$script_dir/../zig-out/bin/sumi}"
[ -x "$sumi" ] || { echo "sumi not found at $sumi; run 'zig build' in contrib/sumi first" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

current="Tr0ub4dor"
retired="hunter2xyz"
quoted='ab"cd-decoy'

printf '%s\n%s\n' "$current" "$retired" > "$work/secrets.txt"
printf '%s\n' "$quoted" > "$work/quoted.txt"
printf 'true\n' > "$work/token.txt"
: > "$work/empty.txt"

passed=0
failed=0
status_failures="$work/unexpected-statuses"
: > "$status_failures"

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf 'ok  %s\n' "$name"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$name" "$expected" "$actual"
    failed=$((failed + 1))
  fi
}

record_success_status() {
  local invocation="$1" status="$2"
  if [ "$status" -ne 0 ]; then
    printf '%s\t%s\n' "$invocation" "$status" >> "$status_failures"
  fi
}

filter_success() {
  "$sumi" filter --secrets-file "$work/secrets.txt"
  local status=$?
  record_success_status filter "$status"
}

post() {
  printf '%s' "$1" | "$sumi" hook --agent claude post-tool --secrets-file "${2:-$work/secrets.txt}"
  local statuses=("${PIPESTATUS[@]}")
  record_success_status post-tool "${statuses[1]}"
}

prompt() {
  printf '%s' "$1" | "$sumi" hook --agent claude prompt --secrets-file "$work/secrets.txt" "${@:2}"
  local statuses=("${PIPESTATUS[@]}")
  record_success_status prompt "${statuses[1]}"
}

prebash() {
  printf '%s' "$1" | "$sumi" hook --agent claude pre-bash --secrets-file "${2:-$work/secrets.txt}" --shell /bin/bash
  local statuses=("${PIPESTATUS[@]}")
  record_success_status pre-bash "${statuses[1]}"
}

prompt_with_missing_secrets() {
  printf '%s' '{"prompt":""}' | "$sumi" hook --agent claude prompt --secrets-file "$work/missing.txt" | decision
  local statuses=("${PIPESTATUS[@]}")
  record_success_status prompt "${statuses[1]}"
}

delivered() { jq -r '.hookSpecificOutput.updatedToolOutput | if type == "string" then . else tojson end' 2>/dev/null; }
decision() { jq -r '.decision // ""'; }
leaks() {
  case "$1" in
    *"$current"* | *"$retired"* | *"$quoted"*) echo yes ;;
    *) echo no ;;
  esac
}

# --- filter and run ----------------------------------------------------------

out="$(printf 'before=%s after=%s\n' "$current" "$retired" | filter_success)"
check "filter masks every listed value" 'before=********* after=**********' "$out"

"$sumi" run --secrets-file "$work/secrets.txt" -- /bin/bash -c \
  'printf "stdout=%s\n" "Tr0ub4dor"; printf "stderr=%s\n" "hunter2xyz" >&2; exit 7' \
  >"$work/run.stdout" 2>"$work/run.stderr"
status=$?
check "run masks stdout" 'stdout=*********' "$(cat "$work/run.stdout")"
check "run masks stderr" 'stderr=**********' "$(cat "$work/run.stderr")"
check "run keeps the child exit status" "7" "$status"

out="$("$sumi" run --secrets-file "$work/secrets.txt" -- /bin/bash -c 'printf %s "$SUMI_SUPERVISED"')"
record_success_status "run supervised child" "$?"
check "run marks the child as supervised" "1" "$out"

"$sumi" run --secrets-file "$work/missing.txt" -- /bin/bash -c \
  'touch "$1"; printf Tr0ub4dor' _ "$work/missing-ran" >"$work/missing.out" 2>"$work/missing.err"
status=$?
check "run with a missing list exits 121" "121" "$status"
check "run with a missing list suppresses execution" "no" "$([ -e "$work/missing-ran" ] && echo yes || echo no)"
check "run with a missing list suppresses stdout" "0" "$(wc -c < "$work/missing.out" | tr -d ' ')"

"$sumi" run --secrets-file "$work/empty.txt" -- /bin/bash -c \
  'touch "$1"; printf Tr0ub4dor' _ "$work/empty-ran" >"$work/empty.out" 2>"$work/empty.err"
status=$?
check "run with an empty list exits 121" "121" "$status"
check "run with an empty list suppresses execution" "no" "$([ -e "$work/empty-ran" ] && echo yes || echo no)"
check "run with an empty list suppresses stdout" "0" "$(wc -c < "$work/empty.out" | tr -d ' ')"

"$sumi" filter </dev/null >/dev/null 2>&1
check "filter missing --secrets-file exits 2" "2" "$?"
printf '%s' "$current" | "$sumi" filter --secrets-file "$work/missing.txt" >"$work/filter-missing.out" 2>"$work/filter-missing.err"
check "filter with a missing list exits 1" "1" "$?"
check "filter with a missing list suppresses input" "0" "$(wc -c < "$work/filter-missing.out" | tr -d ' ')"
printf '%s' "$current" | "$sumi" filter --secrets-file "$work/empty.txt" >"$work/filter-empty.out" 2>"$work/filter-empty.err"
check "filter with an empty list exits 1" "1" "$?"
check "filter with an empty list suppresses input" "0" "$(wc -c < "$work/filter-empty.out" | tr -d ' ')"
"$sumi" filter --secrets-file "$work/secrets.txt" --unsupported </dev/null >/dev/null 2>&1
check "filter unsupported argument exits 2" "2" "$?"
"$sumi" run --secrets-file "$work/secrets.txt" >/dev/null 2>&1
check "run missing command exits 2" "2" "$?"

# --- post-tool ---------------------------------------------------------------

out="$(post "$(jq -nc --arg v "$current" '{hook_event_name:"PostToolUse",tool_name:"Read",tool_input:{file_path:"/decoy/config/app.properties"},tool_response:{type:"text",file:{content:("db.password=" + $v + "\n")}}}')" | delivered)"
check "Read output, current value" 'db.password=*********\n' "$(jq -nr --arg o "$out" '$o | fromjson | .file.content | @json' | sed 's/^"//;s/"$//')"

out="$(post "$(jq -nc --arg v "$retired" '{tool_name:"Bash",tool_input:{command:"git show HEAD~9:config/app.properties"},tool_response:{stdout:("db.password=" + $v),stderr:""}}')" | delivered)"
check "Bash git show, value only in history" "no" "$(leaks "$out")"

check "unrelated output passes through" "" "$(post '{"tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"stdout":"README.md\n","stderr":""}}')"
check "value in tool_input alone does not replace output" "" "$(post "$(jq -nc --arg v "$current" '{tool_name:"Bash",tool_input:{command:("echo " + $v)},tool_response:{stdout:"done\n"}}')")"

out="$(post "$(jq -nc --arg v "$quoted" '{tool_response:{stdout:("pass=" + $v)}}')" "$work/quoted.txt" | delivered)"
check "value that JSON-escapes is masked" 'pass=***********' "$(jq -nr --arg o "$out" '$o | fromjson | .stdout')"

out="$(post '{"tool_response":{"ok":true,"s":"true"}}' "$work/token.txt" | delivered)"
check "a secret spelled like a JSON token leaves the structure intact" '{"ok":true,"s":"****"}' "$out"

out="$(post '{"tool_response":{"stdout":"x"}}' "$work/missing.txt" | delivered)"
case "$out" in
  sumi:*withheld*) check "missing secrets file withholds output" "ok" "ok" ;;
  *) check "missing secrets file withholds output" "ok" "$out" ;;
esac

out="$(post "$(jq -nc --arg v "$current" '{tool_response:{stdout:("p=" + $v)}}')" "$work/empty.txt" | delivered)"
check "empty secrets file does not pass the value" "no" "$(leaks "$out")"

out="$(post "$(jq -nc --arg v "$current" '{hook_event_name:"PostToolUseFailure",tool_name:"Bash",tool_input:{command:"cat decoy && false"},error:("Exit code 1\ndb.password=" + $v)}')" | jq -r 'keys | join(",")')"
check "failed call reports rather than masks" "systemMessage" "$out"
check "failed call without the value stays quiet" "" "$(post '{"hook_event_name":"PostToolUseFailure","error":"Exit code 1\nno such file"}')"

out="$(post 'not json' | delivered)"
case "$out" in
  sumi:*withheld*) check "malformed post-tool input withholds output" "ok" "ok" ;;
  *) check "malformed post-tool input withholds output" "ok" "$out" ;;
esac
out="$(post '' | delivered)"
case "$out" in
  sumi:*withheld*) check "empty post-tool input withholds output" "ok" "ok" ;;
  *) check "empty post-tool input withholds output" "ok" "$out" ;;
esac

depth_open_boundary="$(printf '%127s' '' | tr ' ' '[')"
depth_close_boundary="$(printf '%127s' '' | tr ' ' ']')"
depth_boundary_payload="{\"tool_response\":${depth_open_boundary}\"${current}\"${depth_close_boundary}}"
out="$(post "$depth_boundary_payload")"
check "post-tool accepts and masks the JSON depth boundary" "no" "$(leaks "$out")"
case "$out" in
  *'*********'*) check "post-tool emits a replacement at the JSON depth boundary" "ok" "ok" ;;
  *) check "post-tool emits a replacement at the JSON depth boundary" "ok" "$out" ;;
esac

depth_open_over="$(printf '%128s' '' | tr ' ' '[')"
depth_close_over="$(printf '%128s' '' | tr ' ' ']')"
depth_over_payload="{\"tool_response\":${depth_open_over}\"${current}\"${depth_close_over}}"
out="$(post "$depth_over_payload")"
check "post-tool withholds output beyond the JSON depth boundary" "no" "$(leaks "$out")"
case "$out" in
  *withheld*) check "post-tool explains JSON depth withholding" "ok" "ok" ;;
  *) check "post-tool explains JSON depth withholding" "ok" "$out" ;;
esac

depth_open_deep="$(printf '%1000s' '' | tr ' ' '[')"
depth_close_deep="$(printf '%1000s' '' | tr ' ' ']')"
depth_failure_payload="{\"hook_event_name\":\"PostToolUseFailure\",\"error\":\"x\",\"nested\":${depth_open_deep}0${depth_close_deep}}"
out="$(post "$depth_failure_payload" | jq -r 'keys | join(",")')"
check "deep PostToolUseFailure remains report-only" "systemMessage" "$out"

# --- prompt ------------------------------------------------------------------

check "prompt carrying the value is blocked" "block" "$(prompt "$(jq -nc --arg v "$current" '{prompt:("is the password " + $v + "?")}')" | decision)"
check "attachment of an explicitly denied path is blocked" "block" "$(prompt '{"prompt":"please read @/decoy/real-repo/config/app.properties"}' --deny-path /decoy/real-repo | decision)"
check "ordinary prompt is allowed" "" "$(prompt '{"prompt":"please summarise the build failure"}' --deny-path /decoy/real-repo)"
check "naming the file without attaching it is allowed" "" "$(prompt '{"prompt":"what does app.properties hold?"}' --deny-path app.properties)"
check "attaching the file under any path is blocked" "block" "$(prompt '{"prompt":"look at @config/app.properties"}' --deny-path app.properties | decision)"

mkdir -p "$work/attach/sub"
printf 'db.password=%s\n' "$current" > "$work/attach/holds.properties"
printf 'nothing of interest\n' > "$work/attach/clean.properties"
printf 'x=%s\n' "$current" > "$work/attach/sub/nested.properties"
head -c 64 /dev/urandom > "$work/attach/blob.bin"
printf '%s' "$current" >> "$work/attach/blob.bin"

attach() {
  jq -nc --arg p "$1" --arg c "$work/attach" '{prompt:$p,cwd:$c}' | "$sumi" hook --agent claude prompt --secrets-file "$work/secrets.txt" "${@:2}" | decision
  local statuses=("${PIPESTATUS[@]}")
  record_success_status prompt "${statuses[1]}"
}

check "attachment holding the value is blocked" "block" "$(attach 'see @holds.properties')"
check "attachment without the value is allowed" "" "$(attach 'see @clean.properties')"
check "attached directory is checked file by file" "block" "$(attach 'see @sub')"
check "attachment holding the value in binary is blocked" "block" "$(attach 'see @blob.bin')"
check "absolute attachment path is resolved" "block" "$(attach "see @$work/attach/holds.properties")"
check "attachment found by name elsewhere in the tree" "block" "$(attach 'see @elsewhere/nested.properties')"
check "unverifiable attachment is rejected" "block" "$(attach 'see @./gone.properties')"
check "an annotation is not an attachment" "" "$(attach 'add @Override to it')"
check "a mail address is not an attachment" "" "$(attach 'write to user@example.com')"
check "a version tag is not an attachment" "" "$(attach 'cut @v1.2.3')"
check "a subagent mention is not an attachment" "" "$(attach 'ask @agent-general-purpose')"
check "an MCP resource is rejected" "block" "$(attach 'read @github:repo://owner/name')"

mkdir -p "$work/other"
printf 'nothing of interest\n' > "$work/other/elsewhere.properties"
check "--root makes another directory checkable" "" "$(attach 'see @elsewhere.properties' --root "$work/other")"

check "malformed prompt input is blocked" "block" "$(prompt 'not json' | decision)"
check "empty prompt input is blocked" "block" "$(prompt '' | decision)"
out="$(prompt_with_missing_secrets)"
check "empty prompt with missing secrets is blocked" "block" "$out"
depth_prompt_payload="{\"prompt\":\"clean\",\"nested\":${depth_open_over}0${depth_close_over}}"
check "prompt beyond the JSON depth boundary is blocked" "block" "$(prompt "$depth_prompt_payload" | decision)"

# --- pre-bash ----------------------------------------------------------------

wrapped="$(prebash '{"tool_input":{"command":"cat decoy && false"}}' | jq -r '.hookSpecificOutput.updatedInput.command')"
case "$wrapped" in
  *" run --secrets-file "*" -- /bin/bash -c 'cat decoy && false'") check "pre-bash wraps the command" "ok" "ok" ;;
  *) check "pre-bash wraps the command" "ok" "$wrapped" ;;
esac

check "pre-bash returns no permissionDecision" "null" "$(prebash '{"tool_input":{"command":"ls"}}' | jq -r '.hookSpecificOutput.permissionDecision')"

printf 'db.password=%s\n' "$current" > "$work/decoy.txt"
observed="$(bash -c "$(prebash "$(jq -nc --arg f "$work/decoy.txt" '{tool_input:{command:("cat " + $f + " && false")}}')" | jq -r '.hookSpecificOutput.updatedInput.command')" 2>&1)"
check "wrapped command masks a failing command's output" "no" "$(leaks "$observed")"
bash -c "$(prebash '{"tool_input":{"command":"exit 7"}}' | jq -r '.hookSpecificOutput.updatedInput.command')" >/dev/null 2>&1
check "wrapped command keeps the exit status" "7" "$?"
check "already wrapped command is left alone" "" "$(prebash "$(jq -nc --arg w "$wrapped" '{tool_input:{command:$w}}')")"

compound_wrapper="$wrapped; cat '$work/decoy.txt'; false"
compound_rewrite="$(prebash "$(jq -nc --arg w "$compound_wrapper" '{tool_input:{command:$w}}')" | jq -r '.hookSpecificOutput.updatedInput.command // ""')"
check "a compound command after a wrapper is wrapped again" "yes" "$([ -n "$compound_rewrite" ] && echo yes || echo no)"
compound_observed="$(bash -c "$compound_rewrite" 2>&1)"
compound_status=$?
check "a compound wrapper command masks all output" "no" "$(leaks "$compound_observed")"
check "a compound wrapper command keeps its final status" "1" "$compound_status"

sumi_real="$(readlink -f "$sumi")"
wrong_secrets_wrapper="$sumi_real run --secrets-file $work/quoted.txt -- /bin/bash -c true"
wrong_shell_wrapper="$sumi_real run --secrets-file $work/secrets.txt -- /bin/sh -c true"
unquoted_expansion="$sumi_real run --secrets-file $work/secrets.txt -- /bin/bash -c \$(printf Tr0ub4dor)"
for unsafe_wrapper_case in "$wrong_secrets_wrapper" "$wrong_shell_wrapper" "$unquoted_expansion"; do
  out="$(prebash "$(jq -nc --arg w "$unsafe_wrapper_case" '{tool_input:{command:$w}}')" | jq -r '.hookSpecificOutput.updatedInput.command // ""')"
  case "$out" in
    *"$unsafe_wrapper_case"*) check "noncanonical wrapper input is wrapped again" "ok" "ok" ;;
    *) check "noncanonical wrapper input is wrapped again" "ok" "$out" ;;
  esac
done
check "pre-bash denies when the list is unreadable" "deny" "$(prebash '{"tool_input":{"command":"ls"}}' "$work/missing.txt" | jq -r '.hookSpecificOutput.permissionDecision // ""')"
check "pre-bash denies on an empty list" "deny" "$(prebash '{"tool_input":{"command":"ls"}}' "$work/empty.txt" | jq -r '.hookSpecificOutput.permissionDecision // ""')"
check "malformed pre-bash input is denied" "deny" "$(prebash 'not json' | jq -r '.hookSpecificOutput.permissionDecision // ""')"
check "empty pre-bash input is denied" "deny" "$(prebash '' | jq -r '.hookSpecificOutput.permissionDecision // ""')"
depth_bash_payload="{\"tool_input\":{\"command\":\"true\"},\"nested\":${depth_open_over}0${depth_close_over}}"
check "pre-bash beyond the JSON depth boundary is denied" "deny" "$(prebash "$depth_bash_payload" | jq -r '.hookSpecificOutput.permissionDecision // ""')"

printf '' | "$sumi" hook --agent claude pre-bash --secrets-file "$work/secrets.txt" --shell /bin/bash > /dev/full 2>"$work/pre-bash-write.err"
write_statuses=("${PIPESTATUS[@]}")
check "pre-bash keeps its decision status when stdout is unusable" "0" "${write_statuses[1]}"
case "$(cat "$work/pre-bash-write.err")" in
  sumi:\ pre-bash\ could\ not\ write*) check "pre-bash reports an unusable decision channel" "ok" "ok" ;;
  *) check "pre-bash reports an unusable decision channel" "sumi: pre-bash could not write..." "$(cat "$work/pre-bash-write.err")" ;;
esac

printf '' | "$sumi" hook --agent claude prompt --secrets-file "$work/secrets.txt" > /dev/full 2>"$work/prompt-write.err"
write_statuses=("${PIPESTATUS[@]}")
check "prompt keeps its decision status when stdout is unusable" "0" "${write_statuses[1]}"
case "$(cat "$work/prompt-write.err")" in
  sumi:\ prompt\ could\ not\ write*) check "prompt reports an unusable decision channel" "ok" "ok" ;;
  *) check "prompt reports an unusable decision channel" "sumi: prompt could not write..." "$(cat "$work/prompt-write.err")" ;;
esac

depth_settings="$work/deep-settings.json"
printf '%s' "${depth_open_over}0${depth_close_over}" > "$depth_settings"
"$sumi" init --agent claude --secrets-file "$work/secrets.txt" --settings "$depth_settings" --shell /bin/bash >/dev/null 2>&1
check "init beyond the JSON depth boundary fails without aborting" "1" "$?"

"$sumi" init --agent claude --secrets-file "$work/missing.txt" --settings "$work/unused-settings.json" --shell /bin/bash >/dev/null 2>"$work/init-diagnostic.err"
check "init failure uses the common sumi diagnostic prefix" "1" "$?"
case "$(cat "$work/init-diagnostic.err")" in
  sumi:\ *) check "init diagnostic starts with sumi colon" "ok" "ok" ;;
  *) check "init diagnostic starts with sumi colon" "ok" "$(cat "$work/init-diagnostic.err")" ;;
esac

# --- argument errors ---------------------------------------------------------

check_hook_usage() {
  local name="$1"
  shift
  "$sumi" hook --agent claude "$@" </dev/null >"$work/usage.out" 2>"$work/usage.err"
  check "$name" "2" "$?"
}

check_hook_usage "post-tool rejects unknown options" post-tool --secrets-file "$work/secrets.txt" --wat x
check_hook_usage "post-tool rejects duplicate singular options" post-tool --secrets-file "$work/secrets.txt" --secrets-file "$work/secrets.txt"
check_hook_usage "post-tool rejects missing option values" post-tool --secrets-file
check_hook_usage "post-tool rejects positional arguments" post-tool --secrets-file "$work/secrets.txt" stray

check_hook_usage "prompt rejects unknown options" prompt --secrets-file "$work/secrets.txt" --deny-pth notes.txt
check_hook_usage "prompt rejects duplicate singular options" prompt --secrets-file "$work/secrets.txt" --secrets-file "$work/secrets.txt"
check_hook_usage "prompt rejects missing option values" prompt --secrets-file "$work/secrets.txt" --deny-path
check_hook_usage "prompt rejects positional arguments" prompt --secrets-file "$work/secrets.txt" stray

check_hook_usage "pre-bash rejects unknown options" pre-bash --secrets-file "$work/secrets.txt" --shell /bin/bash --wat x
check_hook_usage "pre-bash rejects duplicate singular options" pre-bash --secrets-file "$work/secrets.txt" --shell /bin/bash --shell /bin/sh
check_hook_usage "pre-bash rejects missing option values" pre-bash --secrets-file "$work/secrets.txt" --shell
check_hook_usage "pre-bash rejects positional arguments" pre-bash --secrets-file "$work/secrets.txt" --shell /bin/bash stray

"$sumi" hook --agent copilot post-tool --secrets-file "$work/secrets.txt" </dev/null >/dev/null 2>&1
check "unsupported --agent exits 2" "2" "$?"
"$sumi" hook post-tool --secrets-file "$work/secrets.txt" </dev/null >/dev/null 2>&1
check "missing --agent exits 2" "2" "$?"

while IFS=$'\t' read -r invocation status; do
  [ -n "$invocation" ] || continue
  check "$invocation exits 0" "0" "$status"
done < "$status_failures"

printf '\npassed %d, failed %d\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
