#!/usr/bin/env bash
set -euo pipefail

# --- /nix/store overlay (ホストの store をマウントしている場合) ---
# ビルド時にバックアップした store-container とホスト store を統合する
if [ -d /nix/store-host ]; then
  echo "[naw] Setting up /nix/store overlay..."
  mkdir -p /nix/store-overlay/{upper,work}
  fuse-overlayfs \
    -o "lowerdir=/nix/store-container:/nix/store-host,upperdir=/nix/store-overlay/upper,workdir=/nix/store-overlay/work" \
    /nix/store
  echo "[naw] /nix/store overlay ready"
fi

# --- git safe.directory (ホストユーザーと container root の UID 差異対策) ---
WORKSPACE="${WORKSPACE:-/workspace}"
git config --global --add safe.directory "$WORKSPACE"

# --- nix develop 統合 ---
AGENT_COMMAND=("${@}")

if [ ${#AGENT_COMMAND[@]} -eq 0 ]; then
  AGENT_COMMAND=("bash")
fi

if [ "${NIX_ENABLED:-false}" = "true" ] && [ -f "$WORKSPACE/flake.nix" ]; then
  echo "[naw] Detected flake.nix, entering nix develop..."
  exec nix develop "$WORKSPACE" --command "${AGENT_COMMAND[@]}"
else
  exec "${AGENT_COMMAND[@]}"
fi
