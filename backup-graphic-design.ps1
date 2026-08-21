$ErrorActionPreference = "Stop"

$source = "E:\Other computers\Windows 11 - 2022\Graphic Design"
$destination = "D:\PC Backup Restore\Graphic Design Backup 8-17-26"
$sourceLog = "D:\PC Backup Restore\graphic-design-source.log"
$mergeLog = "D:\PC Backup Restore\graphic-design-consolidation.log"

robocopy.exe $source $destination /E /Z /J /MT:16 /XO /COPY:DAT /DCOPY:DAT /R:3 /W:5 /XJ /NP /LOG:$sourceLog
if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }

foreach ($old in @(
  "D:\PC Backup Restore\Graphic Design Backup - 11-4-22",
  "D:\PC Backup Restore\Graphic Design Backup 12-1-2023",
  "D:\PC Backup Restore\Graphic Design Backup 3-14-2024",
  "D:\PC Backup Restore\Graphic Design Backup 12-7-2025"
)) {
  robocopy.exe $old $destination /E /Z /J /MT:16 /XO /COPY:DAT /DCOPY:DAT /R:3 /W:5 /XJ /NP /LOG+:$mergeLog
  if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }
}
