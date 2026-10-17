#!/bin/bash
# Runs inside the sbx sandbox. The argument is a private repo that the injected
# token can read, so 200 means the host credential was used; a fake credential
# that reached GitHub gives 401/404.
R=${1:?usage: l7-auth-probe.sh OWNER/PRIVATE-REPO}
U="https://api.github.com/repos/$R"

c() {
  local l=$1; shift
  local out code body
  out=$(curl -sS --max-time 20 -w '\n%{http_code} rc=%{exitcode}' "$@" 2>&1)
  code=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d' | tr -d '\n\0' | grep -oE '"(full_name|message)": *"[^"]*"' | head -1)
  [ -z "$body" ] && body=$(printf '%s' "$out" | sed '$d' | tr -d '\n\0' | cut -c1-80)
  printf '%-46s %-12s %s\n' "$l" "$code" "$body"
}

echo "## api.github.com credential carriers (proxy)"
c "no auth"                         "$U"
c "Bearer fake"                     -H 'Authorization: Bearer nas-a1b-invalid' "$U"
c "token fake"                      -H 'Authorization: token nas-a1b-invalid' "$U"
c "Basic fake (-u)"                 -u nas:nas-a1b-invalid "$U"
c "two Authorization (case)"        -H 'Authorization: Bearer nas-a1b-invalid' -H 'authorization: Bearer nas-a1b-invalid2' "$U"
c "lowercase header name"           -H 'authorization: Bearer nas-a1b-invalid' "$U"
c "query access_token"              "$U?access_token=nas-a1b-invalid"
c "Cookie user_session"             -H 'Cookie: user_session=nas-a1b-invalid' "$U"
c "HTTP/1.0 Bearer fake"            --http1.0 -H 'Authorization: Bearer nas-a1b-invalid' "$U"
c "HTTP/2 Bearer fake"              --http2 -H 'Authorization: Bearer nas-a1b-invalid' "$U"
c "graphql Bearer fake viewer"      -H 'Authorization: Bearer nas-a1b-invalid' -X POST -d '{"query":"{viewer{login}}"}' https://api.github.com/graphql

echo "## github.com"
c "web GET / (no rule)"             https://github.com/
c "web POST gist form path"         -X POST -H 'Cookie: user_session=nas-a1b-invalid' https://github.com/gists
c "info/refs Bearer fake"           -H 'Authorization: Bearer nas-a1b-invalid' "https://github.com/$R.git/info/refs?service=git-upload-pack"
c "info/refs Basic fake"            -u nas:nas-a1b-invalid "https://github.com/$R.git/info/refs?service=git-upload-pack"
c "info/refs receive-pack Basic fake" -u nas:nas-a1b-invalid "https://github.com/$R.git/info/refs?service=git-receive-pack"
