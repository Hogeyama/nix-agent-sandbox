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

"$sumi" run --secrets-file "$work/secrets.txt" --shell /bin/bash \
  'printf "stdout=%s\n" "Tr0ub4dor"; printf "stderr=%s\n" "hunter2xyz" >&2; exit 7' \
  >"$work/run.stdout" 2>"$work/run.stderr"
status=$?
check "run masks stdout" 'stdout=*********' "$(cat "$work/run.stdout")"
check "run masks stderr" 'stderr=**********' "$(cat "$work/run.stderr")"
check "run keeps the child exit status" "7" "$status"

out="$("$sumi" run --secrets-file "$work/secrets.txt" 'printf %s "$SUMI_SUPERVISED"')"
record_success_status "run supervised child" "$?"
check "run marks the child as supervised" "1" "$out"

"$sumi" run --secrets-file "$work/missing.txt" --shell /bin/bash \
  "touch '$work/missing-ran'; printf Tr0ub4dor" >"$work/missing.out" 2>"$work/missing.err"
status=$?
check "run with a missing list exits 121" "121" "$status"
check "run with a missing list suppresses execution" "no" "$([ -e "$work/missing-ran" ] && echo yes || echo no)"
check "run with a missing list suppresses stdout" "0" "$(wc -c < "$work/missing.out" | tr -d ' ')"

"$sumi" run --secrets-file "$work/empty.txt" --shell /bin/bash \
  "touch '$work/empty-ran'; printf Tr0ub4dor" >"$work/empty.out" 2>"$work/empty.err"
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

whole_command="IFS= read -r value; printf 'file=%s\\n' \"\$value\" > '$work/whole-command.txt'; cat '$work/whole-command.txt'; printf 'stderr=%s\\n' 'hunter2xyz' >&2; exit 9"
printf '%s\n' "$current" | "$sumi" run --secrets-file "$work/secrets.txt" --shell /bin/bash "$whole_command" >"$work/prefix.stdout" 2>"$work/prefix.stderr"
statuses=("${PIPESTATUS[@]}")
check "prefix run evaluates one whole command with stdin and redirects" 'file=*********' "$(cat "$work/prefix.stdout")"
check "prefix run masks stderr" 'stderr=**********' "$(cat "$work/prefix.stderr")"
check "prefix run preserves compound command status" "9" "${statuses[1]}"

"$sumi" run --secrets-file "$work/secrets.txt" --shell "$work/missing-shell" "touch '$work/missing-shell-ran'" >/dev/null 2>&1
check "prefix run rejects a missing shell" "121" "$?"
check "missing shell does not execute the command" "no" "$([ -e "$work/missing-shell-ran" ] && echo yes || echo no)"
printf '#!/bin/sh\nexit 0\n' > "$work/not-executable"
chmod 600 "$work/not-executable"
"$sumi" run --secrets-file "$work/secrets.txt" --shell "$work/not-executable" "touch '$work/nonexec-shell-ran'" >/dev/null 2>&1
check "prefix run rejects a non-executable shell" "121" "$?"
check "non-executable shell does not execute the command" "no" "$([ -e "$work/nonexec-shell-ran" ] && echo yes || echo no)"

"$sumi" run --secrets-file "$work/secrets.txt" --shell /bin/bash 'true' extra >/dev/null 2>&1
check "prefix run rejects extra command operands" "2" "$?"

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

settings="$work/settings.json"
mkdir -p "$work/tool dir"
renamed_sumi="$work/tool dir/renamed-tool"
cp "$sumi" "$renamed_sumi"
chmod 755 "$renamed_sumi"
mkdir -p "$work/secret dir"
init_secrets="$work/secret dir/list file"
cp "$work/secrets.txt" "$init_secrets"
chmod 600 "$init_secrets"
jq -n '{
  permissions:{allow:["Bash(cat:*)"],deny:["Bash(git:*)"]},
  env:{KEEP:"yes"},
  hooks:{
    PreToolUse:[{matcher:"Bash",custom:"keep-group",hooks:[
      {type:"command",command:"/bin/foreign-hook"}
    ]}],
    PostToolUse:[{matcher:"foreign",hooks:[
      {type:"command",command:"/bin/foreign-post"}
    ]}]
  }
}' > "$settings"
"$renamed_sumi" init --agent claude --secrets-file "$init_secrets" --settings "$settings" --shell /bin/bash --root "$work/attach" --root "$work/other" --deny-path app.properties >/dev/null 2>"$work/init.err"
check "init succeeds" "0" "$?"
check "init installs exactly three own exec-form hooks" "3" "$(jq --arg exe "$renamed_sumi" '[.hooks[][]?.hooks[]? | select(.type == "command" and .command == $exe and (.args[0:3] == ["hook","--agent","claude"]))] | length' "$settings")"
check "init preserves foreign PreToolUse" "/bin/foreign-hook" "$(jq -r '.hooks.PreToolUse[]?.hooks[]? | select(.command == "/bin/foreign-hook") | .command' "$settings")"
check "init preserves foreign group metadata" "keep-group" "$(jq -r '.hooks.PreToolUse[]? | select(.hooks[]?.command == "/bin/foreign-hook") | .custom' "$settings")"
check "init preserves permissions" '{"allow":["Bash(cat:*)"],"deny":["Bash(git:*)"]}' "$(jq -c '.permissions' "$settings")"
check "init preserves unrelated environment" "yes" "$(jq -r '.env.KEEP' "$settings")"
check "init stores the selected shell for Claude" "$(readlink -f /bin/bash)" "$(jq -r '.env.CLAUDE_CODE_SHELL' "$settings")"
expected_prefix="$(readlink -f /bin/bash) -c 'exec \"\$@\"' 'sumi-prefix' '$renamed_sumi' 'run' '--secrets-file' '$init_secrets' '--shell' '$(readlink -f /bin/bash)'"
check "init encodes the prefix for Claude's executable split" "$expected_prefix" "$(jq -r '.env.CLAUDE_CODE_SHELL_PREFIX' "$settings")"
check "installed hooks carry the absolute secrets path" "3" "$(jq --arg exe "$renamed_sumi" --arg secrets "$init_secrets" '[.hooks[][]?.hooks[]? | select(.command == $exe and (.args[-2:] == ["--secrets-file",$secrets]) or (.command == $exe and (.args | index("--secrets-file")) != null and (.args[(.args | index("--secrets-file")) + 1] == $secrets)))] | length' "$settings")"
check "installed prompt keeps repeated roots and deny paths" '["hook","--agent","claude","prompt","--secrets-file","'"$init_secrets"'","--root","'"$work/attach"'","--root","'"$work/other"'","--deny-path","app.properties"]' "$(jq -c --arg exe "$renamed_sumi" '.hooks.UserPromptSubmit[]?.hooks[]? | select(.command == $exe) | .args' "$settings")"

"$renamed_sumi" init --agent claude --secrets-file "$init_secrets" --settings "$settings" --shell /bin/bash --root "$work/attach" --root "$work/other" --deny-path app.properties >/dev/null 2>"$work/reinit.err"
check "repeated init succeeds" "0" "$?"
check "repeated init remains exactly three own hooks" "3" "$(jq --arg exe "$renamed_sumi" '[.hooks[][]?.hooks[]? | select(.command == $exe)] | length' "$settings")"

token_settings="$work/token-settings.json"
"$renamed_sumi" init --agent claude --secrets-file "$work/token.txt" --settings "$token_settings" --shell /bin/bash >/dev/null 2>"$work/token-init.err"
check "init self-check accepts a JSON structural-looking secret" "0" "$?"
mapfile -d '' -t hook_argv < <(jq -j '.hooks.PostToolUse[0].hooks[0] | .command, "\u0000", (.args[] | ., "\u0000")' "$token_settings")
out="$(printf '%s' '{"hook_event_name":"PostToolUse","tool_response":{"ok":true,"s":"true"}}' | "${hook_argv[@]}" | delivered)"
check "actual installed exec hook preserves structural JSON" '{"ok":true,"s":"****"}' "$out"

allstars_settings="$work/allstars-settings.json"
printf '*****\n' > "$work/allstars.txt"
"$renamed_sumi" init --agent claude --secrets-file "$work/allstars.txt" --settings "$allstars_settings" --shell /bin/bash >/dev/null 2>"$work/allstars-init.err"
check "init self-check keeps all-stars malformed negative probe" "0" "$?"

split_dir="$work/prefix - path's"
mkdir -p "$split_dir"
split_sumi="$split_dir/renamed-tool"
split_secrets="$split_dir/secret - list"
split_settings="$split_dir/settings.json"
cp "$sumi" "$split_sumi"
chmod 755 "$split_sumi"
cp "$work/secrets.txt" "$split_secrets"
chmod 600 "$split_secrets"
"$split_sumi" init --agent claude --secrets-file "$split_secrets" --settings "$split_settings" --shell /bin/bash >/dev/null 2>"$work/split-init.err"
check "init self-check executes a prefix with delimiter-like path bytes" "0" "$?"
split_prefix="$(jq -r '.env.CLAUDE_CODE_SHELL_PREFIX' "$split_settings")"
split_tail="${split_prefix##* -}"
case "$split_tail" in
  c\ *) check "the intended -c remains Claude's final prefix delimiter" "ok" "ok" ;;
  *) check "the intended -c remains Claude's final prefix delimiter" "c ..." "$split_tail" ;;
esac

conflict_settings="$work/conflict-settings.json"
printf '%s' '{"env":{"KEEP":"yes","CLAUDE_CODE_SHELL_PREFIX":"foreign-wrapper"}}' > "$conflict_settings"
conflict_before="$(sha256sum "$conflict_settings" | cut -d ' ' -f1)"
"$renamed_sumi" init --agent claude --secrets-file "$work/secrets.txt" --settings "$conflict_settings" --shell /bin/bash >/dev/null 2>"$work/conflict.err"
check "init rejects a foreign shell prefix" "1" "$?"
check "foreign prefix failure leaves settings unchanged" "$conflict_before" "$(sha256sum "$conflict_settings" | cut -d ' ' -f1)"
check "foreign prefix failure happens before backup" "0" "$(find "$work" -maxdepth 1 -name 'conflict-settings.json.bak.*' | wc -l | tr -d ' ')"

bad_env_settings="$work/bad-env-settings.json"
printf '%s' '{"env":[],"permissions":{"allow":["Bash(cat:*)"]}}' > "$bad_env_settings"
bad_env_before="$(sha256sum "$bad_env_settings" | cut -d ' ' -f1)"
"$renamed_sumi" init --agent claude --secrets-file "$work/secrets.txt" --settings "$bad_env_settings" --shell /bin/bash >/dev/null 2>"$work/bad-env.err"
check "init rejects a non-object env" "1" "$?"
check "bad env failure leaves settings unchanged" "$bad_env_before" "$(sha256sum "$bad_env_settings" | cut -d ' ' -f1)"
check "bad env failure happens before backup" "0" "$(find "$work" -maxdepth 1 -name 'bad-env-settings.json.bak.*' | wc -l | tr -d ' ')"

bad_shell_settings="$work/bad-shell-settings.json"
printf '%s' '{"permissions":{"allow":["Bash(cat:*)"]}}' > "$bad_shell_settings"
bad_shell_before="$(sha256sum "$bad_shell_settings" | cut -d ' ' -f1)"
"$renamed_sumi" init --agent claude --secrets-file "$work/secrets.txt" --settings "$bad_shell_settings" --shell /bin/sh >/dev/null 2>"$work/bad-shell.err"
check "init rejects unsupported Claude shells" "1" "$?"
check "unsupported shell failure leaves settings unchanged" "$bad_shell_before" "$(sha256sum "$bad_shell_settings" | cut -d ' ' -f1)"
check "unsupported shell failure happens before backup" "0" "$(find "$work" -maxdepth 1 -name 'bad-shell-settings.json.bak.*' | wc -l | tr -d ' ')"

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
