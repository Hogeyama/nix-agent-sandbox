#!/usr/bin/env bash
set -euo pipefail

# --shell モード: docker exec 経由で対話シェルを起動する際に使う。
# PID 1 で実行される通常モードと異なり、初回のみ必要な初期化
# (ユーザー作成、ローカルプロキシ起動、/etc/nix/nix.conf への追記) を
# スキップしつつ、agent と同じ env/PATH/direnv 環境・非 root ユーザーで
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

nas_measure_start() {
  local target="$1"
  if [ "$nas_debug_enabled" != "true" ]; then
    printf -v "$target" '%s' ""
    return 0
  fi
  printf -v "$target" '%s' "${EPOCHREALTIME/./}"
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
  ended_at="${EPOCHREALTIME/./}"
  elapsed=$(((ended_at - started_at) / 1000))
  nas_debug "[nas]   ↳ entrypoint:${label} done (${elapsed}ms)"
}

exec_nas() {
  nas_measure_done "total" "${ENTRYPOINT_TOTAL_START:-}"
  exec "$@"
}

nas_measure_start ENTRYPOINT_TOTAL_START
nas_debug "[nas] entrypoint start (shell_mode=${NAS_SHELL_MODE}, nix_enabled=${NIX_ENABLED:-false})"
if [ "$nas_debug_enabled" = "true" ] && [ -n "${NAS_DOCKER_RUN_STARTED_AT_US:-}" ]; then
  NAS_ENTRYPOINT_STARTED_AT_US="${EPOCHREALTIME/./}"
  NAS_DOCKER_STARTUP_MS=$(((NAS_ENTRYPOINT_STARTED_AT_US - NAS_DOCKER_RUN_STARTED_AT_US) / 1000))
  nas_debug "[nas]   ↳ docker-run-to-entrypoint done (${NAS_DOCKER_STARTUP_MS}ms)"
fi
unset NAS_DOCKER_RUN_STARTED_AT_US

# --- CA 証明書のインストール ---
# update-ca-certificates は全証明書を走査するため ~1s かかる。
# 追加するのは mitmproxy CA 1 枚だけなので、CA bundle への追記と
# ハッシュシンボリンク作成を直接行う。
nas_measure_start CA_CERT_START
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
  # -jdktrust (OpenSSL 3.2+) が無いと、証明書だけの PKCS12 を Java は
  # 「0 エントリ」として読む (Oracle 独自の trustedKeyUsage 属性が必須)。
  # 未対応の openssl ではこのコマンドが失敗してファイルが残らず、下の
  # -f ガードで JAVA_TOOL_OPTIONS ごとスキップされる。
  openssl pkcs12 -export -nokeys \
    -jdktrust anyExtendedKeyUsage \
    -in "$NAS_PROXY_CERT" \
    -out "$JVM_TRUSTSTORE" \
    -passout pass:changeit \
    -name nas-proxy \
    -certpbe PBE-SHA1-3DES \
    -macalg sha1 2>/dev/null
  if [ -f "$JVM_TRUSTSTORE" ]; then
    # openssl pkcs12 -export は 0600 で書き、ここは setpriv 降格前の root。
    # 中身は公開 CA 証明書だけなので、エージェントユーザーが読めるようにする。
    chmod 644 "$JVM_TRUSTSTORE"
    export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djavax.net.ssl.trustStore=$JVM_TRUSTSTORE -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12"
    nas_debug "[nas] JVM trust store configured for proxy CA"
  fi
fi
nas_measure_done "ca-cert" "$CA_CERT_START"

# --- 環境変数 prefix/suffix 適用 ---
# direnv が同名の変数を上書きするため、ここでは eval せず
# ファイルに保存し、共通ランチャーで direnv 適用後に一度だけ実行する。
nas_measure_start ENV_OPS_START
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
nas_measure_start NIX_SETUP_START
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
export HOME="$NAS_HOME"
mkdir -p "$NAS_HOME"
WORKSPACE="${WORKSPACE:?WORKSPACE must be set}"

nas_measure_start USER_SETUP_START
if [ "$NAS_UID" != "0" ]; then
  # 同じ UID/GID を持つ既存エントリを削除 (ubuntu イメージのデフォルト ubuntu ユーザー等)
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

nas_measure_start GIT_SETUP_START
append_git_config_env "safe.directory" "$WORKSPACE"
# /etc/gitconfig 方式: nix が内部で git を呼ぶ際に env var が渡らないため
git config --system safe.directory "$WORKSPACE"
nas_measure_done "git-safe-directory" "$GIT_SETUP_START"

# --- ローカル認証プロキシ ---
# NAS_UPSTREAM_PROXY が設定されている場合、認証代行ローカルプロキシを起動し
# http_proxy/https_proxy を localhost:18080 に書き換える。
# --shell モードでは初回起動時の proxy が既に走っているため env のみ書き換える。
nas_measure_start LOCAL_PROXY_SETUP_START
if [ -n "${NAS_UPSTREAM_PROXY:-}" ]; then
  if [ "$NAS_SHELL_MODE" != "true" ]; then
    bun /usr/local/bin/local-proxy.mjs &
    LOCAL_PROXY_PID=$!

    # ヘルスチェック: localhost:18080 に接続可能になるまで待機
    for i in $(seq 1 500); do
      if bash -c "echo >/dev/tcp/127.0.0.1/18080" 2>/dev/null; then
        nas_info "[nas] Local auth proxy ready (pid=$LOCAL_PROXY_PID)"
        break
      fi
      if [ "$i" -eq 500 ]; then
        echo "[nas] WARNING: local proxy failed to start within 5s" >&2
      fi
      sleep 0.01
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

# --- bash override ---
NAS_BASH_OVERRIDE="/tmp/nas-bash-override"
NAS_REAL_BASH="/bin/bash"
mkdir -p "$NAS_BASH_OVERRIDE"

if [ -n "${NAS_MASK_FILTER:-}" ] && [ -n "${NAS_MASK_SOCKET:-}" ]; then
  BASH_SYSTEM_PATH="$(readlink -f /bin/bash)"
  NAS_REAL_BASH="$NAS_BASH_OVERRIDE/bash.real"

  if [ ! -e "$NAS_REAL_BASH" ]; then
    cp --preserve=mode "$BASH_SYSTEM_PATH" "$NAS_REAL_BASH"
  fi

  # マスクは nas-mask-filter の supervise モードに任せる。
  #
  # 以前はここで `exec > >("$NAS_MASK_FILTER")` とプロセス置換を使っていたが、
  # bash はプロセス置換の子を wait せず、直後の exec で自分自身を置き換えて
  # しまうため、フィルタの終了を待てるプロセスが 1 つも残らなかった。
  # フィルタは出力先パイプを握ったまま bash より長く生き残るので、「bash の
  # 終了」を完了シグナルにしている呼び出し元からは出力が丸ごと欠けて見える
  # (同じコマンドが成功したり無出力になったりする競合)。
  # supervise モードではフィルタ自身が親になり、パイプを drain し切ってから
  # 子の終了ステータスで exit するため、この競合が起きない。
  #
  # NAS_MASK_SUPERVISED は supervisor が子へ渡す入れ子抑止のマーカー。
  # コンテナ内の bash はすべてこのラッパーなので、抑止しないと ./configure や
  # make の各レシピ行、再帰 make、npm/cargo のビルドスクリプトのたびに層が
  # 積み上がり、接続数は生存 bash プロセス数に比例して増える。抑止しても
  # カバレッジは減らない: 子孫は最外周 supervisor のパイプを継承するので
  # 出力は既にマスクされており、最外周から逃げる出力 (ファイルへのリダイレクト、
  # /dev/tty) は内側の層からも同様に逃げる。
  #
  # ラッパーは検証済みの非secret broker path を設置時に private な readonly 変数へ
  # 埋め込むので、環境を落として起動された bash (env -i、env_reset 付きの sudo、
  # su -) もマスクを維持する。固定された socket が消えた、または接続不能なら
  # supervisor が何も出力せず予約コード 121 (= 出力抑止) で落とす。通常の呼び出しは
  # bash.real へフォールバックしないため、マスク不能な出力を通さない。
  BASH_WRAPPER_TMP="$NAS_BASH_OVERRIDE/bash.tmp.$$"
  {
    cat << 'MASK_WRAPPER_HEADER'
#!/tmp/nas-bash-override/bash.real
MASK_WRAPPER_HEADER
    printf 'readonly nas_mask_filter_path=%q\n' "$NAS_MASK_FILTER"
    printf 'readonly nas_mask_socket_path=%q\n' "$NAS_MASK_SOCKET"
    cat << 'MASK_WRAPPER_BODY'
if [ "${1:-}" = "/entrypoint.sh" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
if [ -n "${NAS_MASK_SUPERVISED:-}" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
if [ ! -S "$nas_mask_socket_path" ]; then
  exit 121
fi
exec "$nas_mask_filter_path" --supervise --argv0 "$0" \
  --socket "$nas_mask_socket_path" -- \
  /tmp/nas-bash-override/bash.real "$@"
MASK_WRAPPER_BODY
  } > "$BASH_WRAPPER_TMP"
  chmod +x "$BASH_WRAPPER_TMP"

  BASH_PATH_WRAPPER_TMP="$NAS_BASH_OVERRIDE/bash.next.$$"
  cp --preserve=mode "$BASH_WRAPPER_TMP" "$BASH_PATH_WRAPPER_TMP"
  mv -f "$BASH_PATH_WRAPPER_TMP" "$NAS_BASH_OVERRIDE/bash"

  BASH_SYSTEM_WRAPPER_TMP="${BASH_SYSTEM_PATH}.nas-wrapper.$$"
  cp --preserve=mode "$BASH_WRAPPER_TMP" "$BASH_SYSTEM_WRAPPER_TMP"
  mv -f "$BASH_SYSTEM_WRAPPER_TMP" "$BASH_SYSTEM_PATH"
  rm -f "$BASH_WRAPPER_TMP"

  # The workspace RC may reset SHELL; apply this after direnv.
  if [ -z "$NAS_ENV_OPS_FILE" ]; then
    NAS_ENV_OPS_FILE="$(mktemp /tmp/nas-env-ops.XXXXXX)"
    chmod 644 "$NAS_ENV_OPS_FILE"
  fi
  echo "export SHELL='$NAS_BASH_OVERRIDE/bash'" >> "$NAS_ENV_OPS_FILE"
  nas_debug "[nas] mask-filter: NAS_ENV_OPS_FILE=$NAS_ENV_OPS_FILE"
  nas_debug "[nas] mask-filter: env-ops content=$(cat "$NAS_ENV_OPS_FILE" 2>/dev/null | tail -3)"
elif [ -x /bin/bash ]; then
  ln -sf /bin/bash "$NAS_BASH_OVERRIDE/bash"
fi

export NAS_BASH_OVERRIDE NAS_REAL_BASH
export PATH="${NAS_BASH_OVERRIDE}:${PATH}"

# Both launches load the approved workspace environment as the agent user.
# Interactive startup may rewrite PATH in .bashrc, so restore wrapper priority
# afterwards without applying the environment operations a second time.
nas_measure_start LAUNCH_SETUP_START
PATH_PREFIX="${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}"
if [ "$NAS_SHELL_MODE" = true ]; then
  SHELL_RC_FILE="$(mktemp /tmp/nas-shell-rc.XXXXXX)"
  {
    printf 'if [ -f %q ]; then source %q; fi\n' "$HOME/.bashrc" "$HOME/.bashrc"
    printf 'export PATH=%q"$PATH"\n' "$PATH_PREFIX"
  } > "$SHELL_RC_FILE"
  chmod 644 "$SHELL_RC_FILE"
  AGENT_COMMAND=("$NAS_REAL_BASH" --noprofile --rcfile "$SHELL_RC_FILE" -i)
fi
nas_measure_done "launch-setup" "$LAUNCH_SETUP_START"
# Bypass the PATH bash wrapper so the launcher and payload retain their TTY.
exec_nas "${EXEC_PREFIX[@]}" "$NAS_REAL_BASH" /usr/local/bin/nas-direnv-exec \
  "$WORKSPACE" "$NAS_ENV_OPS_FILE" "$PATH_PREFIX" "${AGENT_COMMAND[@]}"
