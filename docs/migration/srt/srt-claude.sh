#!/usr/bin/env bash
# `nas claude` の代替として、srt (@anthropic-ai/sandbox-runtime) で Claude Code を起動する。
#
# 使い方:
#   srt-claude.sh open  [claude の追加引数...]
#   srt-claude.sh close [claude の追加引数...]
#
# global.pkl の `env` と `secrets` に相当する部分をここで組み立てる。srt は起動元の
# 環境変数をそのままサンドボックスへ継承するので、`env -i` で一度空にしてから
# 必要なものだけを渡す。シークレットの実値は open のときだけ srt プロセスへ渡し、
# サンドボックス内では srt の credentials.envVars によってセンチネルに置き換わる。
set -euo pipefail

variant="${1:?usage: srt-claude.sh open|close [claude args...]}"
shift
case "$variant" in
  open | close) ;;
  *)
    echo "srt-claude.sh: variant must be open or close: $variant" >&2
    exit 2
    ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
settings="$here/srt-settings.$variant.json"

# srt を入れていないホストでは SRT に npx 経由の起動を指定できる。
#   SRT="npx -y @anthropic-ai/sandbox-runtime@0.0.76" srt-claude.sh open
read -r -a srt_cmd <<<"${SRT:-srt}"

# シェルの引数を 1 つの文字列に畳む。srt は `-c` の文字列を bash -c で実行する。
claude_cmd="claude --dangerously-skip-permissions"
for arg in "$@"; do
  claude_cmd+=" $(printf '%q' "$arg")"
done

env_args=(
  HOME="$HOME"
  USER="${USER:-$(id -un)}"
  LOGNAME="${USER:-$(id -un)}"
  SHELL=/bin/bash
  PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.nix-profile/bin:$HOME/.local/share/pnpm"
  TZ=Asia/Tokyo
  LANG=en_US.UTF-8
  TERM="${TERM:-xterm-256color}"
  CLAUDE_CODE_TMPDIR="$PWD/.local"
  # nas は ~/.gradle.for-agents を ~/.gradle に見せる。srt にパスの付け替えは無いので
  # Gradle 側に場所を教える。
  GRADLE_USER_HOME="$HOME/.gradle.for-agents"
  # プロキシ設定は srt が JAVA_TOOL_OPTIONS の javaagent で注入するので書かない。
  GRADLE_OPTS="-Dfile.encoding=UTF-8"
  ANT_OPTS="-Dfile.encoding=UTF-8"
)

if [[ "$variant" == "open" ]]; then
  # gpg-agent の socket を見つけるために必要 (allowAllUnixSockets = true のとき有効)。
  env_args+=(XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}")
  # global.pkl の secrets。srt 内では credentials.envVars の mask によりセンチネルになる。
  env_args+=(
    GITHUB_TOKEN="$(gh auth token)"
    REDMINE_API_KEY="$(pass asahi-net/redmine-api-key)"
  )
fi

exec env -i "${env_args[@]}" "${srt_cmd[@]}" --settings "$settings" -c "$claude_cmd"
