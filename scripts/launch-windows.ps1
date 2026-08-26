$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:DSH_HOME = $repoRoot
$url = 'http://127.0.0.1:3080'
$uri = [Uri]$url
$probeHost = $uri.Host
$probePort = $uri.Port

# Stage 1 - raw TCP connect: immune to system-proxy state. A proxy client
# that is not ready yet made an HTTP-only probe fail, which then spawned a
# second dsh web that crashed with EADDRINUSE while the first held the port.
function Test-DshPort {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.ConnectAsync($probeHost, $probePort)
    if (-not $connect.Wait(800)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

# Stage 2 - HTTP readiness with an explicit null proxy: localhost traffic
# must never ride a system proxy regardless of machine configuration.
function Test-DshHttp {
  try {
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Proxy = $null
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $response = $request.GetResponse()
    $code = [int]$response.StatusCode
    $response.Close()
    return $code -ge 200 -and $code -lt 500
  } catch {
    return $false
  }
}

if (Test-DshHttp) {
  Start-Process $url
  exit 0
}

# Single-instance guard: when something already holds the port, spawning a
# second dsh web dies with EADDRINUSE and leaves nothing serving.
if (Test-DshPort) {
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if (Test-DshHttp) {
      Start-Process $url
      exit 0
    }
  }
  throw "port $probePort is already held but never became ready at $url - a stale dsh web process may need to be ended first"
}

$command = Get-Command dsh -ErrorAction Stop

# Rotate previous logs instead of truncating them, so a failed boot attempt
# keeps its evidence for diagnosis.
$stdoutLog = Join-Path $repoRoot 'dsh-web.out.log'
$stderrLog = Join-Path $repoRoot 'dsh-web.err.log'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
foreach ($log in @($stdoutLog, $stderrLog)) {
  if (Test-Path -LiteralPath $log) {
    Move-Item -LiteralPath $log -Destination "$log.$stamp.bak" -Force
  }
}

# Keep the portable home discoverable for every future non-script launch
# (desktop icons, terminals, plugin-generated launchers): persist it at User
# scope so bare `dsh web` never falls back to the legacy default home.
if ([Environment]::GetEnvironmentVariable('DSH_HOME', 'User') -ne $repoRoot) {
  [Environment]::SetEnvironmentVariable('DSH_HOME', $repoRoot, 'User')
}

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

# Boot-friendly readiness window: cold starts after login routinely exceed
# one minute (empty disk cache, antivirus scans, proxy clients starting).
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not (Test-DshHttp)) {
  Start-Sleep -Milliseconds 300
}

if (-not (Test-DshHttp)) {
  $detail = ''
  if (Test-Path -LiteralPath $stderrLog) {
    $detail = (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine
  }
  throw "DSH Web did not become ready at $url`n$detail"
}

Start-Process $url
