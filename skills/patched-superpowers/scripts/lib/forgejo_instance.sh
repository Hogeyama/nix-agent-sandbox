#!/usr/bin/env bash
# 使い捨て Forgejo インスタンスのライフサイクルを扱う。
#
# 実行ディレクトリ (DB, リポジトリ, SECRET_KEY, ログ) は使い捨てにする。
# 永続ディレクトリにはセッションストアと認証情報だけを置く。セッションストアを
# 残せばインスタンスを破棄してもユーザーのブラウザのログインが生き残るため、
# 常駐させずにログインの持続だけを得られる。SECRET_KEY の固定では代替できない。
# persistent cookie の検証がユーザー行の rands と salt に依存し、この2値は
# ユーザー作成のたびに再生成されるためである。

fj_die() {
  echo "Error: $*" >&2
  return 1
}

fj_repo_root() { git rev-parse --show-toplevel; }

fj_repo_hash() { printf '%s' "$(fj_repo_root)" | sha256sum | cut -c1-12; }

fj_state_dir() {
  echo "${XDG_STATE_HOME:-$HOME/.local/state}/patched-superpowers/forgejo"
}

fj_run_dir() {
  echo "${XDG_RUNTIME_DIR:-/tmp}/patched-superpowers/forgejo/$(fj_repo_hash)"
}

fj_port() { cat "$(fj_run_dir)/port" 2>/dev/null; }
fj_token() { cat "$(fj_run_dir)/token" 2>/dev/null; }
fj_conf() { echo "$(fj_run_dir)/custom/conf/app.ini"; }

# 「そのポートで何かが応答するか」では足りない。ポートを掴んだままの別インスタンス
# が居ると、自分の起動が bind に失敗しても健全と誤判定し、以後の API 呼び出しが
# 別インスタンスに飛んでトークンが通らず 404 になる。トークンが通ることまで
# 確かめて、応答しているのが自分のインスタンスだと確定させる。
fj_healthy() {
  local port token
  port="$(fj_port)"
  token="$(fj_token)"
  [ -n "$port" ] && [ -n "$token" ] || return 1
  curl -sf -o /dev/null --max-time 3 "http://localhost:$port/api/healthz" || return 1
  [ "$(curl -sf --max-time 3 -H "Authorization: token $token" \
        "http://localhost:$port/api/v1/user" | jq -r '.login // empty')" = agent ]
}

# 人間が打つ reviewer のパスワードは固定値にする。ランダムな長い文字列にすると、
# セッションが切れたときの再ログインで打てない。ブラウザの保存パスワードも、
# ポートが変わると照合されないことがある。
#
# 固定にすると、同じマシンの他ユーザーが 127.0.0.1 経由でログインしてレビュー対象の
# コードを読める。ここは打てないパスワードの実害を取って固定を選んでいる。誰も打たない
# agent はサイト管理者なのでランダムのまま残し、権限の大きい側の推測を防ぐ。
FJ_REVIEWER_PASS=reviewer

# agent のパスワードは永続させる。セッションが切れたときに同じ資格でログインし直せる
# ようにするためで、インスタンスごとに変えると再ログインの手段が失われる。
fj_credentials() {
  local file
  file="$(fj_state_dir)/credentials"
  if [ ! -f "$file" ] || ! grep -q '^FJ_AGENT_PASS=' "$file"; then
    mkdir -p "$(dirname "$file")"
    (
      umask 077
      printf 'FJ_AGENT_PASS=%saA1!\n' \
        "$(forgejo generate secret SECRET_KEY | tr -dc 'A-Za-z0-9' | cut -c1-24)" >"$file"
    )
  fi
  # shellcheck disable=SC1090
  . "$file"
  export FJ_AGENT_PASS FJ_REVIEWER_PASS
}

fj_free_port() {
  local p
  for p in $(seq 3200 3299); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      echo "$p"
      return 0
    fi
  done
  fj_die "3200-3299 に空きポートが無い"
}

fj_write_config() {
  local run="$1" port="$2" state="$3"
  mkdir -p "$run/custom/conf" "$run/data" "$run/log" "$run/repos" "$state/sessions"
  cat >"$run/custom/conf/app.ini" <<EOF
APP_NAME = patched-superpowers review
RUN_USER = $(id -un)
RUN_MODE = prod
WORK_PATH = $run

[server]
PROTOCOL = http
DOMAIN = localhost
HTTP_ADDR = 127.0.0.1
HTTP_PORT = $port
ROOT_URL = http://localhost:$port/
DISABLE_SSH = true
OFFLINE_MODE = true
LFS_START_SERVER = false

[database]
DB_TYPE = sqlite3
PATH = $run/data/forgejo.db

[repository]
ROOT = $run/repos

[security]
INSTALL_LOCK = true
SECRET_KEY = $(forgejo generate secret SECRET_KEY)
INTERNAL_TOKEN = $(forgejo generate secret INTERNAL_TOKEN)
PASSWORD_HASH_ALGO = pbkdf2
LOGIN_REMEMBER_DAYS = 365
MIN_PASSWORD_LENGTH = 8
PASSWORD_COMPLEXITY = off

[session]
PROVIDER = file
PROVIDER_CONFIG = $state/sessions
SESSION_LIFE_TIME = 31536000

[oauth2]
ENABLED = false
JWT_SECRET = $(forgejo generate secret JWT_SECRET)

[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = false

[mailer]
ENABLED = false

[cron]
ENABLED = false

[actions]
ENABLED = false

[log]
MODE = file
LEVEL = warn
ROOT_PATH = $run/log
EOF
}

fj_up() {
  fj_healthy && return 0
  command -v forgejo >/dev/null || { fj_die "forgejo が見つからない"; return 1; }
  command -v jq >/dev/null || { fj_die "jq が見つからない"; return 1; }

  # 空きポートの確認と bind の間に別プロセスが同じポートを取ることがある。
  # bind に失敗したら別のポートで作り直す。
  for _ in 1 2 3; do
    fj_boot_once && return 0
  done
  fj_die "インスタンスを起動できなかった: $(fj_run_dir)/log/web.log"
}

fj_boot_once() {
  local run state port conf pid
  run="$(fj_run_dir)"
  state="$(fj_state_dir)"
  [ -f "$run/web.pid" ] && kill "$(cat "$run/web.pid")" 2>/dev/null
  rm -rf "$run"
  port="$(fj_free_port)" || return 1
  fj_credentials
  fj_write_config "$run" "$port" "$state"
  conf="$run/custom/conf/app.ini"

  forgejo migrate -c "$conf" >"$run/log/migrate.log" 2>&1 ||
    { fj_die "migrate に失敗した: $run/log/migrate.log"; return 1; }

  # 作成順が uid を決める。agent=1, reviewer=2 を崩すと、永続セッションが
  # 別人の uid に解決される。
  forgejo admin user create -c "$conf" --username agent --password "$FJ_AGENT_PASS" \
    --email agent@review.invalid --admin --must-change-password=false \
    >"$run/log/user.log" 2>&1 || { fj_die "agent の作成に失敗した: $run/log/user.log"; return 1; }
  forgejo admin user create -c "$conf" --username reviewer --password "$FJ_REVIEWER_PASS" \
    --email reviewer@review.invalid --must-change-password=false \
    >>"$run/log/user.log" 2>&1 || { fj_die "reviewer の作成に失敗した: $run/log/user.log"; return 1; }

  forgejo admin user generate-access-token -c "$conf" --username agent --scopes all --raw \
    >"$run/token" 2>>"$run/log/user.log" ||
    { fj_die "トークンの生成に失敗した: $run/log/user.log"; return 1; }
  echo "$port" >"$run/port"

  nohup forgejo web -c "$conf" >"$run/log/web.log" 2>&1 &
  pid=$!
  echo "$pid" >"$run/web.pid"

  for _ in $(seq 1 120); do
    fj_healthy && return 0
    # bind に失敗すると web はすぐ終了する。生存を見ずに healthz だけを待つと、
    # 同じポートの別インスタンスの応答で成功と誤認する。
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}

# プロセス名は nix のラッパによって .forgejo-wrappe になるため、停止は必ず
# pid ファイルで行う。pgrep -x forgejo では検出できない。
fj_down() {
  local run
  run="$(fj_run_dir)"
  if [ -f "$run/web.pid" ]; then
    kill "$(cat "$run/web.pid")" 2>/dev/null || true
    for _ in $(seq 1 40); do
      fj_healthy || break
      sleep 0.25
    done
  fi
  rm -rf "$run"
}
