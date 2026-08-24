#Requires -Version 7
<#
STARTUP-AUTOPSY lane 5 (metrics-harness): canonical timing harness for `bun run dev` (packages/desktop).

Usage (from anywhere):
  pwsh -File startup-investigation/raw/harness/run-trial.ps1 -Mode warm [-TrialId w1] [-Notes "..."]
  pwsh -File startup-investigation/raw/harness/run-trial.ps1 -Mode cold [-TrialId c1]

What it does:
  - Launches `bun run dev` in packages/desktop as a child process with ELECTRON_ENABLE_LOGGING=1, NO_COLOR=1.
  - Stamps every stdout/stderr line with monotonic elapsed-ms ([System.Diagnostics.Stopwatch]) into raw/harness/logs/<trialId>.log.
  - Detects markers: predev done, vite ready, electron spawn (new PID poll), window shown ("OpenCode" MainWindowTitle on NEW electron PIDs only).
  - Samples CPU % every 400ms via a background sampler process.
  - COLD mode deletes packages/desktop/node_modules/.vite (vite dep-optimize cache) first. OS file cache is NOT controllable (documented caveat).
  - Hard timeout (-TimeoutSec), then kills the whole spawned tree (taskkill /T + descendant sweep by PID diff — never kills pre-existing processes).
  - Appends one JSONL record to startup-investigation/raw/trials.jsonl.

Exit codes: 0 = window shown; 2 = timed out; 3 = ended without window; 4 = spawn failure.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('cold', 'warm')][string]$Mode,
  [string]$TrialId,
  [int]$TimeoutSec = 300,
  [int]$SettleSec = 8,
  [string]$Notes = '',
  # extra dirs cleared in cold mode (relative to repo root), e.g. 'packages/desktop/out','packages/opencode/dist/node'
  [string[]]$ClearPaths = @()
)

$ErrorActionPreference = 'Continue'
$harnessDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $harnessDir '..\..\..')).Path
$desktopDir = Join-Path $repoRoot 'packages\desktop'
$rawDir = Join-Path $repoRoot 'startup-investigation\raw'
$logDir = Join-Path $harnessDir 'logs'
$cpuDir = Join-Path $harnessDir 'cpu'
$trialsPath = Join-Path $rawDir 'trials.jsonl'
foreach ($d in @($logDir, $cpuDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
if (-not $TrialId) { $TrialId = "$Mode-$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
$logPath = Join-Path $logDir "$TrialId.log"
$cpuCsv = Join-Path $cpuDir "$TrialId-cpu.csv"

function Get-ViteCacheStats([string]$dir) {
  if (-not (Test-Path $dir)) { return @{ present = $false; files = 0; bytes = 0 } }
  $files = @(Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue)
  @{ present = $true; files = $files.Count; bytes = ($files | Measure-Object Length -Sum).Sum }
}

function Get-ProcPids([string[]]$Names) {
  @(Get-Process -Name $Names -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

# ---------- pre-state ----------
$bunExe = (Get-Command bun).Source
$viteCacheDir = Join-Path $desktopDir 'node_modules\.vite'
$viteBefore = Get-ViteCacheStats $viteCacheDir
$baselinePids = @{
  electron = @(Get-ProcPids @('electron'))
  vite     = @(Get-ProcPids @('vite'))
  bun      = @(Get-ProcPids @('bun'))
}
$cpuBefore = (Get-CimInstance Win32_Processor -Property LoadPercentage).LoadPercentage
if ($cpuBefore -is [array]) { $cpuBefore = $cpuBefore[0] }
$powerPlan = ((powercfg /getactivescheme) -join ' ').Trim()
"# trial=$TrialId mode=$Mode startUtc=$((Get-Date).ToUniversalTime().ToString('o')) cmd=`"bun run dev`" cwd=$desktopDir" | Set-Content -LiteralPath $logPath -Encoding utf8NoBOM
"# env: ELECTRON_ENABLE_LOGGING=1 NO_COLOR=1; baselineElectronPids=$($baselinePids.electron -join ',')" | Add-Content -LiteralPath $logPath -Encoding utf8NoBOM
$coldCleared = $false
if ($Mode -eq 'cold') {
  if (Test-Path $viteCacheDir) {
    Remove-Item $viteCacheDir -Recurse -Force -ErrorAction SilentlyContinue
    $coldCleared = (-not (Test-Path $viteCacheDir))
  }
  foreach ($rel in $ClearPaths) {
    $target = Join-Path $repoRoot $rel
    if (Test-Path $target) {
      Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
      $coldCleared = $coldCleared -and (-not (Test-Path $target))
      "# COLD-CLEARED: $target" | Add-Content -LiteralPath $logPath -Encoding utf8NoBOM
    }
  }
}

# ---------- spawn ----------
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $bunExe
$psi.Arguments = 'run dev'
$psi.WorkingDirectory = $desktopDir
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $false
$psi.EnvironmentVariables['ELECTRON_ENABLE_LOGGING'] = '1'
$psi.EnvironmentVariables['NO_COLOR'] = '1'

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = [System.Diagnostics.Process]::Start($psi)
if ($null -eq $proc) { Write-Error "spawn failed"; exit 4 }

# background CPU sampler
$sampler = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-File', (Join-Path $harnessDir 'cpu-sampler.ps1'), '-CsvPath', $cpuCsv) -PassThru -WindowStyle Hidden

# markers: name -> regex ; first matching line records elapsed ms (regexes derived from w1.log actual lines)
$markers = [ordered]@{
  t_predev_done_ms   = '(?i)Copied @opencode-ai/cli'
  t_main_built_ms    = '(?i)main process built successfully'
  t_preload_built_ms = '(?i)preload scripts built successfully'
  t_vite_ready_ms    = '(?i)dev server running for the electron renderer'
  t_dev_url_ms       = '(?i)(localhost|127\.0\.0\.1):\d+'
  t_electron_starting_ms = '(?i)starting electron app'
  t_app_starting_ms  = '(?i)\bapp starting \{'
  t_electron_console_ms = 'INFO:CONSOLE'
}
$markerHits = @{}
$out = $proc.StandardOutput
$err = $proc.StandardError
$outTask = $out.ReadLineAsync()
$errTask = $err.ReadLineAsync()
$newElectronPids = [System.Collections.Generic.HashSet[int]]::new()
$tSpawnMs = $null; $tWindowMs = $null; $timedOut = $false; $streamEnded = $false
$settleDeadline = $null

function Write-Stamped([string]$stream, [string]$line) {
  "{0:D8}ms [{1}] {2}" -f $sw.ElapsedMilliseconds, $stream, $line | Add-Content -LiteralPath $logPath -Encoding utf8NoBOM
}

while ($true) {
  $idx = [System.Threading.Tasks.Task]::WaitAny(@($outTask, $errTask), 50)
  if ($idx -ge 0 -and $idx -le 1) {
    $streamName = if ($idx -eq 0) { 'OUT' } else { 'ERR' }
    $line = if ($idx -eq 0) { $outTask.Result } else { $errTask.Result }
    if ($null -eq $line) { $streamEnded = $true; break }
    Write-Stamped $streamName $line
    foreach ($k in $markers.Keys) {
      if (-not $markerHits.ContainsKey($k) -and $line -match $markers[$k]) { $markerHits[$k] = $sw.ElapsedMilliseconds }
    }
    if ($idx -eq 0) { $outTask = $out.ReadLineAsync() } else { $errTask = $err.ReadLineAsync() }
    continue
  }
  # --- 50ms tick: polls & deadlines ---
  $eps = Get-Process -Name electron -ErrorAction SilentlyContinue
  foreach ($p in $eps) {
    if (-not $baselinePids.electron.Contains($p.Id) -and $newElectronPids.Add($p.Id)) {
      if ($null -eq $tSpawnMs) { $tSpawnMs = $sw.ElapsedMilliseconds }
    }
  }
  if ($null -eq $tWindowMs) {
    $win = $eps | Where-Object { $newElectronPids.Contains($_.Id) -and $_.MainWindowTitle -match '^OpenCode' } | Select-Object -First 1
    if ($win) {
      $tWindowMs = $sw.ElapsedMilliseconds
      "# WINDOW-SHOWN at ${tWindowMs}ms title='$($win.MainWindowTitle)'" | Add-Content -LiteralPath $logPath -Encoding utf8NoBOM
      $settleDeadline = $sw.ElapsedMilliseconds + $SettleSec * 1000
    }
  }
  if ($sw.ElapsedMilliseconds -gt $TimeoutSec * 1000) { $timedOut = $true; break }
  if ($null -ne $settleDeadline -and $sw.ElapsedMilliseconds -ge $settleDeadline) { break }
}

$runDurationMs = $sw.ElapsedMilliseconds
if ($timedOut) { "# TIMEOUT after $($TimeoutSec)s" | Add-Content -LiteralPath $logPath -Encoding utf8NoBOM }

# ---------- teardown: kill only OUR tree ----------
# snapshot descendants BEFORE killing so orphans are covered even if intermediates exit first
$cimProcs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$byParent = @{}
foreach ($c in $cimProcs) { if (-not $byParent.ContainsKey($c.ParentProcessId)) { $byParent[$c.ParentProcessId] = [System.Collections.Generic.List[int]]::new() }; $byParent[$c.ParentProcessId].Add($c.ProcessId) }
$descendants = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Queue]::new(); $queue.Enqueue($proc.Id)
while ($queue.Count -gt 0) {
  $pidCur = $queue.Dequeue()
  if ($byParent.ContainsKey($pidCur)) {
    foreach ($child in $byParent[$pidCur]) { if ($descendants.Add($child)) { $queue.Enqueue($child) } }
  }
}
taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
foreach ($d in $descendants) { Stop-Process -Id $d -Force -ErrorAction SilentlyContinue }
# PID-diff sweep for electron/vite spawned during the trial (covers reparented orphans)
foreach ($name in @('electron', 'vite')) {
  foreach ($p in (Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    if (-not $baselinePids[$name].Contains($p.Id)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}
if (-not $proc.HasExited) { $proc.WaitForExit(5000) | Out-Null }
Start-Sleep -Milliseconds 500
$samplerKill = $sampler; if ($samplerKill -and -not $samplerKill.HasExited) { $samplerKill.Kill() }

# ---------- post-state ----------
$leftovers = @()
foreach ($name in @('electron', 'vite')) {
  foreach ($p in (Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    if (-not $baselinePids[$name].Contains($p.Id)) { $leftovers += "$name/$($p.Id)" }
  }
}
$viteAfter = Get-ViteCacheStats $viteCacheDir
$cpuSamples = @(Import-Csv $cpuCsv -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.cpu_pct })
$cpuAvg = if ($cpuSamples.Count) { [math]::Round(($cpuSamples | Measure-Object -Average).Average, 1) } else { $null }
$cpuMax = if ($cpuSamples.Count) { ($cpuSamples | Measure-Object -Maximum).Maximum } else { $null }

$rec = [ordered]@{
  trialId            = $TrialId
  mode               = $Mode
  startedAtUtc       = (Get-Date).ToUniversalTime().ToString('o')
  host_cpu           = (Get-CimInstance Win32_Processor -Property Name).Name
  powerPlan          = $powerPlan
  t_predev_done_ms   = $markerHits['t_predev_done_ms']
  t_vite_ready       = $markerHits['t_vite_ready_ms']
  t_electron_spawn   = $tSpawnMs
  t_window_shown     = $tWindowMs
  total_ms           = $tWindowMs
  runDurationMs      = $runDurationMs
  cpuLoadPct         = @{ before = $cpuBefore; avg = $cpuAvg; max = $cpuMax }
  viteCache          = @{ before = $viteBefore; after = $viteAfter; clearedForCold = $coldCleared }
  markers            = $markerHits
  timeout            = $timedOut
  streamEnded        = $streamEnded
  leftovers          = $leftovers
  notes              = $Notes
}
$rec | ConvertTo-Json -Compress -Depth 6 | Add-Content -LiteralPath $trialsPath -Encoding utf8NoBOM

Write-Host "== trial $TrialId ($Mode) =="
Write-Host "predev_done=$($markerHits['t_predev_done_ms'])ms vite_ready=$($markerHits['t_vite_ready_ms'])ms electron_spawn=${tSpawnMs}ms window_shown=${tWindowMs}ms total=${tWindowMs}ms"
Write-Host "other_markers: $($markerHits.GetEnumerator().Where({ $_.Key -notmatch 'predev|vite_ready' }).ForEach({ "$($_.Key)=$($_.Value)" }) -join ' ')"
Write-Host "cpu% before=$cpuBefore avg=$cpuAvg max=$cpuMax; leftovers=[$($leftovers -join ',')]; timeout=$timedOut; log=$logPath"
exit $(if ($timedOut) { 2 } elseif ($null -eq $tWindowMs) { 3 } else { 0 })
