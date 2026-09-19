#!/bin/bash
set -euo pipefail

# chatgpt.cliExecutable replaces the spawned executable outright — unlike
# claudeProcessWrapper, no bundled-binary path arrives in "$@". Resolve the
# extension's own codex so the app-server protocol version always matches the
# extension build (the host codex is deliberately not mounted).
#
# The extension appends the running build's bundled bin dir to the end of
# PATH when it spawns cliExecutable, so the last PATH entry matching the
# extension layout names the exact build that launched us. Prefer it over a
# glob, which could pick a stale directory left behind by an update or the
# other release channel. The glob remains for callers that do not set PATH
# up (e.g. a manual run).
codex_bin=""
IFS=':' read -ra path_entries <<< "${PATH:-}"
for ((i = ${#path_entries[@]} - 1; i >= 0; i--)); do
  case "${path_entries[i]}" in
    */openai.chatgpt-*/bin/*)
      if [ -x "${path_entries[i]}/codex" ]; then
        codex_bin="${path_entries[i]}/codex"
        break
      fi
      ;;
  esac
done
if [ -z "$codex_bin" ]; then
  shopt -s nullglob
  candidates=(
    "$HOME"/.vscode-server/extensions/openai.chatgpt-*/bin/*/codex
    "$HOME"/.vscode-server-insiders/extensions/openai.chatgpt-*/bin/*/codex
  )
  shopt -u nullglob
  executables=()
  for candidate in "${candidates[@]:-}"; do
    [ -x "$candidate" ] && executables+=("$candidate")
  done
  if [ "${#executables[@]}" -eq 0 ]; then
    echo 'nas-devcontainer-codex: no bundled codex found under ~/.vscode-server*/extensions/openai.chatgpt-*' >&2
    exit 64
  fi
  # Sort on the version inside the extension dir name, not the whole path —
  # path order would always rank .vscode-server-insiders above .vscode-server
  # regardless of version.
  codex_bin=$(
    for candidate in "${executables[@]}"; do
      extension_dir=$(dirname "$(dirname "$(dirname "$candidate")")")
      printf '%s\t%s\n' "${extension_dir##*/openai.chatgpt-}" "$candidate"
    done | sort -t "$(printf '\t')" -k 1,1 -V | tail -n 1 | cut -f 2-
  )
fi
codex_bin_dir=$(dirname "$codex_bin")

source /usr/local/lib/nas/devcontainer-env.sh
nas_devcontainer_apply
# nas_devcontainer_apply restores the captured baseline PATH, which drops the
# bundled bin dir the extension appended; re-add it so sibling helpers such as
# codex-code-mode-host stay reachable the way the extension intended.
export PATH="$PATH:$codex_bin_dir"

source /usr/local/lib/nas/devcontainer/agent-args.sh
# -c is a global codex option: it is valid ahead of the extension's own
# `-c features.code_mode_host=true app-server` argv. NAS_AGENT_ARGS carries the
# filtered profile args plus the observability -c pairs.
exec "$codex_bin" \
  -c shell_environment_policy.inherit=all \
  "${NAS_AGENT_ARGS[@]}" \
  "$@"
