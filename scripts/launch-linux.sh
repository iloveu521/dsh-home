#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export DSH_HOME="$repo_root"
url='http://127.0.0.1:3080'

if ! curl --silent --fail --max-time 2 "$url" >/dev/null 2>&1; then
  nohup dsh web >"$repo_root/dsh-web.log" 2>&1 &
  for _ in $(seq 1 120); do
    curl --silent --fail --max-time 2 "$url" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

curl --silent --fail --max-time 2 "$url" >/dev/null
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 &
else
  printf 'Open %s in your browser.\n' "$url"
fi
