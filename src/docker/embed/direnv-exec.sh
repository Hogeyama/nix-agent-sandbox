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
execution_mode=$1; ops_file=$2; path_prefix=$3; shift 3
if [ -n "$ops_file" ]; then source "$ops_file"; fi
export PATH="${path_prefix}${PATH}"
if [ "$execution_mode" = acp ]; then
  exec 0<&8 1>&9 8<&- 9>&-
fi
exec "$@"'

# Reads the exported environment into an associative array and records the
# order of the names in a second one. `env -0` rather than `compgen -e`:
# bash built without programmable completion has no `compgen`, and the
# failure would happen inside a process substitution, where it reads as an
# empty environment and silently turns the diff below into "nothing changed".
nas_snapshot_env() {
  local -n nas_values=$1
  local -n nas_order=$2
  local nas_entry nas_key
  while IFS= read -r -d '' nas_entry; do
    nas_key=${nas_entry%%=*}
    # PWD and OLDPWD describe this process, not the environment it prepares.
    # The diff below spans `cd -- "$workspace"`, so replaying them would tell a
    # consumer whose real cwd is elsewhere that it is somewhere it is not.
    # Bash re-derives its own, but anything reading $PWD from the environment
    # believes what it is given.
    case "$nas_key" in
      "" | [0-9]* | *[!A-Za-z0-9_]* | PWD | OLDPWD) continue ;;
    esac
    if [ -z "${nas_values[$nas_key]+x}" ]; then nas_order+=("$nas_key"); fi
    nas_values["$nas_key"]=${nas_entry#*=}
  done < <(/usr/bin/env -0)
  if [ "${#nas_values[@]}" = 0 ]; then
    echo '[nas] Could not read the environment; refusing to start.' >&2
    exit 1
  fi
}

nas_export_mode=false
if [ "$#" = 1 ] && [ "$1" = --export ]; then
  nas_export_mode=true
  declare -A nas_before=()
  declare -a nas_before_order=()
  nas_snapshot_env nas_before nas_before_order
fi

nas_export_environment() {
  local nas_key nas_code
  local -A nas_after=()
  local -a nas_after_order=()
  if [ "${NAS_DIRENV_ENABLED:-false}" = true ]; then
    nas_code=$(/usr/bin/direnv export bash) || return
    eval "$nas_code"
  fi
  if [ -n "$ops_file" ]; then source "$ops_file"; fi
  export PATH="${path_prefix}${PATH}"
  nas_snapshot_env nas_after nas_after_order
  for nas_key in "${nas_after_order[@]}"; do
    if [ -z "${nas_before[$nas_key]+x}" ] ||
      [ "${nas_before[$nas_key]}" != "${nas_after[$nas_key]}" ]; then
      printf 'export %s=%q\n' "$nas_key" "${nas_after[$nas_key]}"
    fi
  done
  for nas_key in "${nas_before_order[@]}"; do
    if [ -z "${nas_after[$nas_key]+x}" ]; then printf 'unset %s\n' "$nas_key"; fi
  done
}

if [ "${NAS_DIRENV_ENABLED:-false}" != true ]; then
  if [ "$nas_export_mode" = true ]; then nas_export_environment; exit; fi
  exec "$real_bash" -c "$finish" nas-direnv "${NAS_EXECUTION_MODE:-terminal}" "$ops_file" "$path_prefix" "$@"
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

if [ "$nas_export_mode" = true ]; then nas_export_environment; exit; fi

exec /usr/bin/direnv exec "$workspace" "$real_bash" -c "$finish" \
  nas-direnv "${NAS_EXECUTION_MODE:-terminal}" "$ops_file" "$path_prefix" "$@"
