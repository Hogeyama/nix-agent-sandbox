#!/usr/bin/env bash
# Exercise the built sumi binary against decoy values. Never touches a real
# repository; needs bash, jq and Python 3.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sumi="${SUMI_BIN:-$script_dir/../zig-out/bin/sumi}"
[ -x "$sumi" ] || { echo "sumi not found at $sumi; run 'zig build' in contrib/sumi first" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

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
printf 'nothing of interest\n' > "$work/attach/clean"
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
check "missing long-extension attachment is rejected" "block" "$(attach 'see @gone.properties')"
check "missing extensionless attachment is rejected" "block" "$(attach 'see @Override')"
check "missing short-extension attachment is rejected" "block" "$(attach 'see @gone.txt')"
check "existing clean extensionless attachment is allowed" "" "$(attach 'see @clean')"
check "a code-form annotation mention is allowed" "" "$(attach 'add `@Override` to it')"
check "a mail address is not an attachment" "" "$(attach 'write to user@example.com')"
check "a missing version-like attachment is rejected" "block" "$(attach 'cut @v1.2.3')"
check "a missing agent-like attachment is rejected" "block" "$(attach 'ask @agent-general-purpose')"
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

# /bin/sh may resolve to supported bash; use an explicitly unsupported name.
bad_shell="$work/unsupported-shell"
printf '#!/bin/sh\nexit 0\n' > "$bad_shell"
chmod +x "$bad_shell"
bad_shell_settings="$work/bad-shell-settings.json"
printf '%s' '{"permissions":{"allow":["Bash(cat:*)"]}}' > "$bad_shell_settings"
bad_shell_before="$(sha256sum "$bad_shell_settings" | cut -d ' ' -f1)"
"$renamed_sumi" init --agent claude --secrets-file "$work/secrets.txt" --settings "$bad_shell_settings" --shell "$bad_shell" >/dev/null 2>"$work/bad-shell.err"
check "init rejects unsupported Claude shells" "1" "$?"
check "unsupported shell failure leaves settings unchanged" "$bad_shell_before" "$(sha256sum "$bad_shell_settings" | cut -d ' ' -f1)"
check "unsupported shell failure happens before backup" "0" "$(find "$work" -maxdepth 1 -name 'bad-shell-settings.json.bak.*' | wc -l | tr -d ' ')"

# --- scan --------------------------------------------------------------------

proj="$work/scan-project"
mkdir -p "$proj/config" "$proj/.git" "$proj/sub/deep"
printf 'db.password=%s\n' "$current" > "$proj/config/app.properties"
printf 'nothing of interest\n' > "$proj/README.md"
printf '%s' "$current" > "$proj/.git/packed-leak"
printf 'encoded=%s\n' "$(printf '%s' "$current" | base64)" > "$proj/sub/deep/encoded.env"
ln -s ../config/app.properties "$proj/sub/link"
cp "$work/secrets.txt" "$proj/listed-secrets.txt"
scan_settings="$work/scan-settings.json"
scan_record="$work/scan-settings.sumi-scan.json"
scan() { "$sumi" scan --agent claude --secrets-file "$proj/listed-secrets.txt" --root "$proj" --settings "$scan_settings" "$@" >"$work/scan.out" 2>"$work/scan.err"; }
paths() { jq -c '[.sandbox.credentials.files[].path]' "$scan_settings"; }
scan
check "scan succeeds" "0" "$?"
check "scan selects absolute regular files and excludes git, links, secrets" "[\"$proj/config/app.properties\",\"$proj/sub/deep/encoded.env\"]" "$(paths)"
check "scan records ownership" "$(paths)" "$(jq -c .credentialsFiles "$scan_record")"
check "scan creates exact extracted mask fields" 'true' "$(jq 'all(.sandbox.credentials.files[]; .mode == "mask" and (.extract | startswith("(?:^|\\n)")) and .maskDuplicates == true and .injectHosts == [] and .onExtractNoMatch == "deny" and (keys | length) == 6)' "$scan_settings")"
check "scan creates neither filesystem nor permissions" '[null,null]' "$(jq -c '[.sandbox.filesystem,.permissions]' "$scan_settings")"
check "scan reports counts" "1" "$(grep -c '2 masked, 0 unmasked, 0 skipped in ' "$work/scan.err")"
check "scan warns on empty injectHosts" "2" "$(grep -c 'empty injectHosts' "$work/scan.err")"
check "scan explains excluded secrets file" "1" "$(grep -c 'secrets file is inside the root' "$work/scan.err")"
check "scan sends results only to stderr" "0" "$(wc -c < "$work/scan.out" | tr -d ' ')"
for output in "$scan_settings" "$scan_record" "$work/scan.err"; do
  check "scan output excludes raw decoys: $(basename "$output")" "no" "$(leaks "$(cat "$output")")"
done
for decoy in "$current" "$retired"; do
  encoded_decoy="$(printf '%s' "$decoy" | base64)"
  for output in "$scan_settings" "$scan_record" "$work/scan.err"; do
    check "scan output excludes base64 decoys: $(basename "$output")" "0" "$(grep -Fc "$encoded_decoy" "$output")"
  done
done

# Both file mtimes and backup names remain unchanged on a no-op, even with
# noncanonical original whitespace; compare metadata rather than sleeping.
jq -c . "$scan_settings" > "$work/edited.json"
cp "$work/edited.json" "$scan_settings"
jq -c . "$scan_record" > "$work/edited.json"
cp "$work/edited.json" "$scan_record"
touch -t 202001010000 "$scan_settings" "$scan_record"
scan_before="$(stat -c '%Y' "$scan_settings" "$scan_record")"
scan
check "unchanged scan succeeds" "0" "$?"
check "unchanged scan writes neither output" "$scan_before" "$(stat -c '%Y' "$scan_settings" "$scan_record")"
check "unchanged scan writes no backup" "0" "$(find "$work" -maxdepth 1 -name 'scan-settings.json.bak.*' | wc -l | tr -d ' ')"

jq '.theme="dark" | .sandbox.enabled=true | .sandbox.credentials.files[0] += {mode:"deny",maskDuplicates:false,injectHosts:["api.example.test"],custom:7} | .extra=true' "$scan_settings" > "$work/edited.json"
cp "$work/edited.json" "$scan_settings"
jq '.custom="keep"' "$scan_record" > "$work/edited.json"
cp "$work/edited.json" "$scan_record"
rm "$proj/sub/deep/encoded.env"
scan
check "rescan updates owned entry and deletes disappeared file" "0" "$?"
check "rescan retains user metadata and repairs fixed fields" '["dark",true,"mask",true,["api.example.test"],7]' "$(jq -c '[.theme,.sandbox.enabled,.sandbox.credentials.files[0].mode,.sandbox.credentials.files[0].maskDuplicates,.sandbox.credentials.files[0].injectHosts,.sandbox.credentials.files[0].custom]' "$scan_settings")"
check "rescan retains record metadata" "keep" "$(jq -r .custom "$scan_record")"
check "configured injectHosts suppress empty warning" "0" "$(grep -c 'empty injectHosts' "$work/scan.err")"
check "enabled sandbox suppresses enabled note" "0" "$(grep -c 'sandbox.enabled' "$work/scan.err")"
check "backup is private" "600" "$(stat -c '%a' "$scan_settings".bak.*)"

printf '%s\n' "$current" > "$proj/config/app.properties"
scan
check "extracted to whole-file succeeds" "0" "$?"
check "whole-file removes extract and maskDuplicates" '[false,false,["api.example.test"]]' "$(jq -c '.sandbox.credentials.files[0] | [has("extract"),has("maskDuplicates"),.injectHosts]' "$scan_settings")"
jq 'del(.sandbox.credentials.files[0].injectHosts)' "$scan_settings" > "$work/edited.json"
cp "$work/edited.json" "$scan_settings"
printf 'new.token=%s\n' "$current" > "$proj/config/app.properties"
scan
check "whole-file to extracted succeeds" "0" "$?"
check "regeneration keeps absent injectHosts absent" '[true,true,false]' "$(jq -c '.sandbox.credentials.files[0] | [has("extract"),.maskDuplicates,has("injectHosts")]' "$scan_settings")"
printf '# %s\n' "$current" > "$proj/config/app.properties"
scan
check "non-generatable owned file fails" "1" "$?"
check "non-generatable owned file removes settings and ownership" '[0,0]' "$(jq -nc --argjson a "$(jq '.sandbox.credentials.files|length' "$scan_settings")" --argjson b "$(jq '.credentialsFiles|length' "$scan_record")" '[$a,$b]')"
check "unsafe old mask removal is explicit" "1" "$(grep -c 'unmask .*: was masked, now no-form' "$work/scan.err")"
scan
check "new non-generatable file is a successful skip" "0" "$?"
check "no-form reason" "1" "$(grep -c ': no-form' "$work/scan.err")"

printf '%s' "$current" > "$proj/glob*name"
printf '\377%s' "$current" > "$proj/invalid.bin"
python3 - "$proj/large" "$current" <<'PY'
import sys
with open(sys.argv[1], 'wb') as f:
    f.write(('token='+sys.argv[2]+'\n').encode())
    f.truncate(8*1024*1024+1)
PY
printf 'foo=ab%sab\n# %s\n' "$current" "$current" > "$proj/coverage"
scan
check "new skipped files do not force failure" "0" "$?"
for reason in glob-chars too-large not-utf8 coverage; do
  check "skip reason $reason" "1" "$(grep -c ": $reason" "$work/scan.err")"
done
rm "$proj/glob*name" "$proj/invalid.bin" "$proj/large" "$proj/coverage"

# A user entry, duplicate entries and exact denyRead entries take precedence,
# including when the corresponding owned file has disappeared.
printf 'token=%s\n' "$current" > "$proj/user"
jq -n --arg p "$proj" '{sandbox:{credentials:{files:[{path:($p+"/user"),custom:1},{path:($p+"/dup")},{path:($p+"/dup")},{path:($p+"/deny")}]},filesystem:{denyRead:[($p+"/deny")]}}}' > "$scan_settings"
jq -n --arg p "$proj" '{credentialsFiles:[($p+"/dup"),($p+"/deny")]}' > "$scan_record"
scan
check "conflicting entries are skipped without failure" "0" "$?"
check "user and duplicate entry conflicts are reported" "2" "$(grep -c ': existing-entry' "$work/scan.err")"
check "denyRead conflict precedes deletion" "1" "$(grep -c ': denyread-conflict' "$work/scan.err")"
check "conflicts retain entries" "4" "$(jq '.sandbox.credentials.files|length' "$scan_settings")"
check "user entry is never claimed" "false" "$(jq --arg p "$proj/user" '.credentialsFiles|index($p)!=null' "$scan_record")"

# Exclusions, dangling symlink ancestors, and other roots preserve ownership.
mkdir -p "$work/scan-project-other"
ln -s "$work/missing-target" "$proj/dangling"
jq -n --arg p "$proj" '{credentialsFiles:[($p+"/.git/old"),($p+"/listed-secrets.txt"),($p+"/sub/link"),($p+"/dangling/old"),($p+"-other/old")]}' > "$scan_record"
jq '{sandbox:{credentials:{files:[.credentialsFiles[]|{path:.,mode:"mask"}]}}}' "$scan_record" > "$scan_settings"
scan
check "excluded and outside paths survive" "0" "$?"
check "excluded and outside paths retain ownership" "6" "$(jq '.credentialsFiles|length' "$scan_record")"
check "excluded and outside entries survive" "6" "$(jq '.sandbox.credentials.files|length' "$scan_settings")"

if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$proj/locked-dir"
  printf 'token=%s\n' "$current" > "$proj/locked-dir/owned"
  printf 'token=%s\n' "$current" > "$proj/locked-file"
  scan
  check "readable files initially become owned" "0" "$?"
  chmod 000 "$proj/locked-dir" "$proj/locked-file"
  scan
  locked_status=$?
  chmod 700 "$proj/locked-dir"
  chmod 600 "$proj/locked-file"
  check "unreadable files and directories fail" "1" "$locked_status"
  check "unreadable files and directories remain owned" "2" "$(jq --arg p "$proj" '[.credentialsFiles[]|select(. == ($p+"/locked-file") or . == ($p+"/locked-dir/owned"))]|length' "$scan_record")"
else
  printf 'SKIP unreadability fixtures: root bypasses filesystem permission bits\n'
fi

# A readable but non-writable record forces failure after settings are written.
# Compare the restored settings bytes and preserve original record bytes too.
if [ "$(id -u)" -ne 0 ]; then
  rollback_root="$work/rollback-root"
  mkdir -p "$rollback_root"
  printf 'token=%s\n' "$current" > "$rollback_root/owned"
  rollback_settings="$work/rollback.json"
  rollback_record="$work/rollback.sumi-scan.json"
  "$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --root "$rollback_root" --settings "$rollback_settings" >/dev/null 2>"$work/rollback.err"
  check "rollback fixture registers mask" "0" "$?"
  cp "$rollback_settings" "$work/rollback-before.json"
  cp "$rollback_record" "$work/rollback-record-before.json"
  rm "$rollback_root/owned"
  chmod 400 "$rollback_record"
  "$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --root "$rollback_root" --settings "$rollback_settings" >/dev/null 2>"$work/rollback.err"
  rollback_status=$?
  chmod 600 "$rollback_record"
  check "record write failure exits 1" "1" "$rollback_status"
  check "record write failure restores original settings bytes" "yes" "$(cmp -s "$rollback_settings" "$work/rollback-before.json" && echo yes || echo no)"
  check "failed record write keeps original record bytes" "yes" "$(cmp -s "$rollback_record" "$work/rollback-record-before.json" && echo yes || echo no)"
  check "record write failure reports rollback" "1" "$(grep -c 'settings restored' "$work/rollback.err")"
else
  printf 'SKIP readonly record rollback fixture: root bypasses filesystem permission bits\n'
fi

# Default paths never address the real user's configuration.
CLAUDE_CONFIG_DIR="$work/default-config" "$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --root "$proj" >/dev/null 2>"$work/default.err"
check "scan defaults to CLAUDE_CONFIG_DIR" "0" "$?"
check "default settings were created" "yes" "$([ -f "$work/default-config/settings.json" ] && echo yes || echo no)"
env -u CLAUDE_CONFIG_DIR HOME="$work/fake-home" "$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --root "$proj" >/dev/null 2>"$work/default.err"
check "scan defaults to HOME .claude" "0" "$?"
check "home settings were created" "yes" "$([ -f "$work/fake-home/.claude/settings.json" ] && echo yes || echo no)"
mkdir -p "$work/project/.claude"
ln -s "$work/project/.claude" "$work/claude-alias"
ln -s "$work/project" "$work/project-alias"
for rejected in "$work/project/.claude/settings.json" "$work/claude-alias/settings.json" "$work/project-alias/new/.claude/settings.json"; do
  "$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --root "$proj" --settings "$rejected" >/dev/null 2>"$work/reject.err"
  check "reject project settings $rejected" "1" "$?"
  check "rejected settings are not written" "no" "$([ -e "$rejected" ] && echo yes || echo no)"
done

for invalid in '[]' '{"sandbox":[]}' '{"sandbox":{"credentials":false}}' '{"sandbox":{"filesystem":[]}}' '{"sandbox":{"credentials":{"files":{}}}}' '{"sandbox":{"credentials":{"files":[{}]}}}' '{"sandbox":{"filesystem":{"denyRead":[1]}}}'; do
  printf '%s' "$invalid" > "$work/invalid-settings.json"
  "$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --root "$proj" --settings "$work/invalid-settings.json" >/dev/null 2>"$work/invalid.err"
  check "invalid settings shape fails: $invalid" "1" "$?"
  check "invalid settings stay byte-identical" "$invalid" "$(cat "$work/invalid-settings.json")"
done
for invalid in '[]' '{}' '{"denyRead":[]}' '{"credentialsFiles":["./relative"]}' '{"credentialsFiles":[1]}'; do
  printf '{}' > "$work/invalid-settings.json"
  printf '%s' "$invalid" > "$work/invalid-settings.sumi-scan.json"
  "$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --root "$proj" --settings "$work/invalid-settings.json" >/dev/null 2>"$work/invalid.err"
  check "invalid ownership fails: $invalid" "1" "$?"
  check "invalid ownership leaves settings untouched" '{}' "$(cat "$work/invalid-settings.json")"
done
"$sumi" scan --agent claude --secrets-file "$work/missing.txt" --root "$proj" --settings "$work/unused.json" >/dev/null 2>&1
check "scan with missing secrets exits 1" "1" "$?"
"$sumi" scan --agent claude --secrets-file "$work/secrets.txt" --deny-path x >/dev/null 2>&1
check "scan rejects unknown options" "2" "$?"

# Path strings are output too: refuse incompatible inputs before any writes.
python3 - "$sumi" "$work/path-validation" <<'PY_PATHS'
import base64
import os
import json
from pathlib import Path
import subprocess
import sys

binary, base = sys.argv[1], Path(sys.argv[2])
raw = "DecoyFilenameToken9"
encoded = base64.b64encode(raw.encode()).decode()

def snapshot(folder):
    return {str(p.relative_to(folder)): (p.read_bytes() if p.is_file() else None, p.stat().st_mtime_ns)
            for p in folder.rglob("*")}

def refusal(case, pattern, kind, existing=True):
    folder = base / case
    root = folder / "project"
    root.mkdir(parents=True)
    listed = folder / "secrets.txt"
    listed.write_text(raw + "\n")
    settings = folder / "settings.json"
    record = folder / "settings.sumi-scan.json"
    (root / "safe.env").write_text("password=" + raw)
    target = root / pattern
    settings_data = {"custom": "preserve"}
    record_data = {"credentialsFiles": [], "custom": "preserve"}
    if kind in ("new", "skip", "conflict", "unreadable-file"):
        target.write_text(raw if kind == "new" else "password=" + raw)
        if kind == "skip":
            target.write_text("unrecognized " + raw)
    if kind == "unreadable-dir":
        target.mkdir()
    if kind in ("old-owned", "conflict", "note", "carried-entry", "carried-record"):
        if kind in ("note", "carried-entry", "carried-record"):
            target = folder / pattern
        entry = {"path": str(target), "mode": "deny"}
        if kind == "note":
            entry.update(mode="mask", injectHosts=[])
        if kind != "carried-record":
            settings_data["sandbox"] = {"credentials": {"files": [entry]}}
        if kind == "note":
            (root / "safe.env").unlink()
        if kind in ("old-owned", "carried-record"):
            record_data["credentialsFiles"] = [str(target)]
    if kind == "settings":
        settings = folder / (pattern + ".json")
        record = folder / (pattern + ".sumi-scan.json")
    if kind == "sidecar":
        listed.write_text(".sumi-scan.json\n")
        (root / "safe.env").write_text("password=.sumi-scan.json")
    if existing:
        settings.write_text(json.dumps(settings_data) + "\n \n")
        record.write_text(json.dumps(record_data) + "\n \n")
        settings.with_name(settings.name + ".bak.existing").write_bytes(b"previous backup\n")
    before = snapshot(folder)
    locked = kind in ("unreadable-file", "unreadable-dir")
    if locked:
        target.chmod(0)
    try:
        result = subprocess.run([binary, "scan", "--agent", "claude",
            "--secrets-file", str(listed), "--root", str(root),
            "--settings", str(settings)], capture_output=True)
    finally:
        if locked:
            target.chmod(0o700 if kind == "unreadable-dir" else 0o600)
    assert result.returncode == 1, (case, "expected validation failure", result.returncode)
    assert result.stdout == b"", (case, "unexpected stdout")
    assert result.stderr == b"sumi: an output path contains a secret pattern; scan cancelled\n", (case, "unexpected diagnostic", result.stderr)
    assert snapshot(folder) == before, (case, "files changed or were created")

count = 0
for label, pattern in (("raw", raw), ("expanded", encoded)):
    for kind in ("new", "skip", "conflict", "old-owned", "note", "carried-entry", "carried-record", "settings", "unreadable-file", "unreadable-dir"):
        if kind.startswith("unreadable") and os.geteuid() == 0:
            print("SKIP path validation permission fixture under root")
            continue
        refusal(label + "-" + kind, pattern, kind)
        count += 1
    refusal(label + "-new-outputs", pattern, "new", existing=False)
    count += 1
refusal("sidecar", raw, "sidecar")
count += 1

# Existing unrelated values must survive. Unreported paths in an unchanged
# output are also compatible; do not broaden the refusal into a JSON scrubber.
for kind in ("user-metadata", "unchanged-paths", "backup"):
    folder = base / kind
    root = folder / "project"
    root.mkdir(parents=True)
    listed = folder / "secrets.txt"
    token = ".bak." if kind == "backup" else raw
    listed.write_text(token + "\n")
    settings = folder / "settings.json"
    record = folder / "settings.sumi-scan.json"
    settings_data = {"custom": raw}
    record_data = {"credentialsFiles": [], "custom": raw}
    if kind == "unchanged-paths":
        path = str(folder / raw)
        settings_data["sandbox"] = {"credentials": {"files": [{"path": path, "mode": "deny"}]}}
        record_data["credentialsFiles"] = [path]
        (root / raw).write_text("clean content")
    else:
        (root / "safe.env").write_text("password=" + token)
    settings.write_text(json.dumps(settings_data) + "\n \n")
    record.write_text(json.dumps(record_data) + "\n \n")
    before = snapshot(folder)
    result = subprocess.run([binary, "scan", "--agent", "claude",
        "--secrets-file", str(listed), "--root", str(root),
        "--settings", str(settings)], capture_output=True)
    assert result.returncode == 0, (kind, result.stderr)
    assert token.encode() not in result.stdout + result.stderr, kind
    assert json.loads(settings.read_text())["custom"] == raw, kind
    assert json.loads(record.read_text())["custom"] == raw, kind
    if kind == "unchanged-paths":
        assert snapshot(folder) == before, "unreported existing paths must not force writes"
    if kind == "backup":
        backups = list(folder.glob("settings.json.bak.*"))
        assert len(backups) == 1, "backup must still be created"
        assert backups[0].read_bytes() == before["settings.json"][0]
        assert backups[0].stat().st_mode & 0o777 == 0o600
        assert b"sumi: settings backup created\n" in result.stderr
    count += 1
print(f"{count} path validation fixtures passed")
PY_PATHS
check "scan rejects secret-bearing output paths without writes" "0" "$?"

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

SUMI_BIN="$sumi" python3 "$script_dir/encoded-values.py"
check "encoded-value regressions" "0" "$?"

if command -v bun >/dev/null; then
  (cd "$script_dir/.." && bun tests/extract-parity.ts)
  check "Zig to JavaScript extraction parity" "0" "$?"
else
  printf 'SKIP extraction parity: Bun is unavailable\n'
fi

printf '\npassed %d, failed %d\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
