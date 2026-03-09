#!/usr/bin/env bash
# osc52-clip.sh — xclip-compatible wrapper using OSC 52 terminal escape sequences.
# Works through Docker, SSH, tmux without needing X11/Wayland access.
#
# Install as /usr/local/bin/xclip (and optionally xsel, wl-copy) to
# transparently intercept clipboard operations from tools like Copilot CLI.
#
# Debug: NAS_CLIP_DEBUG=1 to enable logging to stderr.

set -euo pipefail

NAS_CLIP_DEBUG="${NAS_CLIP_DEBUG:-0}"

debug() {
  if [ "$NAS_CLIP_DEBUG" = "1" ]; then
    echo "[nas-clip] $*" >&2
  fi
}

debug "invoked as: $0 $*"

# --- Parse xclip-compatible arguments ---
SELECTION="clipboard"
MODE="input"
FILTER=false

while [ $# -gt 0 ]; do
  case "$1" in
    -selection|-sel)
      shift
      case "${1:-clipboard}" in
        clipboard|clip|c) SELECTION="clipboard" ;;
        primary|prim|p)   SELECTION="primary" ;;
        secondary|sec|s)  SELECTION="secondary" ;;
        *)                SELECTION="clipboard" ;;
      esac
      ;;
    -i)        MODE="input" ;;
    -o)        MODE="output" ;;
    -f)        FILTER=true ;;
    -d|-display) shift ;; # ignore X display
    -version)
      echo "osc52-clip (nas xclip shim) 1.0"
      exit 0
      ;;
    -h|-help|--help)
      echo "osc52-clip: xclip-compatible wrapper using OSC 52 escape sequences"
      echo "  Supports: -selection clipboard|primary, -i, -o, -f"
      echo "  Debug:    NAS_CLIP_DEBUG=1"
      exit 0
      ;;
    *) ;; # ignore unknown flags (e.g. -quiet, -loops)
  esac
  shift
done

# Map selection name to OSC 52 target character
case "$SELECTION" in
  clipboard)  OSC_TARGET="c" ;;
  primary)    OSC_TARGET="p" ;;
  secondary)  OSC_TARGET="s" ;;
  *)          OSC_TARGET="c" ;;
esac

debug "selection=$SELECTION mode=$MODE filter=$FILTER osc_target=$OSC_TARGET"

# --- Emit OSC 52 sequence with tmux/screen passthrough ---
emit_osc52() {
  local encoded="$1"
  local target="$2"

  if [ -n "${TMUX:-}" ]; then
    debug "tmux detected — using DCS passthrough"
    # tmux: wrap in \ePtmux;\e ... \e\\
    # shellcheck disable=SC1003  # \033\\ is ESC-backslash (ST), not a stray quote
    printf '\033Ptmux;\033\033]52;%s;%s\a\033\\' "$target" "$encoded"
  elif [[ "${TERM:-}" == screen* ]]; then
    debug "screen detected — using DCS passthrough"
    # shellcheck disable=SC1003
    printf '\033P\033]52;%s;%s\a\033\\' "$target" "$encoded"
  else
    debug "direct terminal output"
    printf '\033]52;%s;%s\a' "$target" "$encoded"
  fi
}

# Find a writable TTY for escape sequence output.
# OSC 52 must reach the terminal, not be mixed into stdout.
find_tty() {
  if [ -w /dev/tty ]; then
    echo /dev/tty
  elif [ -t 2 ]; then
    # stderr is a tty — use it
    echo /dev/stderr
  else
    debug "WARNING: no tty found, writing OSC 52 to stdout"
    echo /dev/stdout
  fi
}

if [ "$MODE" = "input" ]; then
  INPUT=$(cat)
  ENCODED=$(printf '%s' "$INPUT" | base64 -w 0)
  debug "input bytes=${#INPUT} base64 bytes=${#ENCODED}"

  if [ "${#ENCODED}" -gt 100000 ]; then
    debug "WARNING: base64 payload >100 KB — some terminals will truncate"
  fi

  TTY=$(find_tty)
  debug "writing OSC 52 to $TTY"
  emit_osc52 "$ENCODED" "$OSC_TARGET" > "$TTY"
  debug "done"

  if [ "$FILTER" = true ]; then
    # -f: also echo the input to stdout (xclip filter mode)
    printf '%s' "$INPUT"
  fi
else
  # Output (paste) mode: OSC 52 read ("?") is rarely supported by terminals.
  debug "output mode — OSC 52 read is not widely supported; returning empty"
  echo ""
fi
