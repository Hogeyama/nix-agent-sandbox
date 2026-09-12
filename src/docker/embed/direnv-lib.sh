# shellcheck shell=bash

if [[ -z ${NAS_NIX_DIRENV_LIBRARY_LOADED:-} ]]; then
  readonly NAS_NIX_DIRENV_LIBRARY_LOADED=1
  # Keep this absolute path stable in the image. Tests relocate it only in a
  # fixture copy, alongside the launcher and bootstrap helper.
  if ! source "/usr/local/share/nas/nix-direnv.sh"; then
    log_error "[nas] Cannot load the packaged nix-direnv library."
    exit 1
  fi

  _nas_nix_direnv_home_hash=$(printf '%s' "${HOME:-}" | sha256sum)
  readonly _nas_nix_direnv_home_hash=${_nas_nix_direnv_home_hash%% *}

  # Match direnv's public layout function: honor its lowercase layout variable
  # and otherwise resolve from PWD when the function is used. The override
  # applies to all layout consumers; a project may replace the function later.
  direnv_layout_dir() {
    local project_layout=${direnv_layout_dir:-$PWD/.direnv}
    local worktree_hash
    worktree_hash=$(pwd -P | sha256sum)
    worktree_hash=${worktree_hash%% *}
    printf '%s/nas/nix-direnv-%s-home-%s-worktree-%s\n' \
      "$project_layout" "$NIX_DIRENV_VERSION" \
      "$_nas_nix_direnv_home_hash" "$worktree_hash"
  }
fi
