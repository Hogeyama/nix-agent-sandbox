#!/usr/bin/env bash
# Check which in-sandbox paths reach GitHub without srt terminating TLS.
# Run on the host from the repository root. Uses a fake token and a throwaway
# SSH key; no real credential is involved.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
here=docs/architecture/experiments/srt-filter-bypass
out=${1:-.local/srt-filter-bypass}
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ssh-keygen -q -t ed25519 -N '' -C srt-filter-probe -f "$work/id_probe"

# Everything below is single-quoted so it expands inside the sandbox, using
# only what srt itself puts in the sandbox environment.
fake='-H "Authorization: Bearer nas-a1b-invalid"'
system_ca='--cacert /etc/ssl/certs/ca-certificates.crt'
get_user='-w "\nHTTP_CODE=%{http_code}\n" https://api.github.com/user; echo CURL_EXIT=$?'
ssh_opts='-F /dev/null -i \"\$PROBE_KEY\" -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=20'

run_case() { # name settings command
  local name=$1 settings=$2 cmd=$3
  echo "== $name ($settings)"
  (cd "$work" && env -i HOME="$HOME" USER="$USER" PATH="$PATH" TERM=dumb \
    PROBE_KEY="$work/id_probe" \
    timeout 60 srt -d -s "$OLDPWD/$here/settings/$settings.json" -c "$cmd") \
    >"$out/$name.stdout" 2>"$out/$name.stderr"
  echo "exit=$?" >>"$out/$name.stdout"
}

run_case C0-port-443-https port-443 \
  "curl -sS -v --max-time 20 $get_user"
run_case C1-proxy-fake-token host-only \
  "curl -sS -v --max-time 20 $fake $get_user"
run_case C2-socks-scheme-swap host-only \
  "curl -sS -v --max-time 20 $system_ca -x \"\${HTTPS_PROXY/http:/socks5h:}\" $fake $get_user"
run_case C3-socks-port-1080 host-only \
  "u=\${HTTPS_PROXY#http://}; u=\${u%@*}; curl -sS -v --max-time 20 $system_ca -x \"socks5h://\$u@localhost:1080\" $fake $get_user"
run_case C4-ssh-22-host-only host-only \
  "eval \"timeout 30 \$GIT_SSH_COMMAND $ssh_opts -p 22 -T git@github.com\"; echo SSH_EXIT=\$?"
run_case C5-ssh-22-port-443 port-443 \
  "eval \"timeout 30 \$GIT_SSH_COMMAND $ssh_opts -p 22 -T git@github.com\"; echo SSH_EXIT=\$?"
run_case C6-ssh-443-wildcard wildcard-443 \
  "eval \"timeout 30 \$GIT_SSH_COMMAND $ssh_opts -p 443 -T git@ssh.github.com\"; echo SSH_EXIT=\$?"
run_case C7-exclude-fake-token exclude-api \
  "curl -sS -v --max-time 20 $system_ca $fake $get_user"

# Summary lines; the proxy auth token (32 hex chars) is redacted.
for f in "$out"/C*.stdout; do
  name=$(basename "$f" .stdout)
  echo "== $name"
  grep -hE 'issuer:|HTTP_CODE=|CURL_EXIT=|"message"|SSH_EXIT=|exit=|Permission denied|Hi |HTTP/1.1 [0-9]{3}|SOCKS|Connection Established|X-Proxy-Error|denied|refused|tls-terminate|opaque|Allowed by config|No matching config|Denied by config' \
    "$f" "$out/$name.stderr" | sed -E 's/[0-9a-f]{32}/<token>/g' | sort -u | head -40
done | tee "$out/summary.txt"
