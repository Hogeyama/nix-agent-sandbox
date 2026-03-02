#!/usr/bin/env bash
set -euo pipefail

# --- Nix PATH セットアップ (ホストの nix をソケット経由で使う場合) ---
if [ "${NIX_ENABLED:-false}" = "true" ]; then
  # ホストの nix プロファイルを PATH に追加
  for p in /nix/var/nix/profiles/default/bin /root/.nix-profile/bin; do
    if [ -d "$p" ]; then
      export PATH="$p:$PATH"
      break
    fi
  done
fi

# --- ユーザーセットアップ ---
NAS_UID="${NAS_UID:-0}"
NAS_GID="${NAS_GID:-0}"
WORKSPACE="${WORKSPACE:-/workspace}"

if [ "$NAS_UID" != "0" ]; then
  # ホストユーザーに合わせた非 root ユーザーを作成
  echo "nas:x:${NAS_UID}:${NAS_GID}:nas:/home/nas:/bin/bash" >>/etc/passwd
  grep -q "^nas:" /etc/group 2>/dev/null || echo "nas:x:${NAS_GID}:" >>/etc/group
  chown -R "${NAS_UID}:${NAS_GID}" /home/nas

  # nix trusted-users にホストユーザーを追加 (nix daemon 経由操作に必要)
  if [ "${NIX_ENABLED:-false}" = "true" ] && [ -d /nix/var/nix ]; then
    mkdir -p /etc/nix
    echo "trusted-users = root nas" >>/etc/nix/nix.conf 2>/dev/null || true
  fi

  export HOME=/home/nas

  # git safe.directory (nas ユーザー用)
  setpriv --reuid="${NAS_UID}" --regid="${NAS_GID}" --init-groups -- \
    git config --global --add safe.directory "$WORKSPACE"

  EXEC_PREFIX=(setpriv --reuid="${NAS_UID}" --regid="${NAS_GID}" --init-groups --)
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
  echo "[nas] Detected flake.nix, entering nix develop (via host daemon)..."
  exec "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix develop "$WORKSPACE" --command "${AGENT_COMMAND[@]}"
else
  exec "${EXEC_PREFIX[@]}" "${AGENT_COMMAND[@]}"
fi
