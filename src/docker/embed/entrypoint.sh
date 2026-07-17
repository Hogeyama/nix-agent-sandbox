#!/usr/bin/env bash
set -euo pipefail

# --shell モード: docker exec 経由で対話シェルを起動する際に使う。
# PID 1 で実行される通常モードと異なり、初回のみ必要な初期化
# (ユーザー作成、ローカルプロキシ起動、/etc/nix/nix.conf への追記) を
# スキップしつつ、agent と同じ env/PATH/Nix 環境・非 root ユーザーで
# bash を起動する。
NAS_SHELL_MODE=false
if [ "${1:-}" = "--shell" ]; then
  NAS_SHELL_MODE=true
  shift
fi

NAS_LOG_LEVEL="${NAS_LOG_LEVEL:-info}"
if [ "$NAS_SHELL_MODE" = "true" ]; then
  # シェル起動時は info ログを抑制して余計な出力を避ける
  NAS_LOG_LEVEL=quiet
  # xtrace を /tmp/nas-shell.log に出す。dtach socket が即消える系の無言死を
  # 診断可能にするため、全コマンドと stderr をファイルに残す。
  # 古いログは残すと混乱するので毎回 truncate、PS4 で行番号を表示する。
  NAS_SHELL_LOG="/tmp/nas-shell.log"
  : >"$NAS_SHELL_LOG" 2>/dev/null || true
  chmod 666 "$NAS_SHELL_LOG" 2>/dev/null || true
  export PS4='+ [${BASH_SOURCE##*/}:${LINENO}] '
  exec {NAS_SHELL_LOG_FD}>>"$NAS_SHELL_LOG"
  BASH_XTRACEFD=$NAS_SHELL_LOG_FD
  set -x
  # ENTRYPOINT で起きた非捕捉エラーの原因を最後に書き残す
  trap 'rc=$?; echo "[nas-shell][trap] exit=$rc at ${BASH_SOURCE##*/}:${LINENO} cmd=${BASH_COMMAND}" >&$NAS_SHELL_LOG_FD' ERR EXIT
fi

nas_info() {
  if [ "$NAS_LOG_LEVEL" != "info" ]; then
    return 0
  fi
  echo "$@"
}

nas_debug_enabled=false
if [ "$NAS_LOG_LEVEL" = "debug" ]; then
  nas_debug_enabled=true
fi

nas_debug() {
  if [ "$nas_debug_enabled" != "true" ]; then
    return 0
  fi
  echo "$@" >&2
}

nas_now_ms() {
  date +%s%3N
}

nas_measure_start() {
  if [ "$nas_debug_enabled" != "true" ]; then
    return 0
  fi
  nas_now_ms
}

nas_measure_done() {
  if [ "$nas_debug_enabled" != "true" ]; then
    return 0
  fi
  local label="$1"
  local started_at="${2:-}"
  if [ -z "$started_at" ]; then
    return 0
  fi
  local ended_at elapsed
  ended_at="$(nas_now_ms)"
  elapsed=$((ended_at - started_at))
  nas_debug "[nas]   ↳ entrypoint:${label} done (${elapsed}ms)"
}

exec_nas() {
  nas_measure_done "total" "${ENTRYPOINT_TOTAL_START:-}"
  exec "$@"
}

ENTRYPOINT_TOTAL_START="$(nas_measure_start)"
nas_debug "[nas] entrypoint start (shell_mode=${NAS_SHELL_MODE}, nix_enabled=${NIX_ENABLED:-false})"

# --- CA 証明書のインストール ---
# update-ca-certificates は全証明書を走査するため ~1s かかる。
# 追加するのは mitmproxy CA 1 枚だけなので、CA bundle への追記と
# ハッシュシンボリンク作成を直接行う。
CA_CERT_START="$(nas_measure_start)"
NAS_PROXY_CERT="/usr/local/share/ca-certificates/nas-proxy.crt"
if [ -f "$NAS_PROXY_CERT" ]; then
  cat "$NAS_PROXY_CERT" >> /etc/ssl/certs/ca-certificates.crt
  if command -v openssl &>/dev/null; then
    cert_hash=$(openssl x509 -hash -noout -in "$NAS_PROXY_CERT" 2>/dev/null || true)
    if [ -n "$cert_hash" ]; then
      ln -sf "$NAS_PROXY_CERT" "/etc/ssl/certs/${cert_hash}.0"
    fi
  fi
  nas_info "[nas] mitmproxy CA certificate installed"
fi
JVM_TRUSTSTORE="/tmp/nas-proxy-truststore.p12"
if [ -f "$NAS_PROXY_CERT" ] && command -v openssl &>/dev/null; then
  openssl pkcs12 -export -nokeys \
    -in "$NAS_PROXY_CERT" \
    -out "$JVM_TRUSTSTORE" \
    -passout pass:changeit \
    -name nas-proxy \
    -certpbe PBE-SHA1-3DES \
    -macalg sha1 2>/dev/null
  if [ -f "$JVM_TRUSTSTORE" ]; then
    export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djavax.net.ssl.trustStore=$JVM_TRUSTSTORE -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12"
    nas_debug "[nas] JVM trust store configured for proxy CA"
  fi
fi
nas_measure_done "ca-cert" "$CA_CERT_START"

# --- 環境変数 prefix/suffix 適用 ---
# Nix devShell が同名の変数を上書きするため、ここでは eval せず
# ファイルに保存し、各 exec パスで nix 環境 source 後に適用する。
ENV_OPS_START="$(nas_measure_start)"
NAS_ENV_OPS_FILE=""
if [ -n "${NAS_ENV_OPS:-}" ]; then
  NAS_ENV_OPS_FILE="$(mktemp /tmp/nas-env-ops.XXXXXX)"
  {
    cat <<'EOFDEF'
__nas_pfx() { local key="$1" val="$2" sep="$3"; if [ -n "${!key+x}" ]; then export "$key=${val}${sep}${!key}"; else export "$key=${val}"; fi; }
__nas_sfx() { local key="$1" val="$2" sep="$3"; if [ -n "${!key+x}" ]; then export "$key=${!key}${sep}${val}"; else export "$key=${val}"; fi; }
EOFDEF
    echo "$NAS_ENV_OPS"
    echo 'unset -f __nas_pfx __nas_sfx 2>/dev/null || true'
  } > "$NAS_ENV_OPS_FILE"
  chmod 644 "$NAS_ENV_OPS_FILE"
  unset NAS_ENV_OPS
fi
nas_measure_done "env-ops" "$ENV_OPS_START"

# --- Nix セットアップ ---
NIX_SETUP_START="$(nas_measure_start)"
if [ "${NIX_ENABLED:-false}" = "true" ] && [ -n "${NIX_BIN_PATH:-}" ]; then
  # ホストの nix バイナリ (/nix/store/... 内) へのシンボリックリンクを作成
  ln -sf "$NIX_BIN_PATH" /usr/local/bin/nix
fi
# --shell モードでは初回起動時に追記した trusted-users 等の設定を
# 保持するため再コピーしない。
if [ "$NAS_SHELL_MODE" != "true" ] && \
   [ "${NIX_ENABLED:-false}" = "true" ] && [ -n "${NIX_CONF_PATH:-}" ] && [ -f "$NIX_CONF_PATH" ]; then
  # ホストの nix.conf をコンテナ内に配置
  mkdir -p /etc/nix
  cp "$NIX_CONF_PATH" /etc/nix/nix.conf
fi
nas_measure_done "nix-setup" "$NIX_SETUP_START"

# --- ユーザーセットアップ ---
NAS_UID="${NAS_UID:-0}"
NAS_GID="${NAS_GID:-0}"
NAS_USER="${NAS_USER:-${USER:-nas}}"
NAS_HOME="/home/${NAS_USER}"
WORKSPACE="${WORKSPACE:?WORKSPACE must be set}"

USER_SETUP_START="$(nas_measure_start)"
if [ "$NAS_UID" != "0" ]; then
  # 同じ UID/GID を持つ既存エントリを削除 (ubuntu:24.04 のデフォルト ubuntu ユーザー等)
  EXISTING_USER=$(awk -F: -v uid="$NAS_UID" '$3 == uid {print $1}' /etc/passwd)
  if [ -n "$EXISTING_USER" ] && [ "$EXISTING_USER" != "$NAS_USER" ]; then
    sed -i "/^${EXISTING_USER}:/d" /etc/passwd
  fi
  EXISTING_GROUP=$(awk -F: -v gid="$NAS_GID" '$3 == gid {print $1}' /etc/group)
  if [ -n "$EXISTING_GROUP" ] && [ "$EXISTING_GROUP" != "$NAS_USER" ]; then
    sed -i "/^${EXISTING_GROUP}:/d" /etc/group
  fi
  # 同名エントリが残っていれば削除 (UID が異なる同名ユーザー)
  sed -i "/^${NAS_USER}:/d" /etc/passwd
  sed -i "/^${NAS_USER}:/d" /etc/group

  # ホストユーザーに合わせた非 root ユーザーを作成
  mkdir -p "$NAS_HOME"
  echo "${NAS_USER}:x:${NAS_UID}:${NAS_GID}:${NAS_USER}:${NAS_HOME}:/bin/bash" >>/etc/passwd
  echo "${NAS_USER}:x:${NAS_GID}:" >>/etc/group
  chown "${NAS_UID}:${NAS_GID}" "$NAS_HOME"

  # Docker がマウントポイントの親ディレクトリを root で作成するため、
  # $NAS_HOME 配下の root 所有ディレクトリの所有権を修正
  find "$NAS_HOME" -maxdepth 3 -type d \( -uid 0 -o -gid 0 \) \
    -exec chown "${NAS_UID}:${NAS_GID}" {} + 2>/dev/null || true

  # nix trusted-users にコンテナユーザーを追加 (nix daemon 経由操作に必要)
  # --shell モードでは初回起動時に設定済みのため重複追記を避ける
  if [ "$NAS_SHELL_MODE" != "true" ] && \
     [ "${NIX_ENABLED:-false}" = "true" ] && [ -f /etc/nix/nix.conf ]; then
    echo "trusted-users = root ${NAS_USER}" >>/etc/nix/nix.conf 2>/dev/null || true
  fi

  export HOME="$NAS_HOME"
  export USER="$NAS_USER"

  # Nix 用に実際の HOME ディレクトリの所有権を設定
  chown -f "${NAS_UID}:${NAS_GID}" "$NAS_HOME" 2>/dev/null || true

  # GPG ソケットがマウントされている場合、ディレクトリの所有権を設定
  if [ -e "${NAS_HOME}/.gnupg/S.gpg-agent" ]; then
    chown "${NAS_UID}:${NAS_GID}" "${NAS_HOME}/.gnupg"
    chmod 700 "${NAS_HOME}/.gnupg"
  fi

  # GPG socket の GID を補助グループに追加
  # --init-groups と --groups は排他なので、ソケットがある場合は
  # --groups に NAS_GID と各 GID を明示的に列挙する
  EXTRA_GIDS=""
  if [ -S "${NAS_HOME}/.gnupg/S.gpg-agent" ]; then
    GPG_SOCK_GID=$(stat -c '%g' "${NAS_HOME}/.gnupg/S.gpg-agent")
    EXTRA_GIDS="${GPG_SOCK_GID}"
  fi
  if [ -n "$EXTRA_GIDS" ]; then
    EXEC_PREFIX=(setpriv --reuid="${NAS_UID}" --regid="${NAS_GID}" --groups "${NAS_GID},${EXTRA_GIDS}" --)
  else
    EXEC_PREFIX=(setpriv --reuid="${NAS_UID}" --regid="${NAS_GID}" --init-groups --)
  fi
else
  EXEC_PREFIX=()
fi
nas_measure_done "user-setup" "$USER_SETUP_START"

# git safe.directory を設定
# env var 方式: 直接実行されるコマンド向け
# (read-only マウントの .config/git に書き込もうとするのを回避)
append_git_config_env() {
  local key="$1"
  local value="$2"
  local count="${GIT_CONFIG_COUNT:-0}"
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    count=0
  fi
  local key_var="GIT_CONFIG_KEY_${count}"
  local value_var="GIT_CONFIG_VALUE_${count}"
  export GIT_CONFIG_COUNT="$((count + 1))"
  export "${key_var}=${key}"
  export "${value_var}=${value}"
}

GIT_SETUP_START="$(nas_measure_start)"
append_git_config_env "safe.directory" "$WORKSPACE"
# /etc/gitconfig 方式: nix が内部で git を呼ぶ際に env var が渡らないため
git config --system safe.directory "$WORKSPACE"
nas_measure_done "git-safe-directory" "$GIT_SETUP_START"

# --- ローカル認証プロキシ ---
# NAS_UPSTREAM_PROXY が設定されている場合、認証代行ローカルプロキシを起動し
# http_proxy/https_proxy を localhost:18080 に書き換える。
# --shell モードでは初回起動時の proxy が既に走っているため env のみ書き換える。
LOCAL_PROXY_SETUP_START="$(nas_measure_start)"
if [ -n "${NAS_UPSTREAM_PROXY:-}" ]; then
  if [ "$NAS_SHELL_MODE" != "true" ]; then
    bun /usr/local/bin/local-proxy.mjs &
    LOCAL_PROXY_PID=$!

    # ヘルスチェック: localhost:18080 に接続可能になるまで待機
    for i in $(seq 1 50); do
      if bash -c "echo >/dev/tcp/127.0.0.1/18080" 2>/dev/null; then
        nas_info "[nas] Local auth proxy ready (pid=$LOCAL_PROXY_PID)"
        break
      fi
      if [ "$i" -eq 50 ]; then
        echo "[nas] WARNING: local proxy failed to start within 5s" >&2
      fi
      sleep 0.1
    done
  fi

  export http_proxy="http://127.0.0.1:18080"
  export https_proxy="http://127.0.0.1:18080"
  export HTTP_PROXY="http://127.0.0.1:18080"
  export HTTPS_PROXY="http://127.0.0.1:18080"
fi
nas_measure_done "local-proxy" "$LOCAL_PROXY_SETUP_START"

# --- エージェントコマンド ---
AGENT_COMMAND=("${@}")
if [ ${#AGENT_COMMAND[@]} -eq 0 ]; then
  if [ "$NAS_SHELL_MODE" = "true" ]; then
    AGENT_COMMAND=("bash" "-i")
  else
    AGENT_COMMAND=("bash")
  fi
fi

HOSTEXEC_PATH_PREFIX=""
if [ -n "${NAS_HOSTEXEC_WRAPPER_DIR:-}" ]; then
  HOSTEXEC_PATH_PREFIX="${NAS_HOSTEXEC_WRAPPER_DIR}"
fi

# --shell モード: flake 再評価や nix develop/print-dev-env 経由の複雑な
# 起動は避け、初回起動時に作られたキャッシュ env を source するだけにする。
# エージェント用の経路は入出力を expr/exec で回しているため、そのまま bash -i
# を流すと source 結果や set オプションとの相互作用で無言即死しうる。
# シェルは会話的に使えればよいので最短経路にする。
SHELL_BOOTSTRAP_START="$(nas_measure_start)"
if [ "$NAS_SHELL_MODE" = "true" ]; then
  NAS_BASH_OVERRIDE_DIR="/tmp/nas-bash-override"
  mkdir -p "$NAS_BASH_OVERRIDE_DIR"
  if [ -x /bin/bash ] && [ ! -e "$NAS_BASH_OVERRIDE_DIR/bash" ]; then
    ln -sf /bin/bash "$NAS_BASH_OVERRIDE_DIR/bash"
  fi
  SHELL_PATH_PREFIX="${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE_DIR}:"
  SHELL_CACHE_FILE=""
  if [ "${NIX_ENABLED:-false}" = "true" ] && [ -f "$WORKSPACE/flake.nix" ]; then
    SHELL_NIX_CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/nas/nix-dev-env"
    if [ -f "$WORKSPACE/flake.lock" ]; then
      SHELL_FLAKE_HASH=$(cat "$WORKSPACE/flake.nix" "$WORKSPACE/flake.lock" | sha256sum | cut -d' ' -f1)
    else
      SHELL_FLAKE_HASH=$(sha256sum "$WORKSPACE/flake.nix" | cut -d' ' -f1)
    fi
    CANDIDATE="${SHELL_NIX_CACHE}/${SHELL_FLAKE_HASH}.env"
    if [ -f "$CANDIDATE" ]; then
      SHELL_CACHE_FILE="$CANDIDATE"
    fi
  fi
  if [ -n "$SHELL_CACHE_FILE" ]; then
    nas_debug "[nas] entrypoint shell bootstrap (cache=hit)"
  else
    nas_debug "[nas] entrypoint shell bootstrap (cache=miss)"
  fi
  if [ -n "$SHELL_CACHE_FILE" ]; then
    SHELL_RC_FILE="$(mktemp "/tmp/nas-shell-rc-${NAS_UID}.XXXXXX")"
    {
      echo "source '$SHELL_CACHE_FILE' 2>/dev/null || true"
      if [ -n "$NAS_ENV_OPS_FILE" ]; then
        echo "[ -f '$NAS_ENV_OPS_FILE' ] && source '$NAS_ENV_OPS_FILE' || true"
      fi
      echo "export PATH=\"${SHELL_PATH_PREFIX}\$PATH\""
      echo "[ -f ~/.bashrc ] && source ~/.bashrc"
    } >"$SHELL_RC_FILE"
    chown "${NAS_UID}:${NAS_GID}" "$SHELL_RC_FILE" 2>/dev/null || true
    nas_measure_done "shell-bootstrap" "$SHELL_BOOTSTRAP_START"
    exec_nas "${EXEC_PREFIX[@]}" bash --noprofile --rcfile "$SHELL_RC_FILE" -i
  else
    [ -n "${NAS_ENV_OPS_FILE:-}" ] && source "$NAS_ENV_OPS_FILE"
    export PATH="${SHELL_PATH_PREFIX}$PATH"
    nas_measure_done "shell-bootstrap" "$SHELL_BOOTSTRAP_START"
    exec_nas "${EXEC_PREFIX[@]}" bash -i
  fi
fi
nas_measure_done "shell-bootstrap" "$SHELL_BOOTSTRAP_START"

exec_agent_command() {
  [ -n "${NAS_ENV_OPS_FILE:-}" ] && source "$NAS_ENV_OPS_FILE"
  if [ -n "$HOSTEXEC_PATH_PREFIX" ] || [ -n "${NAS_BASH_OVERRIDE:-}" ]; then
    export PATH="${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}$PATH"
  fi
  local first_cmd="${AGENT_COMMAND[0]:-}"
  local arg_count=0
  if [ ${#AGENT_COMMAND[@]} -gt 0 ]; then
    arg_count=$((${#AGENT_COMMAND[@]} - 1))
  fi
  nas_debug "[nas] entrypoint exec-agent (cmd=${first_cmd:-none}, extra_args=${arg_count})"
  exec_nas "${EXEC_PREFIX[@]}" "${AGENT_COMMAND[@]}"
}

# --- nix 統合 ---
NIX_INTEGRATION_START="$(nas_measure_start)"
if [ "${NIX_ENABLED:-false}" = "true" ]; then
  NIX_EXTRA_PACKAGES_LIST=()
  if [ -n "${NIX_EXTRA_PACKAGES:-}" ]; then
    while IFS= read -r pkg; do
      [ -n "$pkg" ] && NIX_EXTRA_PACKAGES_LIST+=("$pkg")
    done <<<"${NIX_EXTRA_PACKAGES}"
  fi

  # workaround for https://github.com/github/copilot-cli/issues/1161#issuecomment-3938706868:
  # 配列をスペース区切りの文字列に変換
  CMD_STR=$(printf '%q ' "${AGENT_COMMAND[@]}")
  # /bin/bash (readline対応) を Nix の readline なし bash より優先させる。
  # /bin 全体を PATH に入れると他のツールまで上書きするため、
  # bash だけのシンボリックリンクを専用ディレクトリに作る。
  NAS_BASH_OVERRIDE="/tmp/nas-bash-override"
  mkdir -p "$NAS_BASH_OVERRIDE"
  if [ -n "${NAS_MASK_FILTER_BASH_WRAPPER:-}" ]; then
    printf '%s' "$NAS_MASK_FILTER_BASH_WRAPPER" > "$NAS_BASH_OVERRIDE/bash"
    chmod +x "$NAS_BASH_OVERRIDE/bash"
  elif [ -x /bin/bash ]; then
    ln -sf /bin/bash "$NAS_BASH_OVERRIDE/bash"
  fi
  # --- devShell キャッシュ検索 (probe 前にキャッシュを確認) ---
  # キャッシュヒット時は nix eval による devShell probe (~1s) をスキップする。
  CACHE_FILE=""
  NAS_NIX_CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/nas/nix-dev-env"

  if [ -f "$WORKSPACE/flake.nix" ]; then
    if [ -f "$WORKSPACE/flake.lock" ]; then
      FLAKE_HASH=$(cat "$WORKSPACE/flake.nix" "$WORKSPACE/flake.lock" | sha256sum | cut -d' ' -f1)
    else
      FLAKE_HASH=$(sha256sum "$WORKSPACE/flake.nix" | cut -d' ' -f1)
    fi

    CANDIDATE="${NAS_NIX_CACHE}/${FLAKE_HASH}.env"
    PROFILE_LINK="${NAS_NIX_CACHE}/profile-${FLAKE_HASH}"

    if [ -f "$CANDIDATE" ]; then
      CACHE_FILE="$CANDIDATE"
      nas_debug "[nas] nix-devshell-probe skipped (cache hit)"
      nas_info "[nas] Using cached nix dev environment."
    else
      DEV_SHELL_PROBE_START="$(nas_measure_start)"
      SYSTEM=$(nix eval --raw --impure --expr builtins.currentSystem 2>/dev/null || echo "")
      if [ -n "$SYSTEM" ] && "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon \
        nix eval --raw "${WORKSPACE}#devShells.${SYSTEM}.default.type" 2>/dev/null | grep -qx derivation; then
        nas_measure_done "nix-devshell-probe" "$DEV_SHELL_PROBE_START"

        mkdir -p "$NAS_NIX_CACHE"
        NIX_PRINT_DEV_ENV_START="$(nas_measure_start)"
        nas_info "[nas] Caching nix dev environment via print-dev-env..."
        if "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon \
          nix print-dev-env --profile "$PROFILE_LINK" "$WORKSPACE" >"${CANDIDATE}.tmp"; then
          mv "${CANDIDATE}.tmp" "$CANDIDATE"
          chmod 644 "$CANDIDATE"
          CACHE_FILE="$CANDIDATE"
          nas_info "[nas] Nix dev environment cached."
          nas_measure_done "nix-print-dev-env" "$NIX_PRINT_DEV_ENV_START"
        else
          nas_info "[nas] nix print-dev-env failed, falling back to nix develop..."
          rm -f "${CANDIDATE}.tmp"
          nas_measure_done "nix-print-dev-env" "$NIX_PRINT_DEV_ENV_START"
          if [ ${#NIX_EXTRA_PACKAGES_LIST[@]} -gt 0 ]; then
            nas_measure_done "nix-integration" "$NIX_INTEGRATION_START"
            exec_nas "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix shell "${NIX_EXTRA_PACKAGES_LIST[@]}" --command \
              nix develop "$WORKSPACE" --command \
              bash -c "${NAS_ENV_OPS_FILE:+source '$NAS_ENV_OPS_FILE';} export PATH=\"${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}\$PATH\"; exec $CMD_STR"
          else
            nas_measure_done "nix-integration" "$NIX_INTEGRATION_START"
            exec_nas "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix develop "$WORKSPACE" --command \
              bash -c "${NAS_ENV_OPS_FILE:+source '$NAS_ENV_OPS_FILE';} export PATH=\"${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}\$PATH\"; exec $CMD_STR"
          fi
        fi
      else
        nas_measure_done "nix-devshell-probe" "$DEV_SHELL_PROBE_START"
        nas_info "[nas] flake.nix found but no devShells.${SYSTEM:-unknown}.default output, skipping nix develop."
      fi
    fi
  fi

  if [ -n "$CACHE_FILE" ]; then
    if [ ${#NIX_EXTRA_PACKAGES_LIST[@]} -gt 0 ]; then
      nas_measure_done "nix-integration" "$NIX_INTEGRATION_START"
      exec_nas "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix shell "${NIX_EXTRA_PACKAGES_LIST[@]}" --command \
        bash -c "source '$CACHE_FILE'; ${NAS_ENV_OPS_FILE:+source '$NAS_ENV_OPS_FILE';} export PATH=\"${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}\$PATH\"; exec $CMD_STR"
    else
      nas_measure_done "nix-integration" "$NIX_INTEGRATION_START"
      exec_nas "${EXEC_PREFIX[@]}" \
        bash -c "source '$CACHE_FILE'; ${NAS_ENV_OPS_FILE:+source '$NAS_ENV_OPS_FILE';} export PATH=\"${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}\$PATH\"; exec $CMD_STR"
    fi
  elif [ ${#NIX_EXTRA_PACKAGES_LIST[@]} -gt 0 ]; then
    nas_info "[nas] flake.nix not found, entering nix shell (via host daemon)..."
    nas_measure_done "nix-integration" "$NIX_INTEGRATION_START"
    exec_nas "${EXEC_PREFIX[@]}" env NIX_REMOTE=daemon nix shell "${NIX_EXTRA_PACKAGES_LIST[@]}" --command \
      bash -c "${NAS_ENV_OPS_FILE:+source '$NAS_ENV_OPS_FILE';} export PATH=\"${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}\$PATH\"; exec $CMD_STR"
  else
    nas_measure_done "nix-integration" "$NIX_INTEGRATION_START"
    exec_agent_command
  fi
else
  nas_measure_done "nix-integration" "$NIX_INTEGRATION_START"
  exec_agent_command
fi
