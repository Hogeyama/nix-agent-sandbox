#!/usr/bin/env bash
set -euo pipefail

# --- /nix/store overlay (ホストの store をマウントしている場合) ---
# コンテナ既存の store とホスト store を統合する
if [ -d /nix/store-host ]; then
  echo "[naw] Setting up /nix/store overlay..."
  # 既存のコンテナ store を退避
  cp -al /nix/store /nix/store-container 2>/dev/null || true
  mkdir -p /nix/store-overlay/{upper,work}
  fuse-overlayfs \
    -o "lowerdir=/nix/store-container:/nix/store-host,upperdir=/nix/store-overlay/upper,workdir=/nix/store-overlay/work" \
    /nix/store
  echo "[naw] /nix/store overlay ready"
fi

# --- nix develop 統合 ---
WORKSPACE="${WORKSPACE:-/workspace}"
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
