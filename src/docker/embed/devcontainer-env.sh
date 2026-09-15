# Sourced by the root entrypoint and by non-root Bash login shells.
# The fixed directory is prepared by root before dropping privileges.
nas_devcontainer_capture() {
  local nas_ops=$1 nas_prefix=$2 nas_key nas_file
  shift 2
  local -a nas_keys=(
    http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY
    SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE
    GIT_SSL_CAINFO JAVA_TOOL_OPTIONS PATH SHELL HOME USER LOGNAME WORKSPACE
    XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR DIRENV_CONFIG
    NAS_UID NAS_GID NAS_USER NAS_HOME NAS_REAL_BASH NAS_BASH_OVERRIDE NAS_DIRENV_ENABLED
    NAS_HOSTEXEC_SOCKET NAS_HOSTEXEC_WRAPPER_DIR NAS_HOSTEXEC_CLIENT_PATH
    NAS_HOSTEXEC_SESSION_ID NAS_HOSTEXEC_INTERCEPT_PATHS LD_PRELOAD
    NAS_MASK_FILTER NAS_MASK_SOCKET NAS_SESSION_ID NAS_SESSION_STORE_DIR
    NAS_PORT_RELAY_SOCKET NAS_LOG_LEVEL GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM
  )
  while IFS= read -r nas_key; do nas_keys+=("$nas_key"); done < <(compgen -e GIT_CONFIG_)
  # These are names only, supplied from the finalized plan's dynamic operations.
  for nas_key in ${NAS_DEVCONTAINER_ENV_KEYS:-}; do
    if ! [[ "$nas_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
       [[ "$nas_key" = NAS_UPSTREAM_PROXY || "$nas_key" = NAS_ENV_OPS ]]; then
      echo '[nas] Invalid Dev Container environment key' >&2
      return 1
    fi
    nas_keys+=("$nas_key")
  done
  nas_file=$(mktemp /usr/local/lib/nas/devcontainer/.baseline.XXXXXX) || return
  {
    for nas_key in "${nas_keys[@]}"; do
      if [ -n "${!nas_key+x}" ]; then
        printf 'export %s=%q\n' "$nas_key" "${!nas_key}"
      else
        printf 'unset %s\n' "$nas_key"
      fi
    done
    printf 'NAS_DEVCONTAINER_PATH_PREFIX=%q\n' "$nas_prefix"
  } > "$nas_file"
  chmod 644 "$nas_file" && mv -f "$nas_file" /usr/local/lib/nas/devcontainer/baseline.sh || return
  nas_file=$(mktemp /usr/local/lib/nas/devcontainer/.ops.XXXXXX) || return
  if [ -n "$nas_ops" ]; then cat -- "$nas_ops" > "$nas_file" || return; fi
  chmod 644 "$nas_file" && mv -f "$nas_file" /usr/local/lib/nas/devcontainer/env-ops.sh || return
  nas_file=$(mktemp /usr/local/lib/nas/devcontainer/.args.XXXXXX) || return
  {
    printf 'declare -a NAS_AGENT_ARGS=('
    if [ "$#" -gt 0 ]; then printf ' %q' "$@"; fi
    printf ' )\n'
  } > "$nas_file"
  chmod 644 "$nas_file" && mv -f "$nas_file" /usr/local/lib/nas/devcontainer/agent-args.sh
}

nas_devcontainer_apply() {
  local nas_key nas_exports
  # Old Git entries and direnv reverse-diffs describe the previous session.
  while IFS= read -r nas_key; do unset "$nas_key"; done < <(compgen -e GIT_CONFIG_)
  unset DIRENV_DIFF DIRENV_DIR DIRENV_FILE DIRENV_WATCHES DIRENV_LAYOUT_DIR NAS_UPSTREAM_PROXY
  source /usr/local/lib/nas/devcontainer/baseline.sh || return
  nas_exports=$("$NAS_REAL_BASH" /usr/local/bin/nas-direnv-exec \
    "$WORKSPACE" /usr/local/lib/nas/devcontainer/env-ops.sh \
    "$NAS_DEVCONTAINER_PATH_PREFIX" --export) || return
  eval "$nas_exports"
}
