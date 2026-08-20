$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $repoRoot 'scripts\launch-windows.ps1'
$icon = Join-Path $repoRoot 'assets\dsh.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'DeepSeek-Harness.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$shortcut.WorkingDirectory = $repoRoot
$shortcut.IconLocation = $icon
$shortcut.Description = 'Launch DeepSeek Harness from the portable DSH_HOME'
$shortcut.Save()

Write-Host "Shortcut installed: $shortcutPath"
