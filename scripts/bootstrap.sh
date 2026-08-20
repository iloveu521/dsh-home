#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
profile_dir="$repo_root/profiles/web"
store_dir="$repo_root/.pnpm-store"
profile_file="$HOME/.profile"
export_line="export DSH_HOME=\"$repo_root\""

export DSH_HOME="$repo_root"

for command_name in node pnpm dsh git; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing command: $command_name" >&2
    exit 1
  }
done

touch "$profile_file"
if ! grep -Fqx "$export_line" "$profile_file"; then
  printf '\n%s\n' "$export_line" >> "$profile_file"
fi

if [[ ! -f "$repo_root/settings.yaml" ]]; then
  cp "$repo_root/config/settings.linux.yaml" "$repo_root/settings.yaml"
fi

pnpm --dir "$profile_dir" --store-dir "$store_dir" install --frozen-lockfile
pnpm --dir "$repo_root/plugin-src/dsh-workdiff" --store-dir "$store_dir" install --frozen-lockfile
pnpm --dir "$repo_root/plugin-src/dsh-client-ui-skin-center" --store-dir "$store_dir" install --frozen-lockfile --ignore-scripts

printf 'DSH_HOME=%s\n' "$repo_root"
echo 'Bootstrap complete. Run: source ~/.profile'
