#!/bin/bash
# Runs inside the sbx sandbox. The argument is a private repo that the injected
# token can read. Prints one line per probe: label, HTTP status / curl rc, body head.
R=${1:?usage: l7-probe.sh OWNER/PRIVATE-REPO}
FAKE='Authorization: Bearer nas-a1b-invalid'

c() { # label, curl args...
  local l=$1; shift
  local out code body
  out=$(curl -sS --max-time 20 -w '\n%{http_code} rc=%{exitcode}' "$@" 2>&1)
  code=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d' | tr -d '\n\0' | cut -c1-90)
  printf '%-44s %-12s %s\n' "$l" "$code" "$body"
}

echo "## REST via proxy"
c "GET /repos/R (fake token)"            -H "$FAKE" "https://api.github.com/repos/$R"
c "GET /repos/R/contents/README.md"      -H "$FAKE" "https://api.github.com/repos/$R/contents/README.md"
c "GET /repos/cli/cli"                    "https://api.github.com/repos/cli/cli"
c "GET /user"                             "https://api.github.com/user"
c "POST /user/repos"                      -X POST -d '{}' "https://api.github.com/user/repos"
c "POST /gists"                           -X POST -d '{}' "https://api.github.com/gists"
c "POST /repos/cli/cli/issues"            -X POST -d '{}' "https://api.github.com/repos/cli/cli/issues"

echo "## path tricks via proxy"
c "R/../../cli/cli (path-as-is)"          --path-as-is "https://api.github.com/repos/$R/../../cli/cli"
c "R/%2e%2e/%2e%2e/cli/cli"               --path-as-is "https://api.github.com/repos/$R/%2e%2e/%2e%2e/cli/cli"
c "R/..%2f..%2fcli%2fcli"                 --path-as-is "https://api.github.com/repos/$R/..%2f..%2fcli%2fcli"
c "//repos/cli/cli"                       --path-as-is "https://api.github.com//repos/cli/cli"
c "/REPOS/cli/cli"                        "https://api.github.com/REPOS/cli/cli"
c "/repos/hogeyama/SBX-A1B-PROBE (case)"  "https://api.github.com/repos/hogeyama/SBX-A1B-PROBE"
c "/repos/R;x/../../cli/cli"              --path-as-is "https://api.github.com/repos/$R;x/../../cli/cli"
c "Host header swap to uploads"           -H 'Host: uploads.github.com' "https://api.github.com/repos/$R"

echo "## GraphQL via proxy (body selects target)"
c "graphql query cli/cli"                 -X POST -d '{"query":"{repository(owner:\"cli\",name:\"cli\"){nameWithOwner}}"}' "https://api.github.com/graphql"
c "graphql viewer"                        -X POST -d '{"query":"{viewer{login}}"}' "https://api.github.com/graphql"

echo "## direct / other ports"
c "noproxy api GET /repos/R"              --noproxy '*' -H "$FAKE" "https://api.github.com/repos/$R"
c "noproxy github.com"                    --noproxy '*' "https://github.com/"
c "noproxy http api.github.com:80"        --noproxy '*' "http://api.github.com/"
c "proxy http api.github.com:80"          "http://api.github.com/"
printf '%-44s ' "tcp github.com:22 banner"
timeout 8 bash -c 'exec 3<>/dev/tcp/github.com/22; head -c 40 <&3' 2>&1 | tr -d '\r\n'; echo " rc=$?"
printf '%-44s ' "udp api.github.com:443 send"
timeout 5 bash -c 'echo x >/dev/udp/api.github.com/443' 2>&1; echo "rc=$?"
printf '%-44s ' "ipv6 route"
ip -6 route 2>/dev/null | head -2 | tr '\n' ';'; echo
printf '%-44s ' "curl http3 feature"
curl -V | grep -o HTTP3 || echo none

echo "## git"
cd "$(mktemp -d)"
git config --global user.email probe@example.invalid
git config --global user.name probe
g() { local l=$1; shift; printf '%-44s ' "$l"; out=$(timeout 60 "$@" 2>&1); rc=$?; printf 'rc=%s %s\n' "$rc" "$(printf '%s' "$out" | tail -1 | cut -c1-100)"; }
g "clone R.git"                    git clone -q "https://github.com/$R.git" r
g "clone R (no .git)"              git clone -q "https://github.com/$R" r2
g "clone cli/cli depth1"           git clone -q --depth 1 https://github.com/cli/cli.git other
g "ls-remote R with fake creds"    git ls-remote "https://nas:nas-a1b-invalid@github.com/$R.git"
( cd r && date > probe.txt && git add probe.txt && git commit -qm probe )
g "push R"                         git -C r push -q origin HEAD:refs/heads/probe
g "push --dry-run to cli/cli" git -C r push --dry-run https://github.com/cli/cli.git HEAD:refs/heads/sbx-probe
g "noproxy ls-remote R"            env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy git -c http.proxy= ls-remote "https://github.com/$R.git"
g "remote probe branch exists"     git ls-remote "https://github.com/$R.git" refs/heads/probe
