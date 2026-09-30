#!/usr/bin/env bash
# Live check of strait on a Linux host: bypass attempts and positive controls.
# Needs network, bubblewrap, socat, and GH_TOKEN for a token that can read
# $REPO. The token is only ever handed to strait; nothing here prints it.
#
#   GH_TOKEN=$(gh auth token) contrib/strait/tests/probe.sh [owner/repo]
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
REPO=${1:-Hogeyama/nix-agent-sandbox}
: "${GH_TOKEN:?set GH_TOKEN}"
work=$(mktemp -d)
denier=
trap 'rm -rf "$work"; [[ -n $denier ]] && kill "$denier" 2>/dev/null' EXIT
printf '{ "githubRepos": ["%s"], "hostExec": true }\n' "$REPO" >"$work/strait.json"
cd "$work"

# Out-of-policy requests are held for approval. A background reviewer answers
# each one as it appears, so the bypass attempts below come back as 403
# instead of waiting 240 s. It reads each request in full (`show`, which
# includes a GraphQL body and a hostexec argv): one carrying
# `strait-probe-approve` (or `strait_probe_approve`, as a GraphQL alias) is
# approved, one carrying `strait-probe-hold` is left
# waiting, and the rest are denied. It runs in the same environment as
# `check`, so both look in the same socket directory.
review() { env -i HOME="$HOME" PATH="$PATH" "$here/strait" review "$@"; }
(while :; do
  for id in $(review list --all 2>/dev/null | cut -f1); do
    shown=$(review show "$id" 2>/dev/null)
    case $shown in
    *strait-probe-hold*) ;;
    *strait-probe-approve* | *strait_probe_approve*) review approve "$id" >/dev/null 2>&1 ;;
    *) review deny "$id" >/dev/null 2>&1 ;;
    esac
  done
  sleep 0.5
done) &
denier=$!

fails=0
check() { # name expected-regex command
  local name=$1 want=$2 cmd=$3 got
  got=$(env -i HOME="$HOME" PATH="$PATH" GH_TOKEN="$GH_TOKEN" TERM=dumb \
    "$here/strait" --config strait.json -- bash -c "$cmd" 2>&1 | tail -3 | tr '\n' ' ')
  if [[ $got =~ $want ]]; then
    printf 'ok    %-34s %s\n' "$name" "$got"
  else
    printf 'FAIL  %-34s want /%s/ got: %s\n' "$name" "$want" "$got"
    fails=$((fails + 1))
  fi
}

api=https://api.github.com/repos/$REPO
code='-sS -o /dev/null -w %{http_code} --max-time 20'

# Positive controls: the issued credential is substituted and accepted.
check "gh api with issued token" '^200' "curl $code -H \"Authorization: token \$GH_TOKEN\" $api"
check "gh CLI" '"full_name"' "gh api repos/$REPO --jq '{full_name}'"
check "gh pr list (GraphQL)" 'exit=0' "gh pr list -R $REPO --limit 1 >/dev/null; echo exit=\$?"
check "gh issue list (GraphQL)" 'exit=0' "gh issue list -R $REPO --limit 1 >/dev/null; echo exit=\$?"
check "git fetch (Basic via extraheader)" 'HEAD' "git ls-remote https://github.com/$REPO.git HEAD"
check "anthropic messages route passes" '^40[01]' "curl $code -X POST -H 'content-type: application/json' -d '{}' https://api.anthropic.com/v1/messages"

# Bypass attempts.
check "foreign token" '^403' "curl $code -H 'Authorization: Bearer nas-a1b-invalid' $api"
# node:http keeps the first of duplicated Authorization headers and drops the
# rest, and srt builds both the filter's view and the upstream request from
# that. So only the first one matters, and only it is ever sent.
check "duplicate Authorization, foreign first" '^403' "curl $code -H 'Authorization: token attacker' -H \"authorization: token \$GH_TOKEN\" $api"
check "duplicate Authorization, foreign dropped" '^200' "curl $code -H \"Authorization: token \$GH_TOKEN\" -H 'authorization: token attacker' $api"
check "other repository" '^403' "curl $code https://api.github.com/repos/octocat/hello-world"
check "REST write" '^403' "curl $code -X POST -d '{}' $api/issues"
gql="curl $code -X POST -H 'content-type: application/json' -H \"Authorization: token \$GH_TOKEN\" https://api.github.com/graphql -d"
check "graphql viewer" '^403' "$gql '{\"query\":\"{viewer{login}}\"}'"
check "graphql other repository" '^403' "$gql '{\"query\":\"{repository(owner:\\\"octocat\\\",name:\\\"hello-world\\\"){name}}\"}'"
check "graphql traversal" '^403' "$gql '{\"query\":\"{repository(owner:\\\"${REPO%/*}\\\",name:\\\"${REPO#*/}\\\"){owner{repositories(first:1){totalCount}}}}\"}'"
check "graphql mutation" '^403' "$gql '{\"query\":\"mutation{addStar(input:{starrableId:\\\"x\\\"}){clientMutationId}}\"}'"
check "git push discovery" 'returned error: 403' "git init -q r && cd r && git -c user.name=p -c user.email=p@x -c commit.gpgsign=false commit -q --allow-empty -m p && git push --dry-run https://github.com/$REPO.git HEAD:refs/heads/strait-probe"
check "files API" '^403' "curl $code https://api.anthropic.com/v1/files"
check "host outside the list" 'response 403' "curl $code https://example.com/"
check "SOCKS scheme swap" 'exit=97' "curl $code --cacert /etc/ssl/certs/ca-certificates.crt -x \"\${HTTPS_PROXY/http:/socks5h:}\" $api; echo exit=\$?"
check "SSH over CONNECT" 'SSH_EXIT=255' "eval \"timeout 30 \$GIT_SSH_COMMAND -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 443 -T git@github.com\"; echo SSH_EXIT=\$?"
check "own TLS without srt CA" 'exit=60' "curl $code --cacert /etc/ssl/certs/ca-certificates.crt $api; echo exit=\$?"

# Approval: a held request goes through once approved.
check "approved REST read of another repo" '^200' "curl $code 'https://api.github.com/repos/octocat/hello-world?strait-probe-approve=1'"
check "approved graphql outside the list" '"login"' "curl -sS --max-time 20 -X POST -H 'content-type: application/json' -H \"Authorization: token \$GH_TOKEN\" https://api.github.com/graphql -d '{\"query\":\"{strait_probe_approve: viewer{login}}\"}'"
# The sandbox cannot reach the approval socket, even with a request waiting.
# The held request is there (the host reviewer leaves it), but `strait review`
# inside the sandbox must not show it. It may list nothing or fail to open the
# socket directory (exit 1); a missing command (127) is a failure of the probe.
check "sandbox cannot see held requests" 'held-visible=0 rc=[01]' "curl $code 'https://api.github.com/repos/octocat/hello-world?strait-probe-hold=1' >/dev/null & sleep 2; out=\$($here/strait review list --all 2>/dev/null); rc=\$?; echo held-visible=\$(printf '%s' \"\$out\" | grep -c strait-probe-hold) rc=\$rc; kill %1"

# hostexec: runs on the host after approval, with only the declared env.
check "hostexec approved" 'out=strait-probe-approve exit=7' "$here/strait-hostexec -- sh -c 'echo out=strait-probe-approve; exit 7'; echo exit=\$?"
check "hostexec env and cwd" '\[strait-probe-approve\]\[\]\[/\]' "$here/strait-hostexec --cwd / --env A=strait-probe-approve -- sh -c 'echo \"[\$A][\$GH_TOKEN][\$(pwd)]\"'"
check "hostexec output masking" 'masked by strait' "$here/strait-hostexec --env M=strait-probe-approve -- sh -c 'gh auth token'"
# strait's own directory is read-only in the sandbox but not on the host.
check "hostexec runs outside the sandbox" 'wrote-on-host' "$here/strait-hostexec --env M=strait-probe-approve -- sh -c 'touch $here/.strait-probe && rm $here/.strait-probe && echo wrote-on-host'"
check "hostexec denied" 'exit=126' "$here/strait-hostexec -- echo no; echo exit=\$?"

# The policy's own files. `: >>` opens for writing without changing content.
check "write strait.json" 'Read-only|denied' ": >> strait.json && echo WROTE"
check "write strait source" 'Read-only|denied' ": >> $here/src/policy.ts && echo WROTE"
check "write patched srt" 'Read-only|denied' ": >> $here/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mux-proxy.js && echo WROTE"
check "plant bunfig preload" 'planted' "echo 'console.log(\"PRELOAD RAN\")' > p.ts && echo 'preload = [\"./p.ts\"]' > bunfig.toml && echo planted"
check "planted preload is ignored" '^ok $' "echo ok"

echo "failures: $fails"
exit $((fails > 0))
