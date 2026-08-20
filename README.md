# Portable DeepSeek Harness home

This repository is both the maintained DSH configuration repository and the
`DSH_HOME` directory used at runtime. It keeps the web profile, local plugin
sources, agent presets, skins, and wallpaper assets in one portable location.

The original Windows home at `C:\Users\huangqicaho\.dsh` is intentionally left
untouched as a rollback copy.

## Layout

- `profiles/web/`: installed plugin manifest, lockfile, and Cordis patch layer.
- `plugin-src/`: locally developed or locally modified plugin source.
- `.agent-presets/`: reusable agent presets. Names beginning with `wsl-` are
  Windows/WSL-specific.
- `skins/`: user-maintained skins.
- `skin-center/wallpapers/`: copied wallpaper source packages. Generated frame
  cache is excluded.
- `skin-center/uploads/`: uploaded wallpaper images.
- `config/`: platform settings templates without credentials.
- `scripts/`: Windows and Linux bootstrap/launch helpers.

Runtime state and credentials remain in this directory so the current Windows
installation keeps working, but `.gitignore` prevents them from being committed.

## Current toolchain snapshot

- DeepSeek Harness: `0.1.0-rc.7`
- Node.js: `24.15.0`
- pnpm: `11.22.0`

These are recorded in `.dsh-version`. Upgrade DSH deliberately on one machine,
verify the profile, and then commit the resulting manifest/lockfile changes.

## Windows setup

Open PowerShell:

```powershell
Set-Location F:\workspace\dsh-home
.\scripts\bootstrap.ps1
.\scripts\install-windows-shortcut.ps1
.\scripts\launch-windows.ps1
```

`bootstrap.ps1` sets the user-level `DSH_HOME` environment variable and installs
the profile dependencies. Open a new terminal after the first run.

To intentionally refresh dependency resolutions instead of honoring the current
lockfile:

```powershell
.\scripts\bootstrap.ps1 -RefreshLock
```

## Linux setup

Clone this repository to a native Linux filesystem, then run:

```bash
cd ~/dsh-home
chmod +x scripts/*.sh
./scripts/bootstrap.sh
source ~/.profile
./scripts/launch-linux.sh
```

Do not copy `node_modules` between Windows and Linux. Each system installs its
own platform-specific dependencies from the same `pnpm-lock.yaml`. The profile
pins pnpm's content-addressable store to `$DSH_HOME/.pnpm-store`, so both the
installed profile and its package cache remain under this maintained directory.

The copied Wallpaper Engine `.pkg` source is preserved and synced, but actual
dynamic rendering on Linux depends on the skin-center plugin and local graphics
support. The `wsl-*` presets are Windows-only; Linux should use a built-in or
native Linux preset.

## Installing a third-party plugin

With `DSH_HOME` set, all profile changes go to this repository:

```powershell
dsh plugin --profile web add package-name@exact-version
git status
git add profiles/web/package.json profiles/web/pnpm-lock.yaml
git commit -m "Add package-name plugin"
```

Prefer exact package versions. For GitHub dependencies, pin a release tag or
commit instead of an unqualified moving branch.

## Developing a local plugin

Place the plugin under `plugin-src/<plugin-name>`, then reference it from
`profiles/web/package.json` using a portable relative link:

```json
"plugin-name": "link:../../plugin-src/plugin-name"
```

If it is a Cordis bundle, also add its package name to `dsh.profile.bundles` in
the same file. Run the plugin's tests/build, refresh the profile lockfile, and
restart DSH.

The locally modified skin-center is tracked with its current prebuilt `lib/`
output. Its upstream `tsdown.config.ts` still imports a shared build helper from
the original `dsh-web-ui` monorepo, so bootstrap installs its runtime/development
dependencies with lifecycle scripts disabled. Runtime use is verified; a fresh
skin-center rebuild requires first making that shared build configuration
standalone or restoring the upstream monorepo layout.

Never put an inner `.git` directory inside `plugin-src` unless the directory is
intentionally managed as a Git submodule. The copied local plugins were flattened
so their current working files are owned by this repository.

## Wallpapers and Git LFS

Wallpaper assets were copied from the previous DSH home. The generated
`skin-center/wallpapers/.cache` directory was not copied. Wallpaper Engine
`.pkg` files are configured for Git LFS; run `git lfs install` on every machine
before cloning or committing wallpaper changes.

Only publish wallpaper assets when their license permits redistribution. Keep
the repository private if the assets are personal or third-party workshop data.

## Files that must not be committed

The ignore rules protect credentials, local settings, sessions, memories,
storage databases, task-board state, logs, generated Cordis output, caches, and
all `node_modules` directories. Before every push, check:

```powershell
git status
git diff --cached
```

Never force-add `.credentials.yaml`, `settings.yaml`, session data, or API keys.

## Daily synchronization

At the start of work:

```bash
git pull --ff-only
pnpm --dir profiles/web install --frozen-lockfile
```

After adding/updating a plugin or editing local source:

```bash
git status
git add profiles plugin-src .agent-presets skins skin-center README.md
git commit
git push
```

Avoid changing the plugin manifest independently on both systems before pulling;
`package.json` and `pnpm-lock.yaml` conflicts should be resolved on one machine
and reinstalled before pushing.

## Rollback

To temporarily use the old Windows installation:

```powershell
$env:DSH_HOME = 'C:\Users\huangqicaho\.dsh'
dsh web
```

To restore it persistently:

```powershell
[Environment]::SetEnvironmentVariable(
  'DSH_HOME',
  'C:\Users\huangqicaho\.dsh',
  'User'
)
```
