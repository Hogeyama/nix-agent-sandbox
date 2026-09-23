#!/usr/bin/env bash
# Only conventional ELF files: objcopy must never rewrite Bun SEA appended payloads.
set -euo pipefail
if [ "$#" -ne 4 ]; then
  echo 'usage: mark_elf.sh <dtach|pkl> INPUT OUTPUT YYYY-MM-DD' >&2
  exit 2
fi
component=$1
input=$2
output=$3
modified=$4
case "$component" in dtach|pkl) ;; *) echo 'only dtach and Pkl are supported' >&2; exit 2 ;; esac
if [[ ! "$modified" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo 'a modification date is required' >&2
  exit 2
fi
if [ "$input" = "$output" ] || [ -e "$output" ]; then
  echo 'output must be a new file' >&2
  exit 2
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/changes.txt" <<NOTICE
MODIFIED FOR NAS DISTRIBUTION ($modified)
This $component executable has been changed by the nas packaging process.
Its ELF interpreter and library search paths are adjusted for the nas bundle.
The bundle extractor sets the interpreter to the selected extraction directory.
This .nas.changes section records those changes; upstream notices are retained
in share/nas/assets/licenses, and the corresponding source and build scripts
are available in the source/materials asset of the same nas Release.
NOTICE
objcopy --add-section ".nas.changes=$scratch/changes.txt" \
  --set-section-flags .nas.changes=readonly "$input" "$output"
chmod 755 "$output"
objcopy --dump-section ".nas.changes=$scratch/embedded.txt" "$output"
cmp "$scratch/changes.txt" "$scratch/embedded.txt"
