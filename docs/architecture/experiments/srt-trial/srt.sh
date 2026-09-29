#!/usr/bin/env bash
# Launch Claude Code under srt with srt-settings.json. Run on the host.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
here=docs/architecture/experiments/srt-trial
state=.local/srt-state
: "${CLAUDE_OAUTH_TOKEN_CMD:?set to a command that prints the OAuth token, e.g. 'pass claude_code_oauth_token'}"

# denyWrite only covers paths that exist at wrap time, so create the protected ones first.
mkdir -p .local/tmp .claude "$state"
for f in settings.json settings.local.json; do
  [[ -e $state/$f ]] || echo '{}' >"$state/$f"
done

# Skip onboarding: its connectivity check goes to platform.claude.com, which is not allowlisted.
[[ -e $state/.claude.json ]] || echo '{"hasCompletedOnboarding":true}' >"$state/.claude.json"

# Control channel for srt-allow.sh. Kept under /tmp: the sandbox can neither read nor write
# there, so the agent cannot feed itself config lines. Do not move it into the work tree.
ctl=/tmp/srt-trial-$UID
rm -rf "$ctl"; mkdir -m 700 "$ctl"; mkfifo -m 600 "$ctl/control"
cp "$here/srt-settings.json" "$ctl/base.json"; : >"$ctl/extra-domains"
trap 'rm -rf "$ctl"' EXIT
exec 4<>"$ctl/control" # keeps the FIFO open so srt's read end never blocks; closed for srt below

env \
  CLAUDE_CONFIG_DIR="$PWD/$state" \
  CLAUDE_CODE_TMPDIR="$PWD"/.local/tmp \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_OAUTH_TOKEN="$(eval "$CLAUDE_OAUTH_TOKEN_CMD")" \
  srt -s "$ctl/base.json" --control-fd 3 -- \
  claude --allow-dangerously-skip-permissions --permission-mode bypassPermissions \
  3<"$ctl/control" 4>&-
