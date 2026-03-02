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
NAW_UID="${NAW_UID:-0}"
NAW_GID="${NAW_GID:-0}"
WORKSPACE="${WORKSPACE:-/workspace}"

if [ "$NAW_UID" != "0" ]; then
  # ホストユーザーに合わせた非 root ユーザーを作成
  echo "naw:x:${NAW_UID}:${NAW_GID}:naw:/home/naw:/bin/bash" >> /etc/passwd
  grep -q "^naw:" /etc/group 2>/dev/null || echo "naw:x:${NAW_GID}:" >> /etc/group
  chown -R "${NAW_UID}:${NAW_GID}" /home/naw

  # nix trusted-users にホストユーザーを追加 (nix daemon 経由操作に必要)
  if [ "${NIX_ENABLED:-false}" = "true" ] && [ -d /nix/var/nix ]; then
    mkdir -p /etc/nix
    echo "trusted-users = root naw" >> /etc/nix/nix.conf 2>/dev/null || true
  fi

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
  echo "[naw] Detected flake.nix, entering nix develop (via host daemon)..."
  exec "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix develop "$WORKSPACE" --command "${AGENT_COMMAND[@]}"
else
  exec "${EXEC_PREFIX[@]}" "${AGENT_COMMAND[@]}"
fi
