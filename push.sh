#!/usr/bin/env bash
# Push current branch using MANSOOR_PAT from .env. Token never stored in git config.
set -euo pipefail
cd "$(dirname "$0")"

PAT=$(grep -E '^MANSOOR_PAT=' .env | cut -d= -f2- | tr -d "\"' \r")
[ -n "$PAT" ] || { echo "MANSOOR_PAT missing in .env" >&2; exit 1; }

# base64 | tr -d '\n' is the portable equivalent of GNU's base64 -w0 (macOS BSD base64 has no -w).
AUTH=$(printf 'x-access-token:%s' "$PAT" | base64 | tr -d '\n')
git -c credential.helper= -c http.extraHeader="Authorization: Basic $AUTH" \
  push origin "$(git branch --show-current)" "$@"
