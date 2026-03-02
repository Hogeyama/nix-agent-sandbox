#!/usr/bin/env bash
set -euo pipefail

# --- /nix/store overlay (ホストの store をマウントしている場合) ---
if [ -d /nix/store-host ]; then
  echo "[naw] Setting up /nix/store overlay..."
  mkdir -p /nix/store-overlay/{upper,work}
  fuse-overlayfs \
    -o "lowerdir=/nix/store-container:/nix/store-host,upperdir=/nix/store-overlay/upper,workdir=/nix/store-overlay/work" \
    /nix/store
  echo "[naw] /nix/store overlay ready"
fi

# --- ユーザーセットアップ ---
NAW_UID="${NAW_UID:-0}"
NAW_GID="${NAW_GID:-0}"
WORKSPACE="${WORKSPACE:-/workspace}"

if [ "$NAW_UID" != "0" ]; then
  # ホストユーザーに合わせた非 root ユーザーを作成
  echo "naw:x:${NAW_UID}:${NAW_GID}:naw:/home/naw:/bin/bash" >> /etc/passwd
  grep -q "^naw:" /etc/group 2>/dev/null || echo "naw:x:${NAW_GID}:" >> /etc/group
  chown -R "${NAW_UID}:${NAW_GID}" /home/naw
  export HOME=/home/naw

  # git safe.directory (naw ユーザー用)
  setpriv --reuid="${NAW_UID}" --regid="${NAW_GID}" --init-groups -- \
    git config --global --add safe.directory "$WORKSPACE"

  EXEC_PREFIX=(setpriv --reuid="${NAW_UID}" --regid="${NAW_GID}" --init-groups --)
else
  git config --global --add safe.directory "$WORKSPACE"
  EXEC_PREFIX=()
fi

# --- エージェントコマンド ---
AGENT_COMMAND=("${@}")
if [ ${#AGENT_COMMAND[@]} -eq 0 ]; then
  AGENT_COMMAND=("bash")
fi

# --- nix develop 統合 ---
if [ "${NIX_ENABLED:-false}" = "true" ] && [ -f "$WORKSPACE/flake.nix" ]; then
  echo "[naw] Detected flake.nix, entering nix develop..."
  exec "${EXEC_PREFIX[@]}" nix develop "$WORKSPACE" --command "${AGENT_COMMAND[@]}"
else
  exec "${EXEC_PREFIX[@]}" "${AGENT_COMMAND[@]}"
fi
