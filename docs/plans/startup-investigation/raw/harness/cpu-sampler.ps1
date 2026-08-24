#Requires -Version 7
# STARTUP-AUTOPSY: background CPU sampler for trial runs (metrics-harness, lane 5).
# Writes elapsed_ms,cpu_pct rows until killed by the parent harness.
param(
  [Parameter(Mandatory)][string]$CsvPath,
  [int]$IntervalMs = 400
)
"elapsed_ms,cpu_pct" | Set-Content -LiteralPath $CsvPath -Encoding utf8NoBOM
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $vals = (Get-CimInstance Win32_Processor -Property LoadPercentage).LoadPercentage
  $pct = if ($vals -is [array]) { $vals[0] } else { $vals }
  "{0},{1}" -f $sw.ElapsedMilliseconds, $pct | Add-Content -LiteralPath $CsvPath -Encoding utf8NoBOM
  Start-Sleep -Milliseconds $IntervalMs
}
