#!/usr/bin/env bash
set -eu

if (( $# != 0 )); then
  echo "usage: ./start.sh" >&2
  exit 2
fi

demo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
state_dir="$demo_dir/.state"

if [[ -L "$state_dir" || ! -d "$state_dir" || ! -f "$state_dir/complete" ||
      -L "$state_dir/complete" || ! -x "$state_dir/bin/sumi" ||
      ! -f "$state_dir/claude/settings.json" || ! -f "$state_dir/secrets.txt" ||
      ! -d "$state_dir/repo/.git" ]]; then
  echo "start: demo state is missing or incomplete; run ./setup.sh first" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "start: Claude Code is required; install 'claude' and ensure it is on PATH" >&2
  exit 1
fi

cd -- "$state_dir/repo"
export CLAUDE_CONFIG_DIR="$state_dir/claude"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR
exec claude \
  --settings "$state_dir/claude/settings.json" \
  --permission-mode default \
  --tools Read,Grep,Bash
