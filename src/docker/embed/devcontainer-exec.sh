#!/bin/bash
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo 'usage: nas-devcontainer-exec COMMAND [ARG...]' >&2
  exit 64
fi
source /usr/local/lib/nas/devcontainer-env.sh
nas_devcontainer_apply
exec "$@"
