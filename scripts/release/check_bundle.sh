#!/usr/bin/env bash
# Exercise the recipient's extraction/replacement route on this architecture.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'usage: check_bundle.sh BUNDLED_NAS REPORT' >&2
  exit 2
fi
binary=$(realpath "$1")
report=$(realpath -m "$2")
[ ! -e "$report" ] || { echo 'report already exists' >&2; exit 2; }
work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -r -- "$work"' EXIT
mkdir "$work/runtime-tmp"
TMPDIR="$work/runtime-tmp" "$binary" --version > "$work/version.out" 2> "$work/version.err"
grep -q '^nas ' "$work/version.out" || { echo 'bundle runs Bun instead of the nas entrypoint' >&2; exit 1; }
if [ -n "$(ls -A "$work/runtime-tmp")" ]; then
  cat "$work/version.err" >&2
  echo 'bundle left its temporary extraction behind after normal execution' >&2
  exit 1
fi
"$binary" --extract "$work/extracted" > "$work/extract.log" 2>&1
root="$work/extracted"
{
  printf 'Bundle: '
  sha256sum "$binary"
  printf 'Architecture: '
  uname -m
  echo 'Normal execution reached nas and removed its temporary payload'
  for component in nas pkl dtach nas-maskfs; do
    libraries=("$root/lib-$component/libc.so.6")
    if [ "$component" = nas-maskfs ]; then
      libraries+=("$root/lib-$component/libfuse3.so.4")
    fi
    for library in "${libraries[@]}"; do
    test -f "$library" || { echo "missing bundled library: $library" >&2; exit 1; }
    before=$(sha256sum "$library")
    chmod u+w "$library"
    # Append a marker outside the ELF load segments. This preserves the ABI;
    # the loader trace below proves the replacement bytes are loaded from the
    # recipient-controlled directory, without rebuilding the executable.
    printf '\nNAS_LIBRARY_REPLACEMENT_PROBE\n' >> "$library"
    after=$(sha256sum "$library")
    test "$before" != "$after"
    if [ "$component" = nas ]; then
      LD_DEBUG=files "$root/bin/nas" --version > "$work/$component.out" 2> "$work/$component.loader"
      grep -q '^nas ' "$work/$component.out" || { echo 'bundle runs Bun instead of the nas entrypoint' >&2; exit 1; }
    elif [ "$component" = pkl ]; then
      LD_DEBUG=files "$root/libexec/pkl" --version > "$work/$component.out" 2> "$work/$component.loader"
    elif [ "$component" = nas-maskfs ]; then
      LD_DEBUG=files "$root/share/nas/assets/maskfs/nas-maskfs" --version > "$work/$component.out" 2> "$work/$component.loader"
      grep -q '^nas-maskfs ' "$work/$component.out"
    else
      LD_DEBUG=files "$root/libexec/dtach" --help > "$work/$component.out" 2> "$work/$component.loader"
      grep -qi 'usage:' "$work/$component.loader" "$work/$component.out"
    fi
    grep -F "calling init: $library" "$work/$component.loader"
    printf '%s replacement: %s -> %s\n' "$component" "$before" "$after"
    cat "$work/$component.out"
    done
  done
  filter="$root/share/nas/assets/mask-filter/nas-mask-filter"
  readelf -l "$filter" > "$work/filter.headers"
  if grep -q INTERP "$work/filter.headers"; then
    echo 'mask-filter must remain a standalone static executable' >&2
    exit 1
  fi
  printf '\001\000\000\000\006\000\000\000secret' > "$work/secrets.bin"
  printf 'before secret after\n' | NAS_MASK_SECRETS_FILE="$work/secrets.bin" "$filter" > "$work/filter.out"
  printf 'before ****** after\n' > "$work/filter.expected"
  cmp "$work/filter.expected" "$work/filter.out"
  echo 'Standalone mask-filter masked the probe input'
  for component in pkl dtach; do
    readelf -p .nas.changes "$root/orig/$component" > "$work/$component.changes"
    grep -F 'MODIFIED FOR NAS DISTRIBUTION' "$work/$component.changes"
  done
} > "$work/report"
mkdir -p "$(dirname "$report")"
cp "$work/report" "$report"
echo "bundle replacement and ELF-notice checks passed; report: $report"
