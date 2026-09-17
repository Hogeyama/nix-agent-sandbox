#!/bin/bash
set -euo pipefail
if [ "$EUID" = 0 ]; then
  echo '[nas] Dev Container readiness requires a non-root user' >&2
  exit 1
fi
nas_idle_child=''
nas_idle_stop() {
  if [ -n "$nas_idle_child" ]; then
    kill "$nas_idle_child" 2>/dev/null || true
    wait "$nas_idle_child" 2>/dev/null || true
  fi
  exit 0
}
trap nas_idle_stop TERM INT
printf '%s\n' "$EUID" > /run/nas-devcontainer/ready
while :; do
  sleep 86400 &
  nas_idle_child=$!
  wait "$nas_idle_child"
done
