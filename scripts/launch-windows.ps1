$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:DSH_HOME = $repoRoot
$url = 'http://127.0.0.1:3080'

function Test-DshWeb {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

if (-not (Test-DshWeb)) {
  $command = Get-Command dsh -ErrorAction Stop
  $stdoutLog = Join-Path $repoRoot 'dsh-web.out.log'
  $stderrLog = Join-Path $repoRoot 'dsh-web.err.log'
  if ($command.CommandType -eq 'ExternalScript') {
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $command.Source, 'web') `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog
  } else {
    Start-Process -FilePath $command.Source `
      -ArgumentList @('web') `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog
  }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not (Test-DshWeb)) {
    Start-Sleep -Milliseconds 300
  }
}

if (-not (Test-DshWeb)) {
  $detail = ''
  if (Test-Path -LiteralPath $stderrLog) {
    $detail = (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine
  }
  throw "DSH Web did not become ready at $url`n$detail"
}

Start-Process $url
