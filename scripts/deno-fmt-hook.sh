#!/bin/bash
# Post-tool hook: run deno fmt on modified .ts/.json files
set -e
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.toolName')

# Only run after edit/create tools that may have changed source files
if [ "$TOOL_NAME" = "edit" ] || [ "$TOOL_NAME" = "create" ]; then
  deno fmt --quiet 2>/dev/null || true
fi
