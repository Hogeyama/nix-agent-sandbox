#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo 'usage: nas-direnv-exec WORKSPACE ENV_OPS_FILE PATH_PREFIX COMMAND [ARG...]' >&2
  exit 64
fi

workspace=$1
ops_file=$2
path_prefix=$3
shift 3
real_bash=${NAS_REAL_BASH:?NAS_REAL_BASH must be set}

finish='set -euo pipefail
ops_file=$1; path_prefix=$2; shift 2
if [ -n "$ops_file" ]; then source "$ops_file"; fi
export PATH="${path_prefix}${PATH}"
exec "$@"'

if [ "${NAS_DIRENV_ENABLED:-false}" != true ]; then
  exec "$real_bash" -c "$finish" nas-direnv "$ops_file" "$path_prefix" "$@"
fi

# direnv state inherited from the host describes a different environment and
# must not be reversed when the workspace is evaluated inside the container.
unset DIRENV_DIFF DIRENV_DIR DIRENV_FILE DIRENV_WATCHES DIRENV_LAYOUT_DIR
cd -- "$workspace"

# These approval dependencies must come from the image, never workspace PATH.
if ! status=$(/usr/bin/direnv status --json); then
  echo '[nas] direnv status failed; refusing to start.' >&2
  exit 1
fi

if ! /usr/bin/jq -e '
  (.state | type == "object") and
  (.state | has("foundRC")) and
  (.state.foundRC == null or
    ((.state.foundRC.path | type == "string") and
     (.state.foundRC.allowed | type == "number")))
' >/dev/null <<<"$status"; then
  echo '[nas] Invalid direnv status; refusing to start.' >&2
  exit 1
fi

if ! /usr/bin/jq -e '.state.foundRC == null or .state.foundRC.allowed == 0' \
    >/dev/null <<<"$status"; then
  rc_path=$(/usr/bin/jq -r '.state.foundRC.path' <<<"$status")
  printf '[nas] direnv has not allowed %q. On the host, run: direnv allow %q\n' \
    "$rc_path" "$rc_path" >&2
  echo '[nas] If this is a new nas worktree, keep it at cleanup and reuse it after allowing.' >&2
  exit 1
fi

if /usr/bin/jq -e '.state.foundRC != null' >/dev/null <<<"$status"; then
  /usr/local/libexec/nas-direnv-bootstrap \
    /usr/local/share/nas/direnv-lib.sh
fi

exec /usr/bin/direnv exec "$workspace" "$real_bash" -c "$finish" \
  nas-direnv "$ops_file" "$path_prefix" "$@"
