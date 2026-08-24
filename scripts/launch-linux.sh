#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export DSH_HOME="$repo_root"
url='http://127.0.0.1:3080'
curl_local=(curl --noproxy '*' --silent --fail --max-time 2)

if ! "${curl_local[@]}" "$url" >/dev/null 2>&1; then
  nohup dsh web --no-open >"$repo_root/dsh-web.log" 2>&1 &
  for _ in $(seq 1 120); do
    "${curl_local[@]}" "$url" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

"${curl_local[@]}" "$url" >/dev/null
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 &
else
  printf 'Open %s in your browser.\n' "$url"
fi
