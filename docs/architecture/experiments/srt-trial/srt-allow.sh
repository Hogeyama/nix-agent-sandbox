#!/usr/bin/env bash
# Add domains to the running srt's allowedDomains via --control-fd. Run on the host,
# from a second terminal, while srt.sh is running.
set -euo pipefail
ctl=/tmp/srt-trial-$UID
[[ -p $ctl/control ]] || { echo "no running srt.sh (missing $ctl/control)" >&2; exit 1; }

for d in "$@"; do
  [[ $d =~ ^[A-Za-z0-9.*-]+$ ]] || { echo "bad domain: $d" >&2; exit 1; }
  printf 'Allow ALL traffic to %s for this run? [y/N] ' "$d" >&2
  read -r ans
  [[ $ans == y ]] || { echo "skipped $d" >&2; continue; }
  echo "$d" >>"$ctl/extra-domains"
done

# Each control line replaces the whole config, so rebuild it from the snapshot taken at launch.
jq -c --rawfile extra "$ctl/extra-domains" \
  '.network.allowedDomains += ($extra | split("\n") | map(select(. != "")))
   | .network.allowedDomains |= unique' "$ctl/base.json" >"$ctl/control"
