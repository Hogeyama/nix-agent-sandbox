#!/usr/bin/env bash
# Exercise the recipient's install and replacement route for bundled strait
# on this architecture.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'usage: check_strait_bundle.sh BUNDLED_STRAIT REPORT' >&2
  exit 2
fi
binary=$(realpath "$1")
report=$(realpath -m "$2")
[ ! -e "$report" ] || { echo 'report already exists' >&2; exit 2; }
work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -r -- "$work"' EXIT
mkdir "$work/runtime-tmp"
TMPDIR="$work/runtime-tmp" "$binary" --version > "$work/version.out" 2> "$work/version.err"
grep -q '^strait ' "$work/version.out" || { echo 'bundle did not reach the strait entrypoint' >&2; exit 1; }
if [ -n "$(ls -A "$work/runtime-tmp")" ]; then
  cat "$work/version.err" >&2
  echo 'bundle left its temporary extraction behind after normal execution' >&2
  exit 1
fi
# Unextracted, everything but --version is refused: the sandbox cannot read
# a copy under /tmp, so `strait hostexec` and the status line would break.
if TMPDIR="$work/runtime-tmp" "$binary" review --json > /dev/null 2> "$work/refusal.err"; then
  echo 'bundle ran a session command without being extracted' >&2
  exit 1
fi
grep -q 'extract' "$work/refusal.err"
"$binary" --extract "$work/extracted" > "$work/extract.log" 2>&1
root="$work/extracted"
{
  printf 'Bundle: '
  sha256sum "$binary"
  printf 'Architecture: '
  uname -m
  echo 'Normal execution reached strait and removed its temporary payload'
  echo 'Unextracted session commands are refused'
  "$root/bin/strait" --version
  # CI has Nix, so a store path left in a shebang would still run here and
  # fail only on the recipient's host.
  if grep -rlI '^#!/nix/store/' "$root" | xargs -r head -qn1 | grep '^#!/nix/store/'; then
    echo 'a script in the bundle names an interpreter in /nix/store' >&2
    exit 1
  fi
  echo 'No shebang points into /nix/store'
  test -s "$root/licenses/README.txt"
  echo 'Notices are present after extraction'
  library="$root/lib-bun/libc.so.6"
  test -f "$library" || { echo "missing bundled library: $library" >&2; exit 1; }
  before=$(sha256sum "$library")
  chmod u+w "$library"
  # Append a marker outside the ELF load segments. This preserves the ABI;
  # the loader trace below proves the replacement bytes are loaded from the
  # recipient-controlled directory.
  printf '\nSTRAIT_LIBRARY_REPLACEMENT_PROBE\n' >> "$library"
  after=$(sha256sum "$library")
  test "$before" != "$after"
  LD_DEBUG=files "$root/bin/strait" --version > "$work/bun.out" 2> "$work/bun.loader"
  grep -q '^strait ' "$work/bun.out"
  grep -F "calling init: $library" "$work/bun.loader"
  printf 'glibc replacement: %s -> %s\n' "$before" "$after"
  # JSC-2: strait runs Bun as a separate executable, so a modified runtime
  # replaces orig/bun. Stand in for it with an unpatched Bun executable (the
  # one on PATH, which still names its own loader), pointed at the bundled
  # loader as RELEASE-MATERIALS.md describes.
  replacement=$(readlink -f "$(command -v bun)")
  cmp -s "$replacement" "$root/orig/bun" && { echo 'PATH bun is the bundled file' >&2; exit 1; }
  interpreter=$(patchelf --print-interpreter "$root/orig/bun")
  chmod u+w "$root/orig/bun"
  cp "$replacement" "$root/orig/bun.new"
  chmod u+w "$root/orig/bun.new"
  patchelf --set-interpreter "$interpreter" "$root/orig/bun.new"
  mv "$root/orig/bun.new" "$root/orig/bun"
  LD_DEBUG=files "$root/bin/strait" --version > "$work/runtime.out" 2> "$work/runtime.loader"
  grep -q '^strait ' "$work/runtime.out"
  grep -F "calling init: $library" "$work/runtime.loader" > /dev/null
  printf 'Bun runtime replacement: %s ran strait with the bundled loader %s\n' \
    "$(sha256sum < "$root/orig/bun" | cut -d' ' -f1)" "$interpreter"
  seccomp=$(find "$root/node_modules/" -path '*/vendor/seccomp/*/apply-seccomp' -type f)
  test "$(printf '%s\n' "$seccomp" | wc -l)" -eq 1
  readelf -l "$seccomp" > "$work/seccomp.headers"
  if grep -q INTERP "$work/seccomp.headers"; then
    echo 'apply-seccomp must remain a standalone static executable' >&2
    exit 1
  fi
  echo 'apply-seccomp is the static rebuild for this architecture'
  grep -rl 'Modified for strait' "$root/node_modules/" | sed "s|^$root/||" | sort
} > "$work/report"
mkdir -p "$(dirname "$report")"
cp "$work/report" "$report"
echo "strait bundle checks passed; report: $report"
