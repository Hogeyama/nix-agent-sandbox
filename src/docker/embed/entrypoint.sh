#!/usr/bin/env bash
set -euo pipefail

# --- Nix セットアップ ---
if [ "${NIX_ENABLED:-false}" = "true" ] && [ -n "${NIX_BIN_PATH:-}" ]; then
  # ホストの nix バイナリ (/nix/store/... 内) へのシンボリックリンクを作成
  ln -sf "$NIX_BIN_PATH" /usr/local/bin/nix
fi
if [ "${NIX_ENABLED:-false}" = "true" ] && [ -n "${NIX_CONF_PATH:-}" ] && [ -f "$NIX_CONF_PATH" ]; then
  # ホストの nix.conf をコンテナ内に配置
  mkdir -p /etc/nix
  cp "$NIX_CONF_PATH" /etc/nix/nix.conf
fi

# --- ユーザーセットアップ ---
NAS_UID="${NAS_UID:-0}"
NAS_GID="${NAS_GID:-0}"
NAS_USER="${NAS_USER:-${USER:-nas}}"
NAS_HOME="/home/${NAS_USER}"
WORKSPACE="${WORKSPACE:-/workspace}"

if [ "$NAS_UID" != "0" ]; then
  # ホストユーザーに合わせた非 root ユーザーを作成
  mkdir -p "$NAS_HOME"
  echo "${NAS_USER}:x:${NAS_UID}:${NAS_GID}:${NAS_USER}:${NAS_HOME}:/bin/bash" >>/etc/passwd
  grep -q "^${NAS_USER}:" /etc/group 2>/dev/null || echo "${NAS_USER}:x:${NAS_GID}:" >>/etc/group
  chown "${NAS_UID}:${NAS_GID}" "$NAS_HOME"

  # nix trusted-users にコンテナユーザーを追加 (nix daemon 経由操作に必要)
  if [ "${NIX_ENABLED:-false}" = "true" ] && [ -f /etc/nix/nix.conf ]; then
    echo "trusted-users = root ${NAS_USER}" >>/etc/nix/nix.conf 2>/dev/null || true
  fi

  export HOME="$NAS_HOME"
  export USER="$NAS_USER"

  # GPG ソケットがマウントされている場合、ディレクトリの所有権を設定
  if [ -e "${NAS_HOME}/.gnupg/S.gpg-agent" ]; then
    chown "${NAS_UID}:${NAS_GID}" "${NAS_HOME}/.gnupg"
    chmod 700 "${NAS_HOME}/.gnupg"
  fi

  # Docker socket / GPG socket の GID を補助グループに追加
  # --init-groups と --groups は排他なので、ソケットがある場合は
  # --groups に NAS_GID と各 GID を明示的に列挙する
  EXTRA_GIDS=""
  if [ -S /var/run/docker.sock ]; then
    DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
    EXTRA_GIDS="${DOCKER_SOCK_GID}"
  fi
  if [ -S "${NAS_HOME}/.gnupg/S.gpg-agent" ]; then
    GPG_SOCK_GID=$(stat -c '%g' "${NAS_HOME}/.gnupg/S.gpg-agent")
    if [ -n "$EXTRA_GIDS" ]; then
      EXTRA_GIDS="${EXTRA_GIDS},${GPG_SOCK_GID}"
    else
      EXTRA_GIDS="${GPG_SOCK_GID}"
    fi
  fi
  if [ -n "$EXTRA_GIDS" ]; then
    EXEC_PREFIX=(setpriv --reuid="${NAS_UID}" --regid="${NAS_GID}" --groups "${NAS_GID},${EXTRA_GIDS}" --)
  else
    EXEC_PREFIX=(setpriv --reuid="${NAS_UID}" --regid="${NAS_GID}" --init-groups --)
  fi
else
  EXEC_PREFIX=()
fi

# git safe.directory をファイルに書かず env var で渡す
# (read-only マウントの .config/git に書き込もうとするのを回避)
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="safe.directory"
export GIT_CONFIG_VALUE_0="$WORKSPACE"

# --- エージェントコマンド ---
AGENT_COMMAND=("${@}")
if [ ${#AGENT_COMMAND[@]} -eq 0 ]; then
  AGENT_COMMAND=("bash")
fi

# --- nix 統合 ---
if [ "${NIX_ENABLED:-false}" = "true" ]; then
  NIX_EXTRA_PACKAGES_LIST=()
  if [ -n "${NIX_EXTRA_PACKAGES:-}" ]; then
    while IFS= read -r pkg; do
      [ -n "$pkg" ] && NIX_EXTRA_PACKAGES_LIST+=("$pkg")
    done <<< "${NIX_EXTRA_PACKAGES}"
  fi

  # workaround for https://github.com/github/copilot-cli/issues/1161#issuecomment-3938706868:
  # 配列をスペース区切りの文字列に変換
  CMD_STR=$(printf '%q ' "${AGENT_COMMAND[@]}")
  # /bin/bash (readline対応) をPATHの先頭に配置して、
  # Nixの readline なし bash より優先させる
  if [ -f "$WORKSPACE/flake.nix" ]; then
    if [ ${#NIX_EXTRA_PACKAGES_LIST[@]} -gt 0 ]; then
      echo "[nas] Detected flake.nix, entering nix shell + nix develop (via host daemon)..."
      exec "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix shell "${NIX_EXTRA_PACKAGES_LIST[@]}" --command \
        nix develop "$WORKSPACE" --command \
        bash -c "export PATH=\"/bin:\$PATH\"; exec $CMD_STR"
    else
      echo "[nas] Detected flake.nix, entering nix develop (via host daemon)..."
      exec "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix develop "$WORKSPACE" --command \
        bash -c "export PATH=\"/bin:\$PATH\"; exec $CMD_STR"
    fi
  elif [ ${#NIX_EXTRA_PACKAGES_LIST[@]} -gt 0 ]; then
    echo "[nas] flake.nix not found, entering nix shell (via host daemon)..."
    exec "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix shell "${NIX_EXTRA_PACKAGES_LIST[@]}" --command \
      bash -c "export PATH=\"/bin:\$PATH\"; exec $CMD_STR"
  else
    exec "${EXEC_PREFIX[@]}" "${AGENT_COMMAND[@]}"
  fi
else
  exec "${EXEC_PREFIX[@]}" "${AGENT_COMMAND[@]}"
fi
