#!/bin/bash
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo 'nas-devcontainer-claude: bundled executable is required' >&2
  exit 64
fi
binary=$1
shift
source /usr/local/lib/nas/devcontainer/agent-args.sh
exec /usr/local/bin/nas-devcontainer-exec "$binary" "${NAS_AGENT_ARGS[@]}" "$@"
