#!/usr/bin/env bash
set -eu

if (( $# != 0 )); then
  echo "usage: ./setup.sh" >&2
  exit 2
fi

demo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
state_dir="$demo_dir/.state"
complete="$state_dir/complete"

if [[ -L "$state_dir" ]]; then
  echo "setup: .state is a symbolic link; remove it and retry" >&2
  exit 1
fi
if [[ -e "$state_dir" ]]; then
  if [[ -d "$state_dir" && -f "$complete" && ! -L "$complete" &&
        -x "$state_dir/bin/sumi" && -f "$state_dir/secrets.txt" &&
        -f "$state_dir/claude/settings.json" && -d "$state_dir/repo/.git" ]]; then
    echo "Demo setup already exists; reusing .state."
    echo "Next: ./start.sh"
    exit 0
  fi
  echo "setup: .state is incomplete or invalid; run 'rm -rf -- .state' from $demo_dir, then retry" >&2
  exit 1
fi

for command_name in git bash cp chmod mkdir printf; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "setup: required command not found: $command_name" >&2
    exit 1
  fi
done

caller_dir=$PWD
if [[ -n ${SUMI_BIN:-} ]]; then
  if [[ $SUMI_BIN = /* ]]; then
    source_bin=$SUMI_BIN
  else
    source_bin="$caller_dir/$SUMI_BIN"
  fi
  if [[ ! -f "$source_bin" || ! -x "$source_bin" ]]; then
    echo "setup: SUMI_BIN must name an existing executable: $source_bin" >&2
    exit 1
  fi
else
  sumi_dir=$(cd -- "$demo_dir/.." && pwd -P)
  source_bin="$sumi_dir/zig-out/bin/sumi"
  if [[ ! -x "$source_bin" ]]; then
    if ! command -v zig >/dev/null 2>&1; then
      echo "setup: sumi is not built and zig was not found" >&2
      echo "Install Zig 0.15.2, or run: SUMI_BIN=/absolute/path/sumi ./setup.sh" >&2
      exit 1
    fi
    (cd -- "$sumi_dir" && zig build)
  fi
  if [[ ! -x "$source_bin" ]]; then
    echo "setup: build did not create an executable at $source_bin; use SUMI_BIN=/absolute/path/sumi" >&2
    exit 1
  fi
fi

bash_path=$(command -v bash)
if [[ $bash_path != /* ]]; then
  echo "setup: could not resolve bash to an absolute path" >&2
  exit 1
fi

if ! mkdir -- "$state_dir"; then
  echo "setup: could not create .state exclusively; remove it and retry" >&2
  exit 1
fi
chmod 700 "$state_dir"
mkdir -- "$state_dir/bin" "$state_dir/claude" "$state_dir/repo" "$state_dir/git-template"
cp -- "$source_bin" "$state_dir/bin/sumi"
chmod 700 "$state_dir/bin/sumi"
printf '%s\n' 'Tr0ub4dor' 'rotated-value-1' >"$state_dir/secrets.txt"
chmod 600 "$state_dir/secrets.txt"

git_clean_env=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_COMMON_DIR)
"${git_clean_env[@]}" git init --quiet --initial-branch=main --template="$state_dir/git-template" "$state_dir/repo"
"${git_clean_env[@]}" git -C "$state_dir/repo" config user.name 'Sumi Demo'
"${git_clean_env[@]}" git -C "$state_dir/repo" config user.email 'sumi-demo@example.invalid'
"${git_clean_env[@]}" git -C "$state_dir/repo" config commit.gpgSign false
"${git_clean_env[@]}" git -C "$state_dir/repo" config tag.gpgSign false
"${git_clean_env[@]}" git -C "$state_dir/repo" config core.hooksPath /dev/null
mkdir -- "$state_dir/repo/config"
printf '%s\n' 'db.host=localhost' 'db.password=Tr0ub4dor' >"$state_dir/repo/config/app.properties"
"${git_clean_env[@]}" git -C "$state_dir/repo" add config/app.properties
"${git_clean_env[@]}" git -C "$state_dir/repo" commit --quiet -m 'chore: add demo configuration'
printf '%s\n' 'db.host=localhost' 'db.password=rotated-value-1' >"$state_dir/repo/config/app.properties"
"${git_clean_env[@]}" git -C "$state_dir/repo" add config/app.properties
"${git_clean_env[@]}" git -C "$state_dir/repo" commit --quiet -m 'chore: rotate demo password'

settings="$state_dir/claude/settings.json"
CLAUDE_CONFIG_DIR="$state_dir/claude" "$state_dir/bin/sumi" init \
  --agent claude \
  --secrets-file "$state_dir/secrets.txt" \
  --settings "$settings" \
  --shell "$bash_path"
printf '%s\n' complete >"$complete"

echo "Demo setup complete."
echo "Next: ./start.sh"
