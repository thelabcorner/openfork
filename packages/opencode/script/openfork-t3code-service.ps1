# User-scoped Windows service watchdog for stock T3 Code.
# Invoke from a logon + recurring Scheduled Task (IgnoreNew instances).
# A verified existing instance is never disrupted.
$ErrorActionPreference = 'Stop'
$port = 47126
$healthURL = "http://127.0.0.1:$port/global/health"
$binary = Join-Path $PSScriptRoot 'openfork-t3code.exe'

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
  throw "OpenFork T3 compatibility executable missing: $binary"
}

try {
  $health = Invoke-RestMethod -Uri $healthURL -TimeoutSec 3
  if ($health.healthy -eq $true -and $health.version -eq '1.15.13') {
    exit 0
  }
} catch {
  # Unreachable or unhealthy: attempt to start without disturbing other owners.
}

& $binary serve --hostname=127.0.0.1 "--port=$port"
exit $LASTEXITCODE