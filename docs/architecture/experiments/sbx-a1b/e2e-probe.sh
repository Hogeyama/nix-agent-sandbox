#!/bin/bash
# Runs inside an sbx sandbox built from the proposed 系統5 configuration. The
# argument is the private repo that configuration allows.
R=${1:?usage: e2e-probe.sh OWNER/PRIVATE-REPO}
FAKE_GH='Authorization: Bearer nas-a1b-invalid'
FAKE_ANT='x-api-key: sk-ant-api03-nas-a1b-invalid'

c() {
  local l=$1; shift
  local out code body
  out=$(curl -sS --max-time 20 -w '\n%{http_code} rc=%{exitcode}' "$@" 2>&1)
  code=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d' | tr -d '\n\0' | cut -c1-80)
  printf '%-40s %-12s %s\n' "$l" "$code" "$body"
}

echo "## allowed"
c "api GET /repos/R fake token"        -H "$FAKE_GH" "https://api.github.com/repos/$R"
c "graphql viewer fake token"          -H "$FAKE_GH" -X POST -d '{"query":"{viewer{login}}"}' https://api.github.com/graphql
c "anthropic /v1/models fake key"      -H "$FAKE_ANT" -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models
echo "## refused by path"
c "api GET /repos/cli/cli"             https://api.github.com/repos/cli/cli
c "api POST /gists"                    -X POST -d '{}' https://api.github.com/gists
c "github.com web /"                   https://github.com/
echo "## direct path"
c "noproxy api.github.com"             --noproxy '*' -H "$FAKE_GH" "https://api.github.com/repos/$R"
c "noproxy github.com"                 --noproxy '*' https://github.com/
c "noproxy api.anthropic.com"          --noproxy '*' -H "$FAKE_ANT" https://api.anthropic.com/v1/models
echo "## kit hosts denied"
for h in platform.claude.com downloads.claude.ai claude.com code.claude.com mcp-proxy.anthropic.com bridge.claudeusercontent.com; do
  c "$h"                               -o /dev/null "https://$h/"
  c "$h (noproxy)"                     --noproxy '*' -o /dev/null "https://$h/"
done
echo "## git"
cd "$(mktemp -d)"
g() { local l=$1; shift; printf '%-40s ' "$l"; out=$(timeout 60 "$@" 2>&1); rc=$?; printf 'rc=%s %s\n' "$rc" "$(printf '%s' "$out" | tail -1 | cut -c1-90)"; }
g "clone R.git"                        git clone -q "https://github.com/$R.git" r
g "clone cli/cli"                      git clone -q --depth 1 https://github.com/cli/cli.git o
g "ls-remote R fake creds"             git ls-remote "https://nas:nas-a1b-invalid@github.com/$R.git" refs/heads/main
g "push --dry-run R"                   git -C r push --dry-run origin HEAD:refs/heads/probe2
