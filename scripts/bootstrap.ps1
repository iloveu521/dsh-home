[CmdletBinding()]
param(
  [switch]$RefreshLock,
  [switch]$ResetSettings
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$profileDir = Join-Path $repoRoot 'profiles\web'
$storeDir = Join-Path $repoRoot '.pnpm-store'
$settingsTemplate = Join-Path $repoRoot 'config\settings.windows.yaml'
$settingsPath = Join-Path $repoRoot 'settings.yaml'

[Environment]::SetEnvironmentVariable('DSH_HOME', $repoRoot, 'User')
$env:DSH_HOME = $repoRoot

foreach ($commandName in @('node', 'pnpm', 'dsh', 'git')) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "Missing command: $commandName"
  }
}

if ($ResetSettings -or -not (Test-Path -LiteralPath $settingsPath)) {
  Copy-Item -LiteralPath $settingsTemplate -Destination $settingsPath -Force
}

$installArgs = @('--dir', $profileDir, '--store-dir', $storeDir, 'install')
if (-not $RefreshLock) {
  $installArgs += '--frozen-lockfile'
}
& pnpm @installArgs
if ($LASTEXITCODE -ne 0) {
  throw "pnpm install failed with exit code $LASTEXITCODE"
}

$localPlugins = @(
  @{ Path = 'plugin-src\dsh-workdiff'; IgnoreScripts = $false },
  @{ Path = 'plugin-src\dsh-client-ui-skin-center'; IgnoreScripts = $true },
  # Local forks shipping prebuilt lib/ — no build scripts, deps only.
  @{ Path = 'plugin-src\dsh-reef'; IgnoreScripts = $true },
  @{ Path = 'plugin-src\dsh-wsl-workspace'; IgnoreScripts = $true }
)
foreach ($plugin in $localPlugins) {
  $pluginDir = Join-Path $repoRoot $plugin.Path
  $pluginArgs = @('--dir', $pluginDir, '--store-dir', $storeDir, 'install')
  if (-not $RefreshLock) {
    $pluginArgs += '--frozen-lockfile'
  }
  if ($plugin.IgnoreScripts) {
    $pluginArgs += '--ignore-scripts'
  }
  & pnpm @pluginArgs
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install failed for $($plugin.Path): $LASTEXITCODE"
  }
}

Write-Host "DSH_HOME=$repoRoot"
Write-Host 'Bootstrap complete. Open a new terminal before relying on the persistent user environment variable.'
