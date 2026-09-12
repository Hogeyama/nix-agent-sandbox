#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo 'usage: nas-direnv-bootstrap LIBRARY_SOURCE' >&2
  exit 64
fi

source_file=$1
if [[ ! -f $source_file || ! -r $source_file ]]; then
  printf '[nas] Packaged direnv library is not readable: %q\n' "$source_file" >&2
  exit 1
fi

if [[ -n ${DIRENV_CONFIG:-} ]]; then
  config_dir=$DIRENV_CONFIG
elif [[ -n ${XDG_CONFIG_HOME:-} ]]; then
  config_dir=$XDG_CONFIG_HOME/direnv
elif [[ -n ${HOME:-} ]]; then
  config_dir=$HOME/.config/direnv
else
  echo '[nas] Cannot install the direnv library: HOME and direnv config variables are unset.' >&2
  exit 1
fi

library_dir=$config_dir/lib
destination=$library_dir/nas-nix-direnv.sh

if ! mkdir -p -- "$library_dir"; then
  printf '[nas] Cannot create the direnv library directory %q; make the effective direnv config writable.\n' \
    "$library_dir" >&2
  exit 1
fi

if [[ -f $destination ]] && cmp -s -- "$source_file" "$destination"; then
  exit 0
fi
if [[ -e $destination && ! -f $destination ]]; then
  printf '[nas] Cannot install direnv library %q because that path is not a regular file.\n' \
    "$destination" >&2
  exit 1
fi

if ! temporary=$(mktemp "$library_dir/.nas-nix-direnv.XXXXXX"); then
  printf '[nas] Cannot write direnv library %q; make the effective direnv config writable.\n' \
    "$destination" >&2
  exit 1
fi
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT

if ! cp -- "$source_file" "$temporary" ||
  ! chmod 0644 "$temporary" ||
  ! mv -fT -- "$temporary" "$destination"; then
  printf '[nas] Cannot install direnv library %q; make the effective direnv config writable.\n' \
    "$destination" >&2
  exit 1
fi

trap - EXIT
